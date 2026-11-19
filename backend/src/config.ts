import "dotenv/config";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in the .env file`);
  return value;
}

const snippeVariableNames = ["SNIPPE_BASE_URL", "SNIPPE_API_KEY", "SNIPPE_WEBHOOK_SECRET", "SNIPPE_WEBHOOK_URL"] as const;
const snippeValues = snippeVariableNames.map((name) => process.env[name]?.trim() ?? "");
const hasSnippeConfiguration = snippeValues.some(Boolean);
if (hasSnippeConfiguration && snippeValues.some((value) => !value)) {
  const missing = snippeVariableNames.filter((_name, index) => !snippeValues[index]);
  throw new Error(`Snippe integration is partially configured. Set all required variables: ${missing.join(", ")}.`);
}

const smtpHost = process.env.SMTP_HOST?.trim() ?? "";
const smtpUser = process.env.SMTP_USER?.trim() ?? "";
const smtpPassword = process.env.SMTP_PASSWORD ?? "";
const emailFrom = process.env.EMAIL_FROM?.trim() ?? "";
const smtpPort = Number(process.env.SMTP_PORT ?? 587);
const hasSmtpConfiguration = [smtpHost, smtpUser, smtpPassword, emailFrom].some(Boolean);
if (hasSmtpConfiguration && [smtpHost, smtpUser, smtpPassword, emailFrom].some((value) => !value)) {
  throw new Error("Email delivery is partially configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM.");
}
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error("SMTP_PORT must be a valid TCP port.");
if (hasSnippeConfiguration) {
  for (const name of ["SNIPPE_BASE_URL", "SNIPPE_WEBHOOK_URL"] as const) {
    let parsed: URL;
    try { parsed = new URL(process.env[name]!); }
    catch { throw new Error(`${name} must be a valid HTTPS URL.`); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error(`${name} must be an HTTPS URL without embedded credentials or a fragment.`);
    }
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: need("DATABASE_URL"),
  jwtSecret: need("JWT_SECRET"),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? "http://localhost:5173").split(",").map((origin) => origin.trim()).filter(Boolean),
  smtpHost,
  smtpPort,
  smtpSecure: process.env.SMTP_SECURE === "true",
  smtpUser,
  smtpPassword,
  emailFrom,
  emailConfigured: hasSmtpConfiguration,
  devOtp: process.env.DEV_OTP ?? "",
  requireOtp: process.env.REQUIRE_OTP === "true",
  snippeEnabled: hasSnippeConfiguration,
  snippeBaseUrl: process.env.SNIPPE_BASE_URL ?? "",
  snippeApiKey: process.env.SNIPPE_API_KEY ?? "",
  snippeWebhookSecret: process.env.SNIPPE_WEBHOOK_SECRET ?? "",
  snippeWebhookUrl: process.env.SNIPPE_WEBHOOK_URL ?? "",
  // Kept for the dormant AzamPay adapter during the provider transition.
  azampayEnabled: false,
  azampayAppName: "",
  azampayClientId: "",
  azampayClientSecret: "",
  azampayApiKey: "",
  azampaySandbox: true,
  azampayWebhookUrl: "",
  azampayDisbursementBank: "",
  azampaySourceAccount: "",
  azampaySourceName: "",
  beemSmsApiKey: process.env.BEEM_SMS_API_KEY ?? "",
  beemSmsApiSecret: process.env.BEEM_SMS_API_SECRET ?? "",
  beemSmsSenderId: process.env.BEEM_SMS_SENDER_ID ?? "",
};

if (config.jwtSecret.length < 32 || (process.env.NODE_ENV === "production" && /replace|change-me|example|development/i.test(config.jwtSecret))) {
  throw new Error("JWT_SECRET must be a unique random secret of at least 32 characters.");
}
