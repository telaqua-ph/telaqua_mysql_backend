/**
 * services/swipeService.js
 *
 * Swipe Document V2 integration for invoice creation and retrieval.
 */

const DEFAULT_SWIPE_BASE_URL = "https://app.getswipe.in/api/partner/v2";
const REQUEST_TIMEOUT_MS = 30000;

function getToken() {
  const token = (process.env.SWIPE_API_KEY || "").trim();
  if (!token) {
    throw new Error("SWIPE_API_KEY is not configured");
  }
  return token;
}

export function getSwipeConfigurationStatus() {
  return {
    apiKeyLoaded: Boolean((process.env.SWIPE_API_KEY || "").trim()),
    baseUrl: (process.env.SWIPE_BASE_URL || DEFAULT_SWIPE_BASE_URL)
      .trim()
      .replace(/\/$/, ""),
  };
}

function maskId(id) {
  const value = String(id || "");
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function requestSwipe(path, options = {}) {
  const token = getToken();
  const baseUrl = (process.env.SWIPE_BASE_URL || DEFAULT_SWIPE_BASE_URL)
    .trim()
    .replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutErr = new Error("Swipe API request timed out");
      timeoutErr.code = "SWIPE_TIMEOUT";
      throw timeoutErr;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSafeSwipeError(status, data) {
  const summary = data?.message || data?.error || data?.error_code ||
    `Swipe API error`;
  const details = data?.errors && Object.keys(data.errors).length
    ? `: ${JSON.stringify(data.errors)}`
    : "";
  return `Swipe ${status}: ${summary}${details}`.slice(0, 1000);
}

function parseJsonMaybe(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * @param {object} order
 * @param {object} payload
 */
export async function createSwipeInvoiceForOrder(order, payload) {
  const config = getSwipeConfigurationStatus();
  console.log("[Invoice] Calling Swipe", {
    orderId: order.id,
    orderNumber: order.order_number,
    endpoint: `${config.baseUrl}/doc`,
    method: "POST",
    apiKeyLoaded: config.apiKeyLoaded,
  });

  // Swipe owns mappings between customer/product details and IDs. If this account
  // already mapped the same details under an older ID, a rejected request tells us
  // which ID to reuse. A rejected 400 creates no document, so these corrections are
  // safe to retry before any hash_id exists.
  const workingPayload = JSON.parse(JSON.stringify(payload));
  let response;
  let data;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    response = await requestSwipe("/doc", {
      method: "POST",
      body: JSON.stringify(workingPayload),
    });
    data = parseJsonMaybe(await response.text());
    if (response.ok && data?.success !== false) break;

    const safeBody = JSON.stringify({
      message: data?.message || data?.error || "",
      errors: data?.errors || null,
    });
    let corrected = false;

    const mappedParty = safeBody.match(
      /customer is already mapped with id\s+([^:\s"']+)/i
    )?.[1];
    if (mappedParty && workingPayload.party?.id !== mappedParty) {
      workingPayload.party.id = mappedParty;
      corrected = true;
      console.warn("[Invoice] Reusing Swipe customer mapping", {
        orderId: order.id,
        partyId: mappedParty,
      });
    }

    const mappedProduct = safeBody.match(
      /product names are already mapped:[\s\S]*?(?:→|->|â†’|\\u2192)\s*([A-Za-z0-9_-]+)/i
    )?.[1];
    if (mappedProduct && workingPayload.items?.[0]?.id !== mappedProduct) {
      workingPayload.items[0].id = mappedProduct;
      corrected = true;
      console.warn("[Invoice] Reusing Swipe product mapping", {
        orderId: order.id,
        productId: mappedProduct,
      });
    }

    if (
      /bank details not found/i.test(safeBody) &&
      Array.isArray(workingPayload.payments)
    ) {
      delete workingPayload.payments;
      workingPayload.notes = [
        workingPayload.notes,
        `Paid via Razorpay: ${order.razorpay_payment_id}`,
      ].filter(Boolean).join("; ");
      corrected = true;
      console.warn("[Invoice] Swipe has no bank details; omitting payment record", {
        orderId: order.id,
      });
    }

    if (!corrected) break;
  }

  console.log("[Invoice] Swipe response received", {
    orderId: order.id,
    httpStatus: response.status,
    ok: response.ok,
    response: response.ok
      ? { success: data?.success, hash_id: data?.data?.hash_id ? "present" : "missing", serial_number: data?.data?.serial_number || null }
      : { message: data?.message, error_code: data?.error_code, errors: data?.errors },
  });

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.safeSwipeResponse = {
      message: data?.message || null,
      error_code: data?.error_code || null,
      errors: data?.errors || null,
    };
    throw err;
  }

  if (!data?.data?.hash_id) {
    throw new Error("Swipe response missing hash_id");
  }

  return data;
}

/**
 * @param {string} hashId
 */
export async function getSwipeInvoiceDetails(hashId) {
  const response = await requestSwipe(`/doc/${encodeURIComponent(hashId)}`, {
    method: "GET",
  });

  const text = await response.text();
  const data = parseJsonMaybe(text);

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.swipeResponse = data;
    throw err;
  }

  return data;
}

/**
 * Update an existing Swipe document without creating a duplicate invoice.
 * @param {object} order
 * @param {string} hashId
 * @param {object} payload
 */
export async function updateSwipeInvoiceForOrder(order, hashId, payload) {
  const config = getSwipeConfigurationStatus();
  console.log("[Invoice] Updating Swipe invoice", {
    orderId: order.id,
    orderNumber: order.order_number,
    endpoint: `${config.baseUrl}/doc/{hash_id}`,
    method: "PUT",
    apiKeyLoaded: config.apiKeyLoaded,
  });

  const response = await requestSwipe(`/doc/${encodeURIComponent(hashId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  const data = parseJsonMaybe(await response.text());

  console.log("[Invoice] Swipe update response received", {
    orderId: order.id,
    httpStatus: response.status,
    ok: response.ok,
    response: response.ok
      ? { success: data?.success }
      : { message: data?.message, error_code: data?.error_code, errors: data?.errors },
  });

  if (!response.ok || data?.success === false) {
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.status;
    err.safeSwipeResponse = {
      message: data?.message || null,
      error_code: data?.error_code || null,
      errors: data?.errors || null,
    };
    throw err;
  }

  return data;
}

/**
 * @param {string} hashId
 */
export async function getSwipeInvoicePdf(hashId) {
  const response = await requestSwipe(`/doc/pdf/${encodeURIComponent(hashId)}`, {
    method: "GET",
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "";
  const isPdf = contentType.toLowerCase().includes("application/pdf") ||
    buffer.subarray(0, 5).toString("ascii") === "%PDF-";

  // Swipe can return HTTP 200 with a JSON { success: false } quota/error body.
  // Never forward that response to the browser under an application/pdf header.
  if (!response.ok || !isPdf) {
    const data = parseJsonMaybe(buffer.toString("utf8"));
    const err = new Error(buildSafeSwipeError(response.status, data));
    err.statusCode = response.ok ? 502 : response.status;
    err.upstreamStatusCode = response.status;
    err.swipeResponse = data;
    throw err;
  }

  return {
    buffer,
    contentType: contentType || "application/pdf",
    fileName: `${maskId(hashId)}.pdf`,
  };
}
