import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_SECRET = "unit-test-secret-that-is-at-least-thirty-two-characters";
process.env.SNIPPE_API_KEY = "unit-test-api-key";
process.env.SNIPPE_WEBHOOK_SECRET = "unit-test-webhook-secret";
process.env.SNIPPE_WEBHOOK_URL = "https://example.test/api/webhooks/snippe";
process.env.SNIPPE_BASE_URL = "https://sandbox.example.test";

const { createSnippeRouter } = await import("../src/routes/snippeRoutes");
const { verifySnippeWebhook, SnippeError } = await import("../src/snippe");

type Result = { rows: any[]; rowCount: number | null };
type Intent = Record<string, any>;
type Payout = Record<string, any>;

class MemoryPool {
  loan: Record<string, any>;
  intents: Intent[] = [];
  payments: Record<string, any>[] = [];
  payouts: Payout[] = [];
  events: Record<string, any>[] = [];
  audits: Record<string, any>[] = [];
  failSql = "";
  failOnce = false;
  private nextIntentId = 1;
  private nextPaymentId = 1;
  private nextPayoutId = 1;
  private nextEventId = 1;

  constructor(mode: "collection" | "payout" = "collection") {
    this.loan = mode === "collection"
      ? { id: 9, client_id: 4, loan_number: "BEL-009", balance: 10000, status: "active", stage: "repayment", amount_due: 10000, principal_amount: 8000, amount_paid: 0, full_name: "Asha Mushi", phone: "255712345678", user_id: 22, payout_reversal_review: false }
      : { id: 9, client_id: 4, loan_number: "BEL-009", balance: 0, status: "in_progress", stage: "disbursement", amount_due: 0, principal_amount: 10000, amount_paid: 0, full_name: "Asha Mushi", phone: "255712345678", user_id: 22, bank_code: null, bank_account_number: null, bank_account_name: null, bank_details_submitted_by: null, bank_details_verified_by: null, bank_details_verified_at: null, payout_reversal_review: false };
  }

  async connect() {
    let snapshot: any;
    return {
      query: async (sql: string, values: any[] = []) => {
        if (/^\s*BEGIN/i.test(sql)) { snapshot = structuredClone(this.snapshot()); return { rows: [], rowCount: null } as Result; }
        if (/^\s*COMMIT/i.test(sql)) { snapshot = undefined; return { rows: [], rowCount: null } as Result; }
        if (/^\s*ROLLBACK/i.test(sql)) { if (snapshot) this.restore(snapshot); snapshot = undefined; return { rows: [], rowCount: null } as Result; }
        try { return this.run(sql, values); }
        catch (error) { throw error; }
      },
      release: () => undefined,
    };
  }

  async query(sql: string, values: any[] = []) { return this.run(sql, values); }

  private snapshot() { return { loan: this.loan, intents: this.intents, payments: this.payments, payouts: this.payouts, events: this.events, audits: this.audits, nextIntentId: this.nextIntentId, nextPaymentId: this.nextPaymentId, nextPayoutId: this.nextPayoutId, nextEventId: this.nextEventId }; }
  private restore(state: any) { Object.assign(this, state); }
  private result(rows: any[] = []): Result { return { rows, rowCount: rows.length }; }

