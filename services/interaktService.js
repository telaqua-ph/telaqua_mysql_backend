/**
 * services/interaktService.js
 *
 * Send order invoice via Interakt WhatsApp template API.
 * INTERAKT_API_KEY must remain server-side only.
 */

const INTERAKT_API_URL = "https://api.interakt.ai/v1/public/message/";
const TEMPLATE_NAME = "telaqua_order_invoice";
const TEMPLATE_LANGUAGE = "en";
const REQUEST_TIMEOUT_MS = 30000;
let lastInteraktResult = null;

export function getInteraktConfigurationStatus() {
  return {
    apiKeyLoaded: Boolean(String(process.env.INTERAKT_API_KEY || "").trim()),
    endpoint: INTERAKT_API_URL,
    lastResult: lastInteraktResult,
  };
}

function safeInteraktError(status, data) {
  return {
    httpStatus: status,
    message: String(data?.message || data?.error || data?.detail || "Unknown Interakt error")
      .slice(0, 500),
    code: data?.code || data?.errorCode || data?.error_code || null,
    result: data?.result ?? data?.success ?? null,
  };
}

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

/**
 * @param {object} params
 * @param {string} params.countryCode - e.g. "+91"
 * @param {string} params.phoneNumber - 10-digit local number
 * @param {string} params.customerName
 * @param {string} params.orderId - order number or id label
 * @param {string|number} params.amount - amount paid (template body)
 * @param {string} params.pdfUrl - public HTTPS invoice URL
 * @param {string} params.fileName - e.g. INV-2026-000123.pdf
 */
export async function sendInteraktTemplate({
  countryCode,
  phoneNumber,
  template,
  callbackData,
}) {
  const apiKey = (process.env.INTERAKT_API_KEY || "").trim();
  if (!apiKey) {
    lastInteraktResult = {
      ok: false,
      httpStatus: null,
      message: "INTERAKT_API_KEY is not configured",
      code: "INTERAKT_CONFIG_ERROR",
      at: new Date().toISOString(),
    };
    throw new Error("INTERAKT_API_KEY is not configured");
  }

  const payload = {
    countryCode,
    phoneNumber,
    ...(callbackData ? { callbackData } : {}),
    type: "Template",
    template,
  };

  console.log("Interakt request started:", {
    template: template?.name || "unknown",
    phone: maskPhone(phoneNumber),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(INTERAKT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    console.log("Interakt response received:", {
      status: response.status,
      ok: response.ok,
      ...(response.ok && data?.success !== false && data?.result !== false
        ? {}
        : { error: safeInteraktError(response.status, data) }),
    });

    if (!response.ok || data?.success === false || data?.result === false) {
      lastInteraktResult = {
        ok: false,
        ...safeInteraktError(response.status, data),
        at: new Date().toISOString(),
      };
      const safeMessage =
        data?.message ||
        data?.error ||
        data?.detail ||
        `Interakt API error (${response.status})`;
      const err = new Error(safeMessage);
      err.statusCode = response.ok ? 502 : response.status;
      err.interaktResponse = data;
      err.safeInteraktError = safeInteraktError(response.status, data);
      throw err;
    }

    const messageId =
      data?.id ||
      data?.messageId ||
      data?.message_id ||
      data?.data?.id ||
      data?.data?.messageId ||
      null;

    console.log("WhatsApp sent successfully:", {
      phone: maskPhone(phoneNumber),
      messageId: messageId ? String(messageId).slice(0, 12) + "…" : null,
    });

    lastInteraktResult = {
      ok: true,
      httpStatus: response.status,
      messageIdPresent: Boolean(messageId),
      at: new Date().toISOString(),
    };

    return {
      success: true,
      messageId,
      response: data,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      lastInteraktResult = {
        ok: false,
        httpStatus: null,
        message: "Interakt API request timed out",
        code: "INTERAKT_TIMEOUT",
        at: new Date().toISOString(),
      };
      const err = new Error("Interakt API request timed out");
      err.code = "INTERAKT_TIMEOUT";
      throw err;
    }
    if (!lastInteraktResult || lastInteraktResult.ok) {
      lastInteraktResult = {
        ok: false,
        httpStatus: null,
        message: String(error?.message || "Interakt request failed").slice(0, 500),
        code: error?.code || "INTERAKT_REQUEST_ERROR",
        at: new Date().toISOString(),
      };
    }
    console.error("WhatsApp failed:", error?.message || error);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendOrderInvoiceWhatsApp({
  countryCode,
  phoneNumber,
  customerName,
  orderId,
  amount,
  pdfUrl,
  fileName,
}) {
  const amountStr = String(
    typeof amount === "number" && Number.isFinite(amount)
      ? Math.round(amount)
      : amount ?? ""
  );
  return sendInteraktTemplate({
    countryCode,
    phoneNumber,
    callbackData: `invoice:${String(orderId || "")}`,
    template: {
      name: TEMPLATE_NAME,
      languageCode: TEMPLATE_LANGUAGE,
      headerValues: [pdfUrl],
      fileName,
      bodyValues: [
        String(customerName || "Customer"),
        String(orderId || ""),
        amountStr,
      ],
    },
  });
}
