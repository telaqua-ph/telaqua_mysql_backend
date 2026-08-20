import { sendInteraktTemplate } from "./interaktService.js";

function otpTemplateConfiguration() {
  const preferredName = String(
    process.env.INTERAKT_AUTH_TEMPLATE_NAME || ""
  ).trim();
  const legacyName = String(
    process.env.INTERAKT_OTP_TEMPLATE_NAME || ""
  ).trim();
  const preferredLanguage = String(
    process.env.INTERAKT_AUTH_TEMPLATE_LANGUAGE || ""
  ).trim();
  const legacyLanguage = String(
    process.env.INTERAKT_OTP_LANGUAGE_CODE || ""
  ).trim();
  return {
    templateName: preferredName || legacyName,
    languageCode: preferredLanguage || legacyLanguage || "en",
    configurationSource: preferredName ? "INTERAKT_AUTH_TEMPLATE_NAME" :
      legacyName ? "INTERAKT_OTP_TEMPLATE_NAME" : null,
  };
}

export function getInteraktOtpConfigurationStatus() {
  const configuration = otpTemplateConfiguration();
  return {
    templateConfigured: Boolean(configuration.templateName),
    templateName: configuration.templateName || null,
    languageCode: configuration.languageCode,
    configurationSource: configuration.configurationSource,
  };
}

export async function sendOtp(phone, otp) {
  const { templateName, languageCode } = otpTemplateConfiguration();
  if (!templateName) {
    throw new Error("Interakt authentication template is not configured");
  }

  // Interakt authentication templates require the same code in the body and
  // copy-code button. The OTP is intentionally never logged by this service.
  return sendInteraktTemplate({
    countryCode: "+91",
    phoneNumber: phone,
    callbackData: "website_otp_login",
    template: {
      name: templateName,
      languageCode,
      bodyValues: [otp],
      buttonValues: { "0": [otp] },
    },
  });
}