  private run(sql: string, values: any[]): Result {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (this.failOnce && this.failSql && q.includes(this.failSql.toLowerCase())) { this.failOnce = false; throw new Error("simulated database failure"); }
    if (q.startsWith("select p.id,p.loan_id as \"loanid\"")) return this.result(this.payouts.filter(p => ["pending", "ambiguous", "reversed"].includes(p.status)).map(p => ({ id: p.id, loanId: p.loan_id, loanNumber: this.loan.loan_number, clientId: this.loan.client_id, clientName: this.loan.full_name, providerReference: p.provider_reference, status: p.status, reversalReview: this.loan.payout_reversal_review })));
    if (q.startsWith("select l.id,l.client_id,l.loan_number,l.balance,l.status,l.payout_reversal_review")) return this.result(values[1] === this.loan.user_id ? [{ ...this.loan }] : []);
    if (q.startsWith("select l.id,l.loan_number,l.stage,l.status,l.principal_amount,l.amount_due")) return this.result([{ ...this.loan }]);
    if (q.startsWith("select 1 from loan_payment_intents")) return this.result(this.intents.some(i => i.loan_id === values[0] && ["pending", "ambiguous", "needs_review"].includes(i.status)) ? [{ ok: 1 }] : []);
    if (q.startsWith("insert into loan_payment_intents")) {
      const i = { id: this.nextIntentId++, loan_id: values[0], customer_id: values[1], client_id: values[2], provider: "snippe", provider_order_id: values[3], amount: values[4], status: "pending", gateway_reference: null };
      this.intents.push(i); return this.result([{ id: i.id }]);
    }
    if (q.startsWith("update loan_payment_intents set gateway_reference")) {
      const i = this.intents.find(row => row.id === values[0]); if (i) i.gateway_reference = values[1]; return this.result(i ? [i] : []);
    }
    if (q.startsWith("select * from loan_payment_intents where provider='snippe' and (gateway_reference=$1 or provider_order_id=$2)")) {
      return this.result(this.intents.filter(i => i.gateway_reference === values[0] || i.provider_order_id === values[1]).slice(0, 2));
    }
    if (q.startsWith("select * from loan_payment_intents where provider='snippe' and provider_order_id=$1")) return this.result(this.intents.filter(i => i.provider_order_id === values[0]));
    if (q.startsWith("select * from loan_payment_intents where id=$1 for update")) return this.result(this.intents.filter(i => i.id === values[0]));
    if (q.startsWith("select id, loan_number, balance, status, amount_due, principal_amount, amount_paid, payout_reversal_review from loans")) return this.result([{ ...this.loan }]);
    if (q.startsWith("select id, loan_id, amount, payment_intent_id from loan_payments")) return this.result(this.payments.filter(p => p.provider_transaction_id === values[0]));
    if (q.startsWith("select loan_id, amount, payment_intent_id from loan_payments")) return this.result(this.payments.filter(p => p.provider_transaction_id === values[0]));
    if (q.startsWith("insert into loan_payments")) {
      const payment = { id: this.nextPaymentId++, loan_id: values[0], amount: values[1], reference: values[2], provider_transaction_id: values[3], payment_intent_id: values[4], provider: "snippe" };
      if (this.payments.some(p => p.provider_transaction_id === payment.provider_transaction_id)) return this.result();
      this.payments.push(payment); return this.result([{ id: payment.id }]);
    }
    if (q.startsWith("update loans set balance =")) { this.loan.balance -= Number(values[1]); this.loan.amount_paid += Number(values[1]); if (this.loan.balance <= 0) this.loan.status = "closed"; return this.result([{ id: this.loan.id }]); }
    if (q.startsWith("update loan_payment_intents set status='paid'")) {
      const i = this.intents.find(row => row.id === values[0]); if (i) { i.status = "paid"; i.gateway_reference = values[1]; i.provider_transaction_id = values[1]; }
      return this.result(i ? [i] : []);
    }
    if (q.startsWith("update loan_payment_intents set status='needs_review'")) {
      const i = this.intents.find(row => row.id === values[0]); if (i && i.status !== "paid") { i.status = "needs_review"; i.failure_message = values[1]; }
      return this.result(i ? [i] : []);
    }
    if (q.startsWith("update loan_payment_intents set status='failed'")) {
      const i = this.intents.find(row => row.id === values[0]); if (i && ["pending", "ambiguous"].includes(i.status)) i.status = "failed";
      return this.result(i ? [i] : []);
    }
    if (q.startsWith("update loan_payment_intents set status='ambiguous'")) {
      const i = this.intents.find(row => row.id === values[0]); if (i) i.status = "ambiguous";
      return this.result(i ? [i] : []);
    }
    if (q.startsWith("insert into audit_log")) { this.audits.push({ sql: q, values }); return this.result([{ id: this.audits.length }]); }
    if (q.startsWith("insert into snippe_webhook_events")) {
      if (q.includes("signature_valid,processing_status,payload_sha256") && q.includes("false,'invalid'")) {
        const e = { id: this.nextEventId++, event_id: null, event_type: values[0], provider_reference: values[1], signature_valid: false, processing_status: "invalid", payload_sha256: values[2], failure_message: values[3] };
        this.events.push(e); return this.result([{ id: e.id }]);
      }
      if (values[0] && this.events.some(e => e.deduplication_key === values[0])) return this.result();
      const e = { id: this.nextEventId++, deduplication_key: values[0], event_id: values[1], event_type: values[2], provider_reference: values[3], signature_valid: true, processing_status: "processing", payload_sha256: values[4] };
      this.events.push(e); return this.result([{ id: e.id, processing_status: e.processing_status }]);
    }
    if (q.startsWith("select id,processing_status from snippe_webhook_events where deduplication_key=$1")) return this.result(this.events.filter(e => e.deduplication_key === values[0]));
    if (q.startsWith("update snippe_webhook_events set processing_status='processing'")) {
      const e = this.events.find(row => row.id === values[0]); if (e) e.processing_status = "processing"; return this.result(e ? [e] : []);
    }
    if (q.startsWith("update snippe_webhook_events set processing_status=$2")) {
      const e = this.events.find(row => row.id === values[0]); if (e) { e.processing_status = values[1]; e.failure_message = values[2]; }
      return this.result(e ? [e] : []);
    }
    if (q.startsWith("select id from loan_payout_intents where loan_id=$1 and status in")) return this.result(this.payouts.some(p => p.loan_id === values[0] && ["pending", "ambiguous"].includes(p.status)) ? [{ id: 1 }] : []);
    if (q.startsWith("insert into loan_payout_intents")) {
      const p = { id: this.nextPayoutId++, loan_id: values[0], initiated_by: values[1], provider: values[2], transaction_id: values[3], amount: values[4], principal_amount: values[5], destination: values[6], destination_name: values[7], destination_bank_code: values[8], next_due_date: values[9], currency: "TZS", fee_amount: values[10], total_debit: values[11], status: "pending", provider_reference: null };
      this.payouts.push(p); return this.result([p]);
    }
    if (q.startsWith("update loan_payout_intents set provider_reference=$2,status='pending'")) {
      const p = this.payouts.find(row => row.id === values[0]); if (p) p.provider_reference = values[1]; return this.result(p ? [p] : []);
    }
    if (q.startsWith("select id, amount, provider_reference from loan_payout_intents where provider_reference=$1 or id=$2")) return this.result(this.payouts.filter(p => p.provider_reference === values[0] || p.id === values[1]).slice(0, 2));
    if (q.startsWith("select * from loan_payout_intents where id=$1 for update")) return this.result(this.payouts.filter(p => p.id === values[0]));
    if (q.startsWith("update loans set stage='repayment',status='active'")) { this.loan.stage = "repayment"; this.loan.status = "active"; this.loan.balance = values[10]; this.loan.transfer_reference = values[1]; return this.result([{ loan_number: this.loan.loan_number }]); }
    if (q.startsWith("update loan_payout_intents set status='paid'")) { const p = this.payouts.find(row => row.id === values[0]); if (p) { p.status = "paid"; p.provider_reference = values[1]; } return this.result(p ? [p] : []); }
    if (q.startsWith("update loan_payout_intents set status='reversed'")) { const p = this.payouts.find(row => row.id === values[0]); if (p) { p.status = "reversed"; p.failure_message = values[1]; p.provider_reference ??= values[2]; } return this.result(p ? [p] : []); }
    if (q.startsWith("update loans set payout_reversal_review=true")) {
      const wasReview = this.loan.payout_reversal_review;
      this.loan.payout_reversal_review = true;
      if (q.includes("returning loan_number")) return this.result(!wasReview ? [{ loan_number: this.loan.loan_number }] : []);
      return this.result([{ id: this.loan.id }]);
    }
    if (q.startsWith("select loan_number from loans where id=$1")) return this.result([{ loan_number: this.loan.loan_number }]);
    if (q.startsWith("update loan_payout_intents set status=$2")) { const p = this.payouts.find(row => row.id === values[0]); if (p) { p.status = values[1]; p.failure_message = values[2]; p.provider_reference ??= values[3]; } return this.result(p ? [p] : []); }
    if (q.startsWith("update loan_payout_intents set status='pending'")) { const p = this.payouts.find(row => row.id === values[0]); if (p) p.provider_reference ??= values[1]; return this.result(p ? [p] : []); }
    if (q.startsWith("update loan_payout_intents set status='ambiguous'")) { const p = this.payouts.find(row => row.id === values[0]); if (p) { p.status = "ambiguous"; p.failure_message = values[1]; } return this.result(p ? [p] : []); }
    throw new Error(`Unexpected SQL in test fake: ${q}`);
  }
}

