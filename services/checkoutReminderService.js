/**
 * Checkout reminder orchestration.
 * One WhatsApp per Razorpay order that is Pending (abandoned) or Failed,
 * and one WhatsApp per open COD lead (checkout filled, order not placed).
 * Does not change Razorpay paid/verify/webhook signature behaviour.
 */

import { query } from "../config/db.js";
import { columnExists } from "../lib/schemaHelpers.js";
import { isDuplicateKeyError, isMissingTableError } from "../lib/dbErrors.js";
import { isCodOrder } from "./paymentMode.js";
import { listUnpaidCodCheckouts } from "./codAdvanceService.js";
import { sendCheckoutReminder } from "./interaktCheckoutReminderService.js";

const DEFAULT_DELAY_MINUTES = 30;
const WORKER_INTERVAL_MS = 5 * 60 * 1000;
const BLOCKED_ORDER_STATUSES = new Set([
  "cancelled",
  "delivered",
  "completed",
]);

let tableReady = false;
let leadTableReady = false;
let timer = null;
let running = false;

export function reminderDelayMinutes() {
  const n = Number(process.env.CHECKOUT_REMINDER_DELAY_MINUTES);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DELAY_MINUTES;
  return Math.min(Math.floor(n), 24 * 60);
}

function remindersEnabled() {
  const flag = String(process.env.CHECKOUT_REMINDER_ENABLED || "true").toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return false;
  return true;
}

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

export function isPaidOrTerminalOrder(order) {
  const pay = String(order?.payment_status || "").trim().toLowerCase();
  if (pay === "paid" || pay === "refunded") return true;
  const status = String(order?.order_status || "").trim().toLowerCase();
  return BLOCKED_ORDER_STATUSES.has(status);
}

export function isEligibleOnlineCheckoutOrder(order) {
  if (!order) return false;
  if (isCodOrder(order)) return false;
  if (Number(order.is_test_order) === 1) return false;
  if (isPaidOrTerminalOrder(order)) return false;
  return true;
}

