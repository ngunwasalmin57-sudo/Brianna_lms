import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export class SnippeError extends Error {
  constructor(message: string, public httpStatus?: number) { super(message); this.name = "SnippeError"; }
}

export type SnippeRequest = (path: string, init?: RequestInit) => Promise<any>;

export async function snippeRequest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.snippeEnabled) throw new SnippeError("Snippe is not configured.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.snippeApiKey}`);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try { response = await fetch(`${config.snippeBaseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) }); }
  catch { throw new SnippeError("Could not reach Snippe."); }
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok || body?.status === "error") throw new SnippeError(body?.message ?? body?.error?.message ?? `Snippe request failed (${response.status}).`, response.status);
  return body as T;
}

export function verifySnippeWebhook(payload: Record<string, unknown> | Buffer, headers: Headers | Record<string, string | string[] | undefined> | string, rawBody?: Buffer | string): boolean {
  if (!config.snippeWebhookSecret || !rawBody) return false;
  const legacy = Buffer.isBuffer(payload);
  const get = (name: string) => legacy ? (name === "x-webhook-timestamp" ? String(headers) : String(rawBody)) : headers instanceof Headers ? headers.get(name) : String((headers as Record<string, string | string[] | undefined>)[name.toLowerCase()] ?? "");
  const timestamp = get("x-webhook-timestamp");
  const signature = get("x-webhook-signature");
  if (!timestamp || !signature || !/^\d{10,13}$/.test(timestamp)) return false;
  const time = Number(timestamp.length === 13 ? timestamp : `${timestamp}000`);
  if (Math.abs(Date.now() - time) > 5 * 60 * 1000) return false;
  const bodyBytes = legacy ? payload as Buffer : Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(JSON.stringify(payload));
  const expected = createHmac("sha256", config.snippeWebhookSecret).update(`${timestamp}.${bodyBytes.toString("utf8")}`).digest("hex");
  const clean = signature.replace(/^sha256=/i, "");
  if (!/^[a-f\d]{64}$/i.test(clean)) return false;
  const a = Buffer.from(expected, "hex"), b = Buffer.from(clean, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