async function invoke(pool: MemoryPool, path: string, body: any, options: { role?: string; id?: number; request?: (path: string, init?: RequestInit) => Promise<any>; signatureValid?: boolean; method?: string } = {}) {
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer); } }));
  const authenticate = (_req: Request, res: Response, next: NextFunction) => { res.locals.user = { id: options.id ?? 22, username: "test-staff", role: options.role ?? "customer" }; next(); };
  app.use("/api", createSnippeRouter({ pool: pool as any, authenticate: authenticate as any, verifyWebhook: (() => options.signatureValid ?? true) as any, request: options.request as any, auditEvent: async () => undefined }));
  app.use((_req, res) => res.status(404).json({ message: "Not found" }));
  const server = app.listen(0);
  const address = server.address() as any;
  try {
    const method = options.method ?? "POST";
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json", "x-webhook-timestamp": "1794000000", "x-webhook-signature": "a".repeat(64) }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const paymentEvent = (overrides: Record<string, any> = {}) => ({ id: "evt-payment-1", type: "payment.completed", data: { reference: "snip-pay-1", status: "completed", amount: { value: 2000, currency: "TZS" }, metadata: { order_id: "BML-order-1" }, ...overrides } });

test("collection creates one intent with a stable idempotency key and handles definite rejection", async () => {
  const pool = new MemoryPool();
  const rejected = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, {
    request: async (_path, init) => { assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "bmlpay1"); throw new SnippeError("validation failed", 400); },
  });
  assert.equal(rejected.status, 400);
  assert.equal(pool.intents[0].status, "failed");
});