export async function ensureCheckoutRemindersTable() {
  if (tableReady) return;
  const exists = await columnExists("checkout_reminders", "order_id").catch(() => false);
  if (exists) {
    tableReady = true;
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS checkout_reminders (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      order_id INT NOT NULL,
      customer_phone VARCHAR(20) NOT NULL,
      reminder_reason VARCHAR(32) NOT NULL,
      reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
      reminder_sent_at DATETIME NULL,
      send_status VARCHAR(32) NULL,
      interakt_message_id VARCHAR(128) NULL,
      interakt_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_checkout_reminders_order (order_id),
      KEY idx_checkout_reminders_reason (reminder_reason, reminder_sent)
    )
  `);
  tableReady = true;
}

async function loadOrderById(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await query(`SELECT * FROM orders WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function claimReminderSlot(order, reason) {
  const phone = String(order.phone || "").replace(/\D/g, "").slice(-10);
  try {
    await query(
      `INSERT INTO checkout_reminders (
         order_id, customer_phone, reminder_reason, reminder_sent, send_status
       ) VALUES (?, ?, ?, 0, 'sending')`,
      [order.id, phone || String(order.phone || "").slice(0, 20), reason]
    );
    return { claimed: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { claimed: false, reason: "already_claimed" };
    }
    throw error;
  }
}

async function markReminderResult(orderId, patch) {
  await query(
    `UPDATE checkout_reminders
     SET reminder_sent = ?,
         reminder_sent_at = ?,
         send_status = ?,
         interakt_message_id = ?,
         interakt_error = ?
     WHERE order_id = ?`,
    [
      patch.reminder_sent ? 1 : 0,
      patch.reminder_sent_at,
      patch.send_status,
      patch.interakt_message_id,
      patch.interakt_error,
      orderId,
    ]
  );
}

export async function processCheckoutReminder(orderLike, reason) {
  if (!remindersEnabled()) {
    return { status: "disabled" };
  }
  if (reason !== "payment_failed" && reason !== "checkout_abandoned") {
    return { status: "invalid_reason" };
  }

  await ensureCheckoutRemindersTable();

  const latest = await loadOrderById(orderLike?.id);
  if (!latest) return { status: "not_found" };
  if (!isEligibleOnlineCheckoutOrder(latest)) {
    return { status: "ineligible" };
  }

  if (reason === "payment_failed") {
    if (String(latest.payment_status || "").trim().toLowerCase() !== "failed") {
      return { status: "not_failed" };
    }
  }
  if (reason === "checkout_abandoned") {
    if (String(latest.payment_status || "").trim().toLowerCase() !== "pending") {
      return { status: "not_pending" };
    }
    if (!String(latest.razorpay_order_id || "").trim()) {
      return { status: "not_reached_payment" };
    }
  }

  const claim = await claimReminderSlot(latest, reason);
  if (!claim.claimed) {
    return { status: "already_sent" };
  }

  const afterClaim = await loadOrderById(latest.id);
  if (!afterClaim || isPaidOrTerminalOrder(afterClaim) || !isEligibleOnlineCheckoutOrder(afterClaim)) {
    await markReminderResult(latest.id, {
      reminder_sent: false,
      reminder_sent_at: null,
      send_status: "cancelled_paid",
      interakt_message_id: null,
      interakt_error: null,
    });
    return { status: "aborted_paid" };
  }

  try {
    const sent = await sendCheckoutReminder({
      customerName: afterClaim.customer_name,
      phone: afterClaim.phone,
      orderId: afterClaim.order_number || afterClaim.id,
      reason,
    });
    await markReminderResult(latest.id, {
      reminder_sent: true,
      reminder_sent_at: new Date(),
      send_status: "sent",
      interakt_message_id: sent.messageId ? String(sent.messageId).slice(0, 128) : null,
      interakt_error: null,
    });
    console.log("Checkout reminder sent:", {
      orderId: latest.id,
      orderNumber: afterClaim.order_number || null,
      reason,
      phone: maskPhone(afterClaim.phone),
    });
    return { status: "sent" };
  } catch (error) {
    const safe = String(error?.message || "Interakt send failed").slice(0, 500);
    await markReminderResult(latest.id, {
      reminder_sent: false,
      reminder_sent_at: null,
      send_status: "failed",
      interakt_message_id: null,
      interakt_error: safe,
    }).catch(() => {});
    console.error("Checkout reminder Interakt failed:", {
      orderId: latest.id,
      reason,
      message: safe,
    });
    return { status: "send_failed", error: safe };
  }
}

export function notifyPaymentFailedCheckoutReminder(order) {
  setImmediate(() => {
    processCheckoutReminder(order, "payment_failed").catch((error) => {
      console.error("Checkout reminder payment_failed handler:", error?.message || error);
    });
  });
}

async function findAbandonedOrders() {
  const delay = reminderDelayMinutes();
  const hasTestCol = await columnExists("orders", "is_test_order");
  const hasModeCol = await columnExists("orders", "payment_mode");

  const testClause = hasTestCol ? "AND COALESCE(o.is_test_order, 0) = 0" : "";
  const modeClause = hasModeCol
    ? "AND (o.payment_mode IS NULL OR o.payment_mode = 'razorpay')"
    : "AND LOWER(TRIM(COALESCE(o.payment_method, ''))) NOT IN ('cod', 'cash on delivery', 'cash_on_delivery')";

  const sql = `
    SELECT o.*
    FROM orders o
    LEFT JOIN checkout_reminders r ON r.order_id = o.id
    WHERE r.id IS NULL
      AND o.payment_status = 'Pending'
      AND o.razorpay_order_id IS NOT NULL
      AND o.razorpay_order_id <> ''
      AND o.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
      AND o.order_status NOT IN ('Cancelled', 'Delivered', 'Completed')
      ${testClause}
      ${modeClause}
    ORDER BY o.created_at ASC
    LIMIT 25
  `;
  const { rows } = await query(sql, [delay]);
  return rows;
}

export async function runAbandonedCheckoutReminders() {
  if (!remindersEnabled() || running) return;
  running = true;
  try {
    await ensureCheckoutRemindersTable();
    const rows = await findAbandonedOrders();
    for (const order of rows) {
      try {
        await processCheckoutReminder(order, "checkout_abandoned");
      } catch (error) {
        console.error("Abandoned checkout reminder failed:", {
          orderId: order?.id,
          message: error?.message,
        });
      }
    }
    const leads = await findAbandonedCodLeads();
    for (const lead of leads) {
      try {
        await processCodLeadReminder(lead);
      } catch (error) {
        console.error("COD lead checkout reminder failed:", {
          leadId: lead?.id,
          message: error?.message,
        });
      }
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      tableReady = false;
      leadTableReady = false;
      await ensureCheckoutRemindersTable().catch(() => {});
      await ensureCheckoutLeadRemindersTable().catch(() => {});
      return;
    }
    console.error("Abandoned checkout reminder scan failed:", {
      code: error?.code,
      message: error?.message,
    });
  } finally {
    running = false;
  }
}

/**
 * A Leads-page COD row has a name and a usable Indian mobile.
 * Placed COD orders are not leads.
 */
export function hasCodLeadContact(lead) {
  if (!lead || lead.order_id) return false;
  const status = String(lead.status || "created").trim().toLowerCase();
  if (status !== "created" && status !== "failed") return false;
  if (!String(lead.customer_name || "").trim()) return false;
  const digits = String(lead.phone || "").replace(/\D/g, "");
  const national = digits.length >= 10 ? digits.slice(-10) : "";
  return /^[6-9]\d{9}$/.test(national);
}

/**
 * Details were saved and the customer has been gone for the reminder delay.
 */
export function isEligibleCodLead(lead, now = Date.now()) {
  if (!hasCodLeadContact(lead)) return false;
  const stamp = new Date(lead.updated_at || lead.created_at).getTime();
  if (!Number.isFinite(stamp)) return false;
  return now - stamp >= reminderDelayMinutes() * 60 * 1000;
}

export async function ensureCheckoutLeadRemindersTable() {
  if (leadTableReady) return;
  const exists = await columnExists("checkout_lead_reminders", "cod_advance_id").catch(() => false);
  if (exists) {
    leadTableReady = true;
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS checkout_lead_reminders (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      cod_advance_id INT NOT NULL,
      customer_phone VARCHAR(20) NOT NULL,
      reminder_reason VARCHAR(32) NOT NULL,
      reminder_sent TINYINT(1) NOT NULL DEFAULT 0,
      reminder_sent_at DATETIME NULL,
      send_status VARCHAR(32) NULL,
      interakt_message_id VARCHAR(128) NULL,
      interakt_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_checkout_lead_reminders_attempt (cod_advance_id)
    )
  `);
  leadTableReady = true;
}

async function claimLeadReminderSlot(lead) {
  const phone = String(lead.phone || "").replace(/\D/g, "").slice(-10);
  try {
    await query(
      `INSERT INTO checkout_lead_reminders (
         cod_advance_id, customer_phone, reminder_reason, reminder_sent, send_status
       ) VALUES (?, ?, 'checkout_abandoned', 0, 'sending')`,
      [lead.id, phone || String(lead.phone || "").slice(0, 20)]
    );
    return { claimed: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) return { claimed: false, reason: "already_claimed" };
    throw error;
  }
}

async function markLeadReminderResult(codAdvanceId, patch) {
  await query(
    `UPDATE checkout_lead_reminders
     SET reminder_sent = ?,
         reminder_sent_at = ?,
         send_status = ?,
         interakt_message_id = ?,
         interakt_error = ?
     WHERE cod_advance_id = ?`,
    [
      patch.reminder_sent ? 1 : 0,
      patch.reminder_sent_at,
      patch.send_status,
      patch.interakt_message_id,
      patch.interakt_error,
      codAdvanceId,
    ]
  );
}

async function findAbandonedCodLeads() {
  await ensureCheckoutLeadRemindersTable();
  const leads = (await listUnpaidCodCheckouts({ limit: 500 })).filter(hasCodLeadContact);
  if (!leads.length) return [];
  const ids = leads.map((lead) => Number(lead.id));
  const delay = reminderDelayMinutes();
  const { rows: dueRows } = await query(
    `SELECT id
     FROM cod_advance_payments
     WHERE id IN (${ids.map(() => "?").join(",")})
       AND COALESCE(updated_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [...ids, delay]
  );
  const dueIds = new Set(dueRows.map((row) => Number(row.id)));
  const due = leads.filter((lead) => dueIds.has(Number(lead.id)));
  if (!due.length) return [];
  const dueIdList = due.map((lead) => Number(lead.id));
  const { rows } = await query(
    `SELECT cod_advance_id FROM checkout_lead_reminders WHERE cod_advance_id IN (${dueIdList.map(() => "?").join(",")})`,
    dueIdList
  );
  const claimed = new Set(rows.map((row) => Number(row.cod_advance_id)));
  return due.filter((lead) => !claimed.has(Number(lead.id))).slice(0, 25);
}

async function leadWaitElapsed(leadId) {
  const { rows } = await query(
    `SELECT id
     FROM cod_advance_payments
     WHERE id = ?
       AND COALESCE(updated_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [leadId, reminderDelayMinutes()]
  );
  return rows.length > 0;
}

export async function processCodLeadReminder(lead) {
  if (!remindersEnabled()) return { status: "disabled" };
  if (!hasCodLeadContact(lead)) return { status: "ineligible" };
  if (!(await leadWaitElapsed(lead.id))) return { status: "ineligible" };

  await ensureCheckoutLeadRemindersTable();
  const claim = await claimLeadReminderSlot(lead);
  if (!claim.claimed) return { status: "already_sent" };

  const open = await listUnpaidCodCheckouts({ limit: 500 });
  const current = open.find((row) => Number(row.id) === Number(lead.id));
  if (!current) {
    await markLeadReminderResult(lead.id, {
      reminder_sent: false,
      reminder_sent_at: null,
      send_status: "cancelled_ordered",
      interakt_message_id: null,
      interakt_error: null,
    });
    return { status: "aborted_ordered" };
  }

  try {
    const sent = await sendCheckoutReminder({
      customerName: current.customer_name,
      phone: current.phone,
      orderId: `LEAD-${current.id}`,
      reason: "checkout_abandoned",
    });
    await markLeadReminderResult(lead.id, {
      reminder_sent: true,
      reminder_sent_at: new Date(),
      send_status: "sent",
      interakt_message_id: sent.messageId ? String(sent.messageId).slice(0, 128) : null,
      interakt_error: null,
    });
    console.log("Checkout reminder sent:", {
      leadId: current.id,
      reason: "checkout_abandoned",
      phone: maskPhone(current.phone),
    });
    return { status: "sent" };
  } catch (error) {
    const safe = String(error?.message || "Interakt send failed").slice(0, 500);
    await markLeadReminderResult(lead.id, {
      reminder_sent: false,
      reminder_sent_at: null,
      send_status: "failed",
      interakt_message_id: null,
      interakt_error: safe,
    }).catch(() => {});
    console.error("Checkout reminder Interakt failed:", {
      leadId: lead.id,
      reason: "checkout_abandoned",
      message: safe,
    });
    return { status: "send_failed", error: safe };
  }
}

export function startCheckoutReminderSync() {
  if (!remindersEnabled()) return null;
  if (timer) return timer;
  timer = setInterval(() => {
    runAbandonedCheckoutReminders().catch(() => {});
  }, WORKER_INTERVAL_MS);
  timer.unref();
  setTimeout(() => {
    runAbandonedCheckoutReminders().catch(() => {});
  }, 15_000).unref();
  console.log("Checkout reminder worker started:", {
    delayMinutes: reminderDelayMinutes(),
    intervalMinutes: WORKER_INTERVAL_MS / 60000,
  });
  return timer;
}

export function stopCheckoutReminderSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
