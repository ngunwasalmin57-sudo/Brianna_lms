import { createPublicKey, verify as verifySignature } from "crypto";
import { config } from "./config";

export type AzamPayResult = Record<string, any>;
export class AzamPayError extends Error {
  constructor(message: string, public httpStatus?: number) { super(message); this.name = "AzamPayError"; }
}

const apiBase = () => config.azampaySandbox ? "https://sandbox.azampay.co.tz" : "https://checkout.azampay.co.tz";
const authBase = () => config.azampaySandbox ? "https://authenticator-sandbox.azampay.co.tz" : "https://authenticator.azampay.co.tz";
let cachedToken = "";
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  if (cachedToken && tokenExpiry > Date.now() + 60_000) return cachedToken;
  const response = await fetch(`${authBase()}/AppRegistration/GenerateToken`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ appName: config.azampayAppName, clientId: config.azampayClientId, clientSecret: config.azampayClientSecret }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => { throw new AzamPayError("Could not reach AzamPay authentication."); });
  const body = await response.json().catch(() => ({})) as any;
  const token = body?.data?.accessToken ?? body?.accessToken;
  if (!response.ok || !token) throw new AzamPayError(body?.message ?? "AzamPay authentication failed.", response.status);
  cachedToken = String(token);
  tokenExpiry = Date.now() + Math.max(60, Number(body?.data?.expiresIn ?? 3600)) * 1000;
  return cachedToken;
}

export async function azampayRequest<T extends AzamPayResult = AzamPayResult>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.azampayEnabled) throw new AzamPayError("AzamPay is not configured.");
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-API-KEY", config.azampayApiKey);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
    .catch(() => { throw new AzamPayError("Could not reach AzamPay."); });
  const body = await response.json().catch(() => ({})) as T;
  const bodyFailed = Array.isArray(body) ? body.some((entry) => entry?.success === false) : body?.success === false;
  if (!response.ok || bodyFailed) throw new AzamPayError((Array.isArray(body) ? body.find((entry) => entry?.success === false)?.message : body?.message ?? body?.msg) ?? `AzamPay request failed (${response.status}).`, response.status);
  return body;
}

export async function azampayMnoCheckout(input: { accountNumber: string; amount: number; provider: string; externalId: string }) {
  return azampayRequest("/azampay/mno/checkout", { method: "POST", body: JSON.stringify({
    accountNumber: input.accountNumber, amount: String(input.amount), currency: "TZS", provider: input.provider,
    externalId: input.externalId, additionalProperties: { source: "Brianna LMS" },
  }) });
}

export async function azampayDisburse(input: { amount: number; destination: string; recipientName: string; bankName: string; externalId: string; remarks: string }) {
  if (!config.azampaySourceAccount || !config.azampaySourceName || !config.azampayDisbursementBank) {
    throw new AzamPayError("AzamPay disbursement source details are not configured.");
  }
  return azampayRequest("/azampay/createtransfer", { method: "POST", body: JSON.stringify({
    source: { countryCode: "TZ", fullName: config.azampaySourceName, bankName: config.azampayDisbursementBank, accountNumber: config.azampaySourceAccount, currency: "TZS" },
    destination: { countryCode: "TZ", fullName: input.recipientName, bankName: input.bankName, accountNumber: input.destination, currency: "TZS" },
    transferDetails: { type: "transfer", amount: input.amount, date: new Date().toISOString() },
    externalReferenceId: input.externalId, remarks: input.remarks,
  }) });
}

export async function azampayDisbursementStatus(reference: string, bankName: string) {
  const query = new URLSearchParams({ pgReferenceId: reference, bankName });
  return azampayRequest(`/azampay/gettransactionstatus?${query}`);
}

export async function verifyAzamPayCallback(data: Record<string, any>): Promise<boolean> {
  if (!data.signature || !data.utilityref || !data.externalreference || !data.transactionstatus || !data.operator) return false;
  const keyUrl = `${apiBase()}/azampay/v1/public-key?format=Pem`;
  try {
    const response = await fetch(keyUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const keyBody = await response.json().catch(() => null) as any;
    const pem = typeof keyBody === "string" ? keyBody : keyBody?.publicKey ?? keyBody?.data;
    if (typeof pem !== "string") return false;
    const message = `${data.utilityref}${data.externalreference}${data.transactionstatus}${data.operator}`;
    return verifySignature("RSA-SHA256", Buffer.from(message), createPublicKey(pem), Buffer.from(String(data.signature), "base64"));
  } catch { return false; }
}