test("collection accepts a successful Snippe intent and saves its exact reference", async () => {
  const pool = new MemoryPool();
  const response = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, {
    request: async (path, init) => {
      assert.equal(path, "/v1/payments");
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "bmlpay1");
      return { status: "success", data: { reference: "snip-pay-1", status: "pending" } };
    },
  });
  assert.equal(response.status, 201);
  assert.equal(pool.intents[0].gateway_reference, "snip-pay-1");
});

test("a customer cannot create a payment intent for another customer's loan", async () => {
  const pool = new MemoryPool();
  let providerCalled = false;
  const response = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, {
    id: 999,
    request: async () => { providerCalled = true; throw new Error("provider must not be called"); },
  });
  assert.equal(response.status, 404);
  assert.equal(providerCalled, false);
  assert.equal(pool.intents.length, 0);
});

test("ambiguous collection remains open and blocks another charge", async () => {
  const pool = new MemoryPool();
  const uncertain = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, { request: async () => { throw new SnippeError("timeout"); } });
  assert.equal(uncertain.status, 202);
  assert.equal(pool.intents[0].status, "ambiguous");
  const blocked = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, { request: async () => { throw new Error("provider must not be called"); } });
  assert.equal(blocked.status, 409);
});

test("needs_review collection also blocks another charge", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "needs_review" });
  const blocked = await invoke(pool, "/api/customer/loans/9/payment-intents", { amount: 2000, mobile: "255712345678" }, { request: async () => { throw new Error("provider must not be called"); } });
  assert.equal(blocked.status, 409);
});

test("verified completed collection credits once, records audit, and duplicate event is deduplicated", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
  const first = await invoke(pool, "/api/webhooks/snippe", paymentEvent());
  const duplicate = await invoke(pool, "/api/webhooks/snippe", paymentEvent());
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(pool.loan.balance, 8000);
  assert.equal(pool.payments.length, 1);
  assert.equal(pool.intents[0].status, "paid");
  assert.ok(pool.audits.some(a => a.sql.includes("snippe repayment credited")));
  assert.equal(pool.events[0].processing_status, "processed");
});

test("a signed payment event without an event ID deduplicates by event type and transaction reference", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
  const event = paymentEvent();
  delete (event as any).id;
  const first = await invoke(pool, "/api/webhooks/snippe", event);
  const duplicate = await invoke(pool, "/api/webhooks/snippe", event);
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(pool.events.length, 1);
  assert.equal(pool.loan.balance, 8000);
  assert.equal(pool.payments.length, 1);
});

