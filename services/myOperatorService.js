/**
 * services/myOperatorService.js
 *
 * Send approved WhatsApp templates via the MyOperator public API.
 * Docs: https://documenter.getpostman.com/view/38426694/2sAXqy3evq (POST /chat/messages)
 * MYOPERATOR_API_KEY must remain server-side only.
 */

const MYOPERATOR_MESSAGES_URL = "https://publicapi.myoperator.co/chat/messages";
const REQUEST_TIMEOUT_MS = 30000;

function maskPhone(phone) {
  const s = String(phone || "");
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}****${s.slice(-2)}`;
}

export function getMyOperatorConfig() {
  return {
    apiKey: String(process.env.MYOPERATOR_API_KEY || "").trim(),
    companyId: String(process.env.MYOPERATOR_COMPANY_ID || "").trim(),
    phoneNumberId: String(process.env.MYOPERATOR_PHONE_NUMBER_ID || "").trim(),
  };
}

export function isMyOperatorConfigured() {
  const { apiKey, companyId, phoneNumberId } = getMyOperatorConfig();
  return Boolean(apiKey && companyId && phoneNumberId);
}

/** Build the /chat/messages request body for a template message. */
export function buildTemplatePayload({
  phoneNumberId,
  countryCode = "91",
  phoneNumber,
  templateName,
  language = "en",
  body,
  buttons,
  refId,
}) {
  const context = {
    template_name: templateName,
    language,
  };
  if (body && Object.keys(body).length) context.body = body;
  if (Array.isArray(buttons) && buttons.length) context.buttons = buttons;

  return {
    phone_number_id: phoneNumberId,
    customer_country_code: String(countryCode).replace(/\D/g, ""),
    customer_number: String(phoneNumber),
    reply_to: null,
    myop_ref_id: refId || null,
    data: {
      type: "template",
      context,
    },
  };
}

/**
 * @returns {Promise<{ success: true, messageId: string|null, response: object }>}
 */
export async function sendMyOperatorTemplate({
  countryCode = "91",
  phoneNumber,
  templateName,
  language = "en",
  body,
  buttons,
  refId,
}) {
  const { apiKey, companyId, phoneNumberId } = getMyOperatorConfig();
  if (!apiKey || !companyId || !phoneNumberId) {
    const err = new Error(
      "MyOperator is not configured (MYOPERATOR_API_KEY, MYOPERATOR_COMPANY_ID, MYOPERATOR_PHONE_NUMBER_ID)"
    );
    err.code = "MYOPERATOR_CONFIG_ERROR";
    throw err;
  }
  if (!templateName) {
    const err = new Error("MyOperator template name is missing");
    err.code = "MYOPERATOR_CONFIG_ERROR";
    throw err;
  }

  const payload = buildTemplatePayload({
    phoneNumberId,
    countryCode,
    phoneNumber,
    templateName,
    language,
    body,
    buttons,
    refId,
  });

  console.log("MyOperator request started:", {
    template: templateName,
    phone: maskPhone(phoneNumber),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(MYOPERATOR_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-MYOP-COMPANY-ID": companyId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: String(text).slice(0, 300) };
    }

    const ok = response.ok && String(data?.status || "").toLowerCase() === "success";
    if (!ok) {
      const message = String(
        data?.message || data?.error || data?.detail || `MyOperator API error (${response.status})`
      ).slice(0, 500);
      console.warn("MyOperator response error:", {
        status: response.status,
        code: data?.code || null,
        message,
      });
      const err = new Error(`MyOperator ${response.status}${data?.code ? ` ${data.code}` : ""}: ${message}`);
      err.statusCode = response.ok ? 502 : response.status;
      err.myOperatorResponse = data;
      throw err;
    }

    const messageId = data?.data?.message_id || data?.data?.id || null;
    console.log("MyOperator WhatsApp sent:", {
      phone: maskPhone(phoneNumber),
      messageIdPresent: Boolean(messageId),
    });
    return { success: true, messageId, response: data };
  } catch (error) {
    if (error?.name === "AbortError") {
      const err = new Error("MyOperator API request timed out");
      err.code = "MYOPERATOR_TIMEOUT";
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
