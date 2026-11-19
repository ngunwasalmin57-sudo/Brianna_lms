import { config } from "./config";

export interface BeemSmsResult {
  requestId: string | null;
  successful: number;
  invalid: number;
  duplicates: number;
}

export async function sendBeemSms(phoneNumbers: string[], message: string): Promise<BeemSmsResult> {
  if (!config.beemSmsApiKey || !config.beemSmsApiSecret || !config.beemSmsSenderId) {
    throw new Error("Beem SMS is not configured. Add the Beem API key, API secret, and approved sender ID to the backend environment.");
  }

  const recipients = phoneNumbers.map((phone, index) => ({
    recipient_id: String(index + 1),
    dest_addr: normalizeTanzanianPhone(phone),
  }));
  const response = await fetch("https://apisms.beem.africa/v1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.beemSmsApiKey}:${config.beemSmsApiSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source_addr: config.beemSmsSenderId, encoding: 0, schedule_time: "", message, recipients }),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || result.successful !== true) {
    throw new Error(typeof result.message === "string" ? result.message : "Beem could not submit the SMS. Check the sender ID and account balance.");
  }

  return {
    requestId: result.request_id == null ? null : String(result.request_id),
    successful: Number(result.valid ?? recipients.length),
    invalid: Number(result.invalid ?? 0),
    duplicates: Number(result.duplicates ?? 0),
  };
}

export function normalizeTanzanianPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("0") ? `255${digits.slice(1)}` : digits.startsWith("255") ? digits : "";
}