test("repeated payment reference with a different event ID cannot create a second ledger entry", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
  const original = paymentEvent();
  await invoke(pool, "/api/webhooks/snippe", original);
  await invoke(pool, "/api/webhooks/snippe", { ...original, id: "evt-payment-redelivery" });
  assert.equal(pool.loan.balance, 8000);
  assert.equal(pool.payments.length, 1);
});

test("signed event without an ID or transaction reference is retained for review and never processed", async () => {
  const pool = new MemoryPool();
  const event = { type: "payment.completed", data: { status: "completed", amount: { value: 2000, currency: "TZS" }, metadata: { order_id: "BML-order-1" } } };
  const first = await invoke(pool, "/api/webhooks/snippe", event);
  const duplicate = await invoke(pool, "/api/webhooks/snippe", event);
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(pool.events.length, 1);
  assert.equal(pool.events[0].processing_status, "needs_review");
  assert.match(pool.events[0].failure_message, /without financial processing/);
  assert.equal(pool.payments.length, 0);
  assert.equal(pool.loan.balance, 10000);
});

test("collection mismatches for reference, amount, and currency are routed to review", async (t) => {
  for (const [name, data] of [
    ["reference", { reference: "wrong-reference" }],
    ["missing amount", { amount: undefined }],
    ["currency", { amount: { value: 2000, currency: "USD" } }],
    ["amount", { amount: { value: 1999, currency: "TZS" } }],
  ] as const) {
    await t.test(name, async () => {
      const pool = new MemoryPool();
      pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
      const event = paymentEvent(data as any);
      if (name === "reference") event.data.metadata.order_id = "BML-order-1";
      await invoke(pool, "/api/webhooks/snippe", event);
      assert.equal(pool.intents[0].status, "needs_review");
      assert.equal(pool.payments.length, 0);
      assert.equal(pool.events[0].processing_status, "needs_review");
    });
  }
});

test("a transaction reference already belonging to another intent is never credited", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
  pool.payments.push({ id: 1, loan_id: 55, amount: 2000, provider_transaction_id: "snip-pay-1", payment_intent_id: 888, provider: "snippe" });
  await invoke(pool, "/api/webhooks/snippe", paymentEvent());
  assert.equal(pool.intents[0].status, "needs_review");
  assert.equal(pool.loan.balance, 10000);
  assert.equal(pool.payments.length, 1);
});

test("database failure during settlement returns 500 and rolls back the payment", async () => {
  const pool = new MemoryPool();
  pool.intents.push({ id: 1, loan_id: 9, customer_id: 22, client_id: 4, provider_order_id: "BML-order-1", amount: 2000, status: "pending", gateway_reference: "snip-pay-1" });
  pool.failSql = "update loans set balance ="; pool.failOnce = true;
  const originalError = console.error;
  console.error = () => undefined;
  let response: Awaited<ReturnType<typeof invoke>>;
  try { response = await invoke(pool, "/api/webhooks/snippe", paymentEvent()); }
  finally { console.error = originalError; }
  assert.equal(response.status, 500);
  assert.equal(pool.intents[0].status, "pending");
  assert.equal(pool.loan.balance, 10000);
  assert.equal(pool.payments.length, 0);
  assert.equal(pool.events.length, 0);
});

test("invalid signatures are recorded without storing raw customer payload", async () => {
  const pool = new MemoryPool();
  const response = await invoke(pool, "/api/webhooks/snippe", paymentEvent(), { signatureValid: false });
  assert.equal(response.status, 401);
  assert.equal(pool.events[0].processing_status, "invalid");
  assert.equal(pool.events[0].signature_valid, false);
  assert.equal("raw_body" in pool.events[0], false);
});

test("Snippe HMAC verification accepts exact signed bytes and rejects a stale timestamp", () => {
  const raw = Buffer.from('{"id":"evt","type":"payment.completed"}');
  const secret = process.env.SNIPPE_WEBHOOK_SECRET!;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest("hex");
  assert.equal(verifySnippeWebhook(raw, timestamp, signature), true);
  assert.equal(verifySnippeWebhook(raw, String(Number(timestamp) - 600), signature), false);
  assert.equal(verifySnippeWebhook(raw, timestamp, "0".repeat(64)), false);
});

test("unauthorized staff cannot request a loan payout", async () => {
  const pool = new MemoryPool("payout");
  const response = await invoke(pool, "/api/loans/9/payout", { amount: 10000, provider: "snippe_mobile", destination: "255712345678", destinationName: "Asha Mushi", nextDueDate: "2027-01-01" }, { role: "loan_officer", request: async () => { throw new Error("provider must not be called"); } });
  assert.equal(response.status, 403);
  assert.equal(pool.payouts.length, 0);
});

test("payout quotes fee, uses stable idempotency, and prevents duplicate pending payout", async () => {
  const pool = new MemoryPool("payout");
  let sendCount = 0;
  const request = async (path: string, init?: RequestInit) => {
    if (path.startsWith("/v1/payouts/fee")) return { status: "success", data: { amount: 8500, fee_amount: 250, total_amount: 8750, currency: "TZS" } };
    sendCount++;
    assert.equal(path, "/v1/payouts/send");
    assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "bmlpayout1");
    return { status: "success", data: { reference: "snip-payout-1", status: "pending" } };
  };
  const input = { amount: 10000, provider: "snippe_mobile", destination: "255712345678", destinationName: "Asha Mushi", nextDueDate: "2027-01-01" };
  const first = await invoke(pool, "/api/loans/9/payout", input, { role: "finance", id: 31, request });
  const again = await invoke(pool, "/api/loans/9/payout", input, { role: "finance", id: 31, request });
  assert.equal(first.status, 202);
  assert.equal(again.status, 409);
  assert.equal(sendCount, 1);
  assert.equal(pool.payouts[0].fee_amount, 250);
  assert.equal(pool.payouts[0].total_debit, 8750);
});

test("successful payout requires exact amount and TZS, then activates loan; reversal freezes it", async () => {
  const pool = new MemoryPool("payout");
  pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, principal_amount: 10000, next_due_date: "2027-01-01", status: "pending", provider_reference: "snip-payout-1" });
  const complete = { id: "evt-payout-1", type: "payout.completed", data: { reference: "snip-payout-1", status: "completed", amount: { value: 8500, currency: "TZS" }, metadata: { payout_id: "1" } } };
  await invoke(pool, "/api/webhooks/snippe", complete);
  const duplicate = await invoke(pool, "/api/webhooks/snippe", complete);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(pool.payouts[0].status, "paid");
  assert.equal(pool.loan.status, "active");
  const balanceBeforeReversal = pool.loan.balance;
  const reversed = { ...complete, id: "evt-payout-2", type: "payout.reversed" };
  await invoke(pool, "/api/webhooks/snippe", reversed);
  assert.equal(pool.payouts[0].status, "reversed");
  assert.equal(pool.loan.payout_reversal_review, true);
  assert.equal(pool.loan.status, "active");
  assert.equal(pool.loan.balance, balanceBeforeReversal);
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout reversal requires finance review")).length, 1);
  assert.match(String(pool.audits.find(a => a.sql.includes("loan payout reversal requires finance review"))?.values[2]), /Loan status and repayment ledger were preserved/);
  const duplicateReversal = { ...reversed, id: "evt-payout-3" };
  await invoke(pool, "/api/webhooks/snippe", duplicateReversal);
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout reversal requires finance review")).length, 1);
});

test("a payout event without an event ID deduplicates by payout reference and cannot repeat activation", async () => {
  const pool = new MemoryPool("payout");
  pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, principal_amount: 10000, next_due_date: "2027-01-01", status: "pending", provider_reference: "snip-payout-no-id" });
  const event = { type: "payout.completed", data: { reference: "snip-payout-no-id", status: "completed", amount: { value: 8500, currency: "TZS" }, metadata: { payout_id: "1" } } };
  const first = await invoke(pool, "/api/webhooks/snippe", event);
  const duplicate = await invoke(pool, "/api/webhooks/snippe", event);
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(pool.events.length, 1);
  assert.equal(pool.loan.status, "active");
  assert.equal(pool.payouts[0].status, "paid");
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout confirmed")).length, 1);
});

test("repeated payout reference with a different event ID cannot repeat the payout transition", async () => {
  const pool = new MemoryPool("payout");
  pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, principal_amount: 10000, next_due_date: "2027-01-01", status: "pending", provider_reference: "snip-payout-repeated" });
  const event = { id: "evt-payout-first", type: "payout.completed", data: { reference: "snip-payout-repeated", status: "completed", amount: { value: 8500, currency: "TZS" }, metadata: { payout_id: "1" } } };
  await invoke(pool, "/api/webhooks/snippe", event);
  await invoke(pool, "/api/webhooks/snippe", { ...event, id: "evt-payout-second" });
  assert.equal(pool.loan.status, "active");
  assert.equal(pool.payouts[0].status, "paid");
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout confirmed")).length, 1);
});

test("reversal before activation freezes loan for Finance without changing status or ledger", async () => {
  const pool = new MemoryPool("payout");
  pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, principal_amount: 10000, next_due_date: "2027-01-01", status: "pending", provider_reference: "snip-payout-1" });
  const reversed = { id: "evt-payout-pre-activation", type: "payout.reversed", data: { reference: "snip-payout-1", status: "reversed", amount: { value: 8500, currency: "TZS" }, metadata: { payout_id: "1" } } };
  const first = await invoke(pool, "/api/webhooks/snippe", reversed);
  assert.equal(first.status, 200);
  assert.equal(pool.payouts[0].status, "reversed");
  assert.equal(pool.loan.payout_reversal_review, true);
  assert.equal(pool.loan.status, "in_progress");
  assert.equal(pool.loan.stage, "disbursement");
  assert.equal(pool.loan.balance, 0);
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout reversal requires finance review")).length, 1);
  assert.match(String(pool.audits[0].values[2]), /before loan activation/);
  const duplicate = await invoke(pool, "/api/webhooks/snippe", { ...reversed, id: "evt-payout-pre-activation-duplicate" });
  assert.equal(duplicate.status, 200);
  assert.equal(pool.audits.filter(a => a.sql.includes("loan payout reversal requires finance review")).length, 1);
});

test("Finance review queue exposes reversal hold and there is no route to clear it", async () => {
  const pool = new MemoryPool("payout");
  pool.loan.payout_reversal_review = true;
  pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, status: "reversed", provider_reference: "snip-payout-1" });
  const queue = await invoke(pool, "/api/loans/payouts/pending", {}, { role: "finance", method: "GET" });
  assert.equal(queue.status, 200);
  assert.equal(queue.body[0].reversalReview, true);
  assert.equal(queue.body[0].loanNumber, pool.loan.loan_number);
  assert.equal(queue.body[0].providerReference, "snip-payout-1");
  const response = await invoke(pool, "/api/loans/9/payout-reversal-review/clear", {}, { role: "loan_officer", method: "PUT" });
  assert.equal(response.status, 404);
  assert.equal(pool.loan.payout_reversal_review, true);
  assert.equal(pool.loan.status, "in_progress");
});

test("payout rejects an unregistered mobile number before sending money", async () => {
  const pool = new MemoryPool("payout");
  const response = await invoke(pool, "/api/loans/9/payout", { amount: 10000, provider: "snippe_mobile", destination: "255765432109", destinationName: "Asha Mushi", nextDueDate: "2027-01-01" }, {
    role: "finance", id: 31,
    request: async (path) => path.startsWith("/v1/payouts/fee") ? { status: "success", data: { amount: 8500, fee_amount: 250, total_amount: 8750, currency: "TZS" } } : (() => { throw new Error("payout send must not be called"); })(),
  });
  assert.equal(response.status, 400);
  assert.equal(pool.payouts.length, 0);
});

test("payout completion missing amount or wrong currency stays ambiguous", async (t) => {
  for (const amount of [undefined, { value: 8500, currency: "USD" }]) {
    await t.test(amount ? "wrong currency" : "missing amount", async () => {
      const pool = new MemoryPool("payout");
      pool.payouts.push({ id: 1, loan_id: 9, transaction_id: "BMLP1", amount: 8500, principal_amount: 10000, status: "pending", provider_reference: "snip-payout-1" });
      const response = await invoke(pool, "/api/webhooks/snippe", { id: `evt-${String(amount)}`, type: "payout.completed", data: { reference: "snip-payout-1", amount, metadata: { payout_id: "1" } } });
      assert.equal(response.status, 200);
      assert.equal(pool.payouts[0].status, "ambiguous");
      assert.equal(pool.loan.status, "in_progress");
    });
  }
});
