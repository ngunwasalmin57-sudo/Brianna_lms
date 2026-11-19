import { Router, Request } from "express";
import { createHash, randomUUID } from "crypto";
import { pool as defaultPool } from "../db";
import { requireAuth as defaultRequireAuth, JwtUser } from "../auth";
import { config } from "../config";
import { audit as defaultAudit } from "../audit";
import { azampayRequest as defaultAzamPayRequest, azampayMnoCheckout, azampayDisburse, azampayDisbursementStatus, verifyAzamPayCallback as defaultVerifyAzamPayWebhook, AzamPayError } from "../azampay";
import { calculateRepaymentTerms } from "../repaymentTerms";

type RoutePool = typeof defaultPool;
type AzamPayRouteDependencies = {
  pool?: RoutePool;
  request?: typeof defaultAzamPayRequest;
  verifyWebhook?: typeof defaultVerifyAzamPayWebhook;
  authenticate?: typeof defaultRequireAuth;
  auditEvent?: typeof defaultAudit;
};

export function createAzamPayRouter(dependencies: AzamPayRouteDependencies = {}) {
const azampayRoutes = Router();
const pool = dependencies.pool ?? defaultPool;
const azampayRequest = dependencies.request ?? defaultAzamPayRequest;
const verifyAzamPayCallback = dependencies.verifyWebhook ?? defaultVerifyAzamPayWebhook;
const requireAuth = dependencies.authenticate ?? defaultRequireAuth;
const audit = dependencies.auditEvent ?? defaultAudit;

type AzamPayAmount = number | string | { value: number | string; currency: string };
type EventData = {
  reference?: string;
  external_reference?: string;
  status?: string;
  amount?: AzamPayAmount;
  currency?: string;
  channel?: { type?: string; provider?: string };
  metadata?: { order_id?: string; payout_id?: string; [key: string]: unknown };
};

/** A business-rule problem (not a crash): the money arrived but cannot be credited automatically. */
class ReviewError extends Error {}

const STAFF_ROLES = ["finance", "supervisor", "director", "ceo"];
const FAILED_PAYMENT_EVENTS = ["payment.failed", "payment.voided", "payment.expired"];
// Today's date in Tanzania (UTC+3). The database server runs in UTC.
const TODAY_TZ = "(now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date";

function amountValue(value: AzamPayAmount | undefined) {
  return typeof value === "object" ? Number(value.value) : Number(value);
}
function amountCurrency(value: AzamPayAmount | undefined, fallback?: string) {
  return typeof value === "object" ? value.currency : fallback ?? "TZS";
}
function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("0") ? `255${digits.slice(1)}` : digits;
}
function isDefiniteRejection(err: unknown): err is AzamPayError {
  return err instanceof AzamPayError && !!err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 500;
}

async function markNeedsReview(intentId: number, message: string) {
  await pool.query(
    "UPDATE loan_payment_intents SET status='needs_review', failure_message=$2, updated_at=now() WHERE id=$1 AND status<>'paid'",
    [intentId, message.slice(0, 500)]
  );
}

/* ------------------------------------------------------------------ */
/* Crediting a completed repayment                                     */
/* ------------------------------------------------------------------ */

async function creditRepayment(client: import("pg").PoolClient, intent: any, reference: string, channel: string) {
  if (intent.status === "paid") return;
  if (!reference || (intent.gateway_reference && intent.gateway_reference !== reference)) {
    throw new ReviewError("AzamPay payment reference does not match this payment attempt.");
  }

  const loanResult = await client.query(
    "SELECT id, loan_number, balance, status, amount_due, principal_amount, amount_paid, payout_reversal_review FROM loans WHERE id = $1 FOR UPDATE",
    [intent.loan_id]
  );
  const loan = loanResult.rows[0];
  if (!loan) throw new ReviewError("Loan not found for this AzamPay payment.");
  if (loan.payout_reversal_review) throw new ReviewError("This loan is frozen for Finance review after a reversed payout.");

  const existing = await client.query(
    "SELECT id, loan_id, amount, payment_intent_id FROM loan_payments WHERE provider='azampay' AND provider_transaction_id=$1 FOR UPDATE",
    [reference]
  );
  if (existing.rowCount) {
    const payment = existing.rows[0];
    if (Number(payment.payment_intent_id) !== Number(intent.id) || Number(payment.loan_id) !== Number(intent.loan_id) || Number(payment.amount) !== Number(intent.amount)) {
      throw new ReviewError("This AzamPay transaction reference is already linked to a different loan payment.");
    }
  }

  const inserted = existing.rowCount ? { rowCount: 0 } : await client.query(
    `INSERT INTO loan_payments (loan_id, amount, reference, received_by, provider, provider_transaction_id, payment_intent_id)
     VALUES ($1,$2,$3,NULL,'azampay',$4,$5)
     ON CONFLICT (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [intent.loan_id, intent.amount, reference, reference, intent.id]
  );
  if (!existing.rowCount && !inserted.rowCount) {
    const conflict = await client.query(
      "SELECT loan_id, amount, payment_intent_id FROM loan_payments WHERE provider='azampay' AND provider_transaction_id=$1 FOR UPDATE",
      [reference]
    );
    const payment = conflict.rows[0];
    if (!payment || Number(payment.payment_intent_id) !== Number(intent.id) || Number(payment.loan_id) !== Number(intent.loan_id) || Number(payment.amount) !== Number(intent.amount)) {
      throw new ReviewError("This AzamPay transaction reference is already linked to a different loan payment.");
    }
  }

  // Only change the loan if this payment was newly recorded. If the row already existed,
  // the loan was already credited and we must not reduce the balance a second time.
  if (inserted.rowCount) {
    if (loan.status !== "active" || Number(intent.amount) > Number(loan.balance)) {
      throw new ReviewError("Loan balance does not match the AzamPay payment. Manual reconciliation is required.");
    }
    await client.query(
      `UPDATE loans SET balance = GREATEST(balance - $2, 0), amount_paid = COALESCE(amount_paid, 0) + $2,
         arrears = CASE WHEN first_due_date IS NOT NULL AND weekly_installment_amount > 0 AND ${TODAY_TZ} >= first_due_date
           THEN GREATEST((CASE WHEN LEAST(installment_count, FLOOR((${TODAY_TZ} - first_due_date)::numeric / 7)::int + 1) >= installment_count THEN amount_due
             ELSE LEAST(installment_count, FLOOR((${TODAY_TZ} - first_due_date)::numeric / 7)::int + 1) * weekly_installment_amount END) - COALESCE(amount_paid, 0) - $2, 0)
           ELSE GREATEST(COALESCE(arrears, 0) - $2, 0) END,
         next_due_date = CASE WHEN first_due_date IS NOT NULL AND weekly_installment_amount > 0
           THEN first_due_date + (LEAST(installment_count - 1, FLOOR((COALESCE(amount_paid, 0) + $2) / weekly_installment_amount)::int) * 7)
           ELSE next_due_date END,
         repayment_performance = CASE WHEN COALESCE(amount_due, principal_amount, 0) > 0
           THEN LEAST(100, ((COALESCE(amount_paid, 0) + $2) / COALESCE(amount_due, principal_amount)) * 100) ELSE repayment_performance END,
         status = CASE WHEN GREATEST(balance - $2, 0) = 0 THEN 'closed' ELSE status END, updated_at = now()
       WHERE id = $1`,
      [intent.loan_id, intent.amount]
    );
  }

  await client.query(
    `UPDATE loan_payment_intents SET status='paid', gateway_reference=$2, provider_transaction_id=$2,
       channel=$3, paid_at=now(), updated_at=now(), failure_message=NULL WHERE id=$1`,
    [intent.id, reference, channel]
  );
  await client.query(
    `INSERT INTO audit_log (username, action, record, detail) VALUES ('azampay-webhook','AzamPay repayment credited',$1,$2)`,
    [loan.loan_number, `Intent ${intent.provider_order_id}; reference ${reference}; TZS ${intent.amount}`]
  );
}

/** Locks the intent, credits the loan and commits. Throws ReviewError for business problems, other errors for crashes. */
async function settleCompletedPayment(intentId: number, reference: string, channel: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM loan_payment_intents WHERE id=$1 FOR UPDATE", [intentId]);
    if (!locked.rows[0]) throw new ReviewError("Payment attempt not found.");
    await creditRepayment(client, locked.rows[0], reference, channel);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Customer views                                                      */
/* ------------------------------------------------------------------ */

azampayRoutes.get("/customer/payments", requireAuth, async (_req, res) => {
  const user = res.locals.user as JwtUser;
  if (user.role !== "customer") return res.status(403).json({ message: "Only customers can view payment records." });
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.loan_id AS "loanId", l.loan_number AS "loanNumber", p.amount, p.provider,
              p.reference, p.received_at AS "receivedAt" FROM loan_payments p JOIN loans l ON l.id=p.loan_id
         JOIN clients c ON c.id=l.client_id WHERE c.user_id=$1 ORDER BY p.received_at DESC LIMIT 200`,
      [user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load payment records." });
  }
});

azampayRoutes.get("/customer/payment-intents", requireAuth, async (_req, res) => {
  const user = res.locals.user as JwtUser;
  if (user.role !== "customer") return res.status(403).json({ message: "Only customers can view payment attempts." });
  try {
    // 'needs_review' is shown to customers as 'ambiguous' ("being checked"); the detail is for staff only.
    const { rows } = await pool.query(
      `SELECT i.id, i.loan_id AS "loanId", l.loan_number AS "loanNumber", i.provider_order_id AS "orderId",
              i.amount, i.provider, CASE WHEN i.status='needs_review' THEN 'ambiguous' ELSE i.status END AS status,
              i.checkout_url AS "checkoutUrl", i.gateway_reference AS "gatewayReference",
              i.payment_method AS "paymentMethod", i.qr_code AS "qrCode",
              i.created_at AS "createdAt", i.paid_at AS "paidAt"
         FROM loan_payment_intents i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id
        WHERE i.customer_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
      [user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load payment attempts." });
  }
});

/* ------------------------------------------------------------------ */
/* Start a customer repayment                                          */
/* ------------------------------------------------------------------ */

azampayRoutes.post("/customer/loans/:loanId/payment-intents", requireAuth, async (req, res) => {
  const user = res.locals.user as JwtUser;
  if (user.role !== "customer") return res.status(403).json({ message: "Only customers can initiate loan repayments." });
  const loanId = Number(req.params.loanId);
  const amount = Number(req.body?.amount);
  const paymentMethod = String(req.body?.paymentMethod ?? "push");
  const paymentType = paymentMethod === "push" ? "mobile" : "";
  const mobile = normalizePhone(String(req.body?.mobile ?? ""));
  const operator = String(req.body?.operator ?? "");
  if (!Number.isInteger(loanId) || loanId < 1) return res.status(400).json({ message: "Invalid loan account." });
  if (!Number.isSafeInteger(amount) || amount < 500) return res.status(400).json({ message: "AzamPay payments must be at least TZS 500 in whole shillings." });
  if (amount > 1_000_000_000) return res.status(400).json({ message: "Payment amount exceeds the supported limit." });
  if (!paymentType) return res.status(400).json({ message: "AzamPay customer repayments currently use mobile money push." });
  if (!("Airtel" === operator || "Tigo" === operator || "Halopesa" === operator || "Azampesa" === operator || "Mpesa" === operator)) return res.status(400).json({ message: "Choose a supported mobile money provider." });
  if (paymentMethod === "push" && !/^255[67]\d{8}$/.test(mobile)) return res.status(400).json({ message: "Enter a Tanzanian mobile number starting with 255." });
  if (!config.azampayEnabled) return res.status(503).json({ message: "AzamPay payments are not configured yet. Contact BML." });

  const client = await pool.connect();
  let intentId: number;
  let orderId: string;
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT l.id,l.client_id,l.loan_number,l.balance,l.status,l.payout_reversal_review,c.full_name FROM loans l JOIN clients c ON c.id=l.client_id
        WHERE l.id=$1 AND c.user_id=$2 FOR UPDATE OF l`,
      [loanId, user.id]
    );
    const loan = found.rows[0];
    if (!loan) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Loan account not found." });
    }
    if (loan.status !== "active" || loan.payout_reversal_review || amount > Number(loan.balance)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: loan.payout_reversal_review ? "This loan is temporarily frozen for Finance review." : "Payment must be for an active loan and cannot exceed its outstanding balance." });
    }
    // The loan row is locked, so this check cannot race with another request.
    const open = await client.query(
      "SELECT 1 FROM loan_payment_intents WHERE loan_id=$1 AND status IN ('pending','ambiguous','needs_review') LIMIT 1",
      [loanId]
    );
    if (open.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "You already have a payment in progress for this loan. Wait for it to finish or expire, or contact BML if it was not confirmed." });
    }
    orderId = `BML${randomUUID().replace(/-/g, "").slice(0, 18)}`;
    const saved = await client.query(
      `INSERT INTO loan_payment_intents (loan_id,customer_id,client_id,provider,provider_order_id,amount,payment_method)
       VALUES ($1,$2,$3,'azampay',$4,$5,$6) RETURNING id`,
      [loanId, user.id, loan.client_id, orderId, amount, paymentMethod]
    );
    intentId = saved.rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((err as { code?: string }).code === "23505") {
      // Backstop: the one_open_intent_per_loan index caught a concurrent attempt.
      return res.status(409).json({ message: "You already have a payment in progress for this loan. Wait for it to finish or expire." });
    }
    console.error(err);
    return res.status(500).json({ message: "Could not prepare this repayment." });
  } finally {
    client.release();
  }

  try {
    const payment: any = await azampayMnoCheckout({ accountNumber: mobile, amount, provider: operator, externalId: orderId });
    const reference = String(payment.transactionId ?? payment.data?.transactionId ?? payment.data?.referenceId ?? orderId);
    await pool.query(
      "UPDATE loan_payment_intents SET gateway_reference=$2,channel=$3,updated_at=now() WHERE id=$1",
      [intentId, reference, operator]
    );
    return res.status(201).json({
      intentId, orderId, provider: "azampay", status: "pending", amount,
      reference, paymentMethod,
    });
  } catch (err) {
    if (isDefiniteRejection(err)) {
      // AzamPay answered and refused: nothing was charged, so this is a clean failure, not "ambiguous".
      await pool.query(
        "UPDATE loan_payment_intents SET status='failed',failure_message=$2,updated_at=now() WHERE id=$1 AND status='pending'",
        [intentId, err.message]
      );
      const serverSide = err.httpStatus === 401 || err.httpStatus === 403;
      return res.status(serverSide ? 502 : 400).json({
        message: serverSide ? "Payments are unavailable right now. Contact BML." : err.message,
      });
    }
    await pool.query(
      "UPDATE loan_payment_intents SET status='ambiguous',failure_message=$2,updated_at=now() WHERE id=$1 AND status='pending'",
      [intentId, (err as Error).message]
    );
    return res.status(202).json({
      intentId, orderId, provider: "azampay", status: "ambiguous", amount,
      message: "AzamPay payment status is being checked. Do not start another payment yet.",
    });
  }
});

/* ------------------------------------------------------------------ */
/* Staff: payment review, reconcile, close                             */
/* ------------------------------------------------------------------ */

azampayRoutes.get("/loans/payments/review", requireAuth, async (_req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Payment review is restricted to Finance and authorized managers." });
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.loan_id AS "loanId", l.loan_number AS "loanNumber", c.full_name AS "clientName",
              i.provider_order_id AS "orderId", i.gateway_reference AS "gatewayReference", i.amount, i.status,
              i.failure_message AS "failureMessage", i.created_at AS "createdAt"
         FROM loan_payment_intents i JOIN loans l ON l.id=i.loan_id JOIN clients c ON c.id=l.client_id
        WHERE i.status IN ('ambiguous','needs_review')
           OR (i.status='pending' AND i.created_at < now() - interval '30 minutes')
        ORDER BY i.created_at LIMIT 200`
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load payments needing review." });
  }
});

azampayRoutes.post("/loans/payments/:orderId/reconcile", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Only Finance and authorized managers can reconcile payments." });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM loan_payment_intents WHERE provider='azampay' AND provider_order_id=$1",
      [req.params.orderId]
    );
    const intent = rows[0];
    if (!intent) return res.status(404).json({ message: "Payment attempt not found." });
    if (intent.status === "paid") return res.json({ ok: true, status: "completed", message: "This payment is already credited." });
    if (!intent.gateway_reference) {
      return res.status(409).json({ message: "AzamPay never returned a reference for this attempt. Check the AzamPay dashboard; if no money was taken, close the attempt." });
    }

    return res.status(409).json({ message: "AzamPay has not sent a signed confirmation for this repayment yet. Check the AzamPay dashboard before closing the attempt." });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ message: (err as Error).message || "Could not query AzamPay payment status." });
  }
});

azampayRoutes.post("/loans/payments/:orderId/close", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Only Finance and authorized managers can close payment attempts." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (note.length < 5 || note.length > 300) return res.status(400).json({ message: "Enter a note (5 to 300 characters) confirming that no money was taken." });
  try {
    const result = await pool.query(
      `UPDATE loan_payment_intents SET status='failed', failure_message=$2, updated_at=now()
        WHERE provider='azampay' AND provider_order_id=$1 AND status IN ('pending','ambiguous','needs_review') RETURNING id`,
      [req.params.orderId, `Closed manually by ${actor.username}: ${note}`]
    );
    if (!result.rowCount) return res.status(404).json({ message: "No open payment attempt with that order number." });
    await audit(actor.username, "Payment attempt closed manually", String(req.params.orderId), note);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not close this payment attempt." });
  }
});

/* ------------------------------------------------------------------ */
/* Loan payout (disbursement)                                          */
/* ------------------------------------------------------------------ */

azampayRoutes.post("/loans/:id/payout", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Loan payouts are restricted to Finance and authorized managers." });
  const id = Number(req.params.id);
  const amount = Number(req.body?.amount);
  const channel = req.body?.provider === "azampay_bank" ? "bank" : req.body?.provider === "azampay_mobile" ? "mobile" : "";
  const destination = typeof req.body?.destination === "string" ? req.body.destination.trim() : "";
  const destinationName = typeof req.body?.destinationName === "string" ? req.body.destinationName.trim() : "";
  const bankCode = typeof req.body?.bankCode === "string" ? req.body.bankCode.trim().toUpperCase() : "";
  const operator = typeof req.body?.operator === "string" ? req.body.operator : "";
  const nextDueDate = typeof req.body?.nextDueDate === "string" ? req.body.nextDueDate : "";
  if (!Number.isInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 500 || !channel) return res.status(400).json({ message: "Choose a AzamPay payout route and amount of at least TZS 500." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate) || Number.isNaN(Date.parse(`${nextDueDate}T00:00:00Z`))) return res.status(400).json({ message: "Choose the first repayment due date." });
  if (destinationName.length < 2 || destinationName.length > 120) return res.status(400).json({ message: "Enter the recipient's full name." });
  if (channel === "mobile" && !/^255[67]\d{8}$/.test(normalizePhone(destination))) return res.status(400).json({ message: "Enter a Tanzanian mobile number starting with 255." });
  if (channel === "mobile" && !["Airtel", "Tigo", "Halopesa", "Azampesa", "Mpesa"].includes(operator)) return res.status(400).json({ message: "Choose a supported mobile money provider." });
  if (channel === "bank" && (!/^[A-Z0-9 ]{2,30}$/.test(bankCode) || destination.length < 5 || destination.length > 40)) return res.status(400).json({ message: "Enter a valid bank code and account number." });
  if (!config.azampayEnabled) return res.status(503).json({ message: "AzamPay payouts are not configured yet." });
  if (!config.azampaySourceAccount || !config.azampaySourceName || !config.azampayDisbursementBank) return res.status(503).json({ message: "AzamPay payout source details are not configured yet." });

  const terms = calculateRepaymentTerms(amount);
  const disbursementAmount = Math.round(terms.netDisbursedAmount);
  if (disbursementAmount < 500) return res.status(400).json({ message: "Net disbursement must be at least TZS 500." });
  // AzamPay does not expose the previous provider's fee quote endpoint. Fees remain unset until the merchant tariff is confirmed.
  const feeAmount = null;
  const totalDebit = null;

  const client = await pool.connect();
  let intent: any;
  let loan: any;
  const transactionId = `BMLP${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT l.id,l.loan_number,l.stage,l.status,l.principal_amount,l.amount_due,
              c.id AS client_id,c.full_name,c.phone,c.bank_code,c.bank_account_number,c.bank_account_name,
              c.bank_details_submitted_by,c.bank_details_verified_by,c.bank_details_verified_at
         FROM loans l JOIN clients c ON c.id=l.client_id WHERE l.id=$1 FOR UPDATE OF l,c`,
      [id]
    );
    loan = found.rows[0];
    if (!loan) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Loan record not found." });
    }
    if (loan.stage !== "disbursement" || loan.status !== "in_progress" || amount > Math.floor(Number(loan.principal_amount ?? loan.amount_due ?? 0))) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This loan is not ready for this payout amount." });
    }
    if (channel === "mobile" && destinationName.trim().toLocaleLowerCase() !== String(loan.full_name).trim().toLocaleLowerCase()) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "The recipient name must match the approved customer record." });
    }
    if (channel === "mobile" && (!loan.phone || normalizePhone(destination) !== normalizePhone(String(loan.phone)))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Mobile payouts can only be sent to the customer’s registered phone number." });
    }
    if (channel === "bank") {
      const bankProfileValid = loan.bank_details_verified_at && loan.bank_details_submitted_by && loan.bank_details_verified_by && Number(loan.bank_details_verified_by) !== actor.id;
      if (!bankProfileValid) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Verified bank details are not available for this customer, or the verifier must be different from the payout initiator." });
      }
      if (bankCode !== loan.bank_code || destination !== loan.bank_account_number || destinationName.trim().toLocaleLowerCase() !== String(loan.bank_account_name).trim().toLocaleLowerCase()) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Bank payout details must exactly match the verified customer bank profile." });
      }
    }
    const existing = await client.query("SELECT id FROM loan_payout_intents WHERE loan_id=$1 AND status IN ('pending','ambiguous')", [id]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "A payout is already pending. Check its status before retrying." });
    }
    const saved = await client.query(
      `INSERT INTO loan_payout_intents (loan_id,initiated_by,provider,transaction_id,amount,principal_amount,destination,destination_name,destination_bank_code,next_due_date,currency,fee_amount,total_debit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TZS',$11,$12) RETURNING *`,
      [id, actor.id, channel === "mobile" ? "azampay_mobile" : "azampay_bank", transactionId, disbursementAmount, terms.principalAmount, destination, destinationName, channel === "bank" ? bankCode : operator, nextDueDate, feeAmount, totalDebit]
    );
    intent = saved.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(err);
    return res.status(500).json({ message: "Could not prepare the payout." });
  } finally {
    client.release();
  }

  try {
    const result: any = await azampayDisburse({
      amount: Number(intent.amount), destination: channel === "mobile" ? normalizePhone(destination) : destination,
      recipientName: destinationName, bankName: channel === "mobile" ? operator : bankCode,
      externalId: transactionId, remarks: `BML loan ${loan.loan_number}`,
    });
    const reference = result?.pgReferenceId ?? result?.transactionId ?? result?.data?.pgReferenceId ?? result?.data?.transactionId ?? transactionId;
    await pool.query("UPDATE loan_payout_intents SET provider_reference=$2,status='pending',updated_at=now() WHERE id=$1", [intent.id, reference]);
    return res.status(202).json({ ok: true, status: "pending", transactionId, message: "AzamPay payout submitted. The loan activates after AzamPay confirms delivery." });
  } catch (err) {
    if (isDefiniteRejection(err)) {
      await pool.query(
        "UPDATE loan_payout_intents SET status='failed',failure_message=$2,updated_at=now() WHERE id=$1 AND status='pending'",
        [intent.id, err.message]
      );
      const serverSide = err.httpStatus === 401 || err.httpStatus === 403;
      return res.status(serverSide ? 502 : 400).json({
        message: serverSide ? "Payouts are unavailable right now. Contact the system administrator." : `AzamPay rejected the payout: ${err.message}`,
      });
    }
    await pool.query(
      "UPDATE loan_payout_intents SET status='ambiguous',failure_message=$2,updated_at=now() WHERE id=$1 AND status='pending'",
      [intent.id, (err as Error).message]
    );
    return res.status(202).json({ ok: true, status: "ambiguous", transactionId, message: "Payout status is uncertain. Check its AzamPay status before retrying." });
  }
});

const AZAMPAY_BANK_CODES = new Set(["ABSA","ACCESS","AKIBA","AMANA","AZANIA","BANCABC","BARODA","BOA","BOI","CANARA","CITI","CRDB","DASHENG","DCB","DTB","ECOBANK","EQUITY","EXIM","FNB","GT BANK","HABIB","ICB","IMBANK","KCB","KILIMANJARO","MAENDELEO","MKOMBOZI","MWALIMU","MWANGA","NBC","NCBA","NMB","PBZ","SCB","SELCOMPESA","STANBIC","TCB","UBA","UCHUMI","YETU"]);

azampayRoutes.put("/clients/:clientId/bank-details", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!["finance", "supervisor", "director", "ceo"].includes(actor.role)) return res.status(403).json({ message: "Only Finance or authorized managers may record customer bank details." });
  const clientId = Number(req.params.clientId);
  const bankCode = typeof req.body?.bankCode === "string" ? req.body.bankCode.trim().toUpperCase() : "";
  const accountNumber = typeof req.body?.accountNumber === "string" ? req.body.accountNumber.trim() : "";
  const accountName = typeof req.body?.accountName === "string" ? req.body.accountName.trim() : "";
  if (!Number.isInteger(clientId) || clientId < 1 || !AZAMPAY_BANK_CODES.has(bankCode) || !/^[A-Za-z0-9-]{5,40}$/.test(accountNumber) || accountName.length < 2 || accountName.length > 120) {
    return res.status(400).json({ message: "Enter a supported AzamPay bank code and valid account details." });
  }
  try {
    const saved = await pool.query(
      `UPDATE clients SET bank_code=$2,bank_account_number=$3,bank_account_name=$4,
              bank_details_submitted_by=$5,bank_details_verified_by=NULL,bank_details_verified_at=NULL
        WHERE id=$1 RETURNING id`,
      [clientId, bankCode, accountNumber, accountName, actor.id]
    );
    if (!saved.rowCount) return res.status(404).json({ message: "Customer record not found." });
    await audit(actor.username, "Customer bank details recorded for verification", String(clientId), `${bankCode}; account ending ${accountNumber.slice(-4)}`);
    return res.status(202).json({ ok: true, status: "awaiting_verification" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not save customer bank details." });
  }
});

azampayRoutes.post("/clients/:clientId/bank-details/verify", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!["finance", "supervisor", "director", "ceo"].includes(actor.role)) return res.status(403).json({ message: "Only Finance or authorized managers may verify customer bank details." });
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId) || clientId < 1) return res.status(400).json({ message: "Invalid customer record." });
  try {
    const verified = await pool.query(
      `UPDATE clients SET bank_details_verified_by=$2,bank_details_verified_at=now()
        WHERE id=$1 AND bank_code IS NOT NULL AND bank_account_number IS NOT NULL AND bank_account_name IS NOT NULL
          AND bank_details_submitted_by IS NOT NULL AND bank_details_submitted_by<>$2
        RETURNING id,bank_code,bank_account_number`,
      [clientId, actor.id]
    );
    if (!verified.rowCount) return res.status(409).json({ message: "Bank details must be recorded first and verified by a different staff member." });
    await audit(actor.username, "Customer bank details verified", String(clientId), `${verified.rows[0].bank_code}; account ending ${String(verified.rows[0].bank_account_number).slice(-4)}`);
    return res.json({ ok: true, status: "verified" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not verify customer bank details." });
  }
});

azampayRoutes.get("/loans/payouts/pending", requireAuth, async (_req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Payout reconciliation is restricted to Finance and authorized managers." });
  try {
    const { rows } = await pool.query(
      `SELECT p.id,p.loan_id AS "loanId",l.loan_number AS "loanNumber",c.full_name AS "clientName",p.provider,
              p.transaction_id AS "transactionId",p.amount,p.destination,p.destination_name AS "destinationName",p.status,
              p.provider_reference AS "providerReference",l.client_id AS "clientId",
              l.payout_reversal_review AS "reversalReview",l.payout_reversal_at AS "reversalAt",
              p.failure_message AS "failureMessage",p.created_at AS "createdAt"
         FROM loan_payout_intents p JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id
        WHERE p.status IN ('pending','ambiguous','reversed') ORDER BY p.created_at LIMIT 200`
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load pending payout transactions." });
  }
});

azampayRoutes.post("/loans/payouts/:transactionId/reconcile", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Only Finance and authorized managers can reconcile payouts." });
  const { rows } = await pool.query("SELECT * FROM loan_payout_intents WHERE transaction_id=$1", [req.params.transactionId]);
  const intent = rows[0];
  if (!intent) return res.status(404).json({ message: "Payout transaction not found." });
  if (!intent.provider_reference) return res.status(409).json({ message: "AzamPay has not returned a payout reference. Check the AzamPay dashboard; if no money was sent, close this payout." });
  try {
    const bankName = intent.destination_bank_code || "";
    const result: any = await azampayDisbursementStatus(intent.provider_reference, bankName);
    const details = Array.isArray(result) ? result[0] : result;
    const providerStatus = String(details?.transactionStatus ?? details?.status ?? details?.data?.transactionStatus ?? details?.data ?? "pending").toLowerCase();
    const status = ["success", "successful", "completed", "paid"].some(value => providerStatus.includes(value)) ? "completed" : ["failed", "failure", "rejected"].some(value => providerStatus.includes(value)) ? "failed" : "pending";
    if (status === "completed" && (!Number.isFinite(Number(details?.amount)) || Number(details.amount) !== Number(intent.amount))) {
      await pool.query("UPDATE loan_payout_intents SET status='ambiguous',failure_message=$2,updated_at=now() WHERE id=$1 AND status IN ('pending','ambiguous')", [intent.id, "AzamPay status omitted an exact payout amount; Finance review is required before loan activation."]);
      return res.status(409).json({ message: "AzamPay reported a successful transfer but did not return an amount to verify. Finance review is required." });
    }
    await applyPayoutStatus(intent.id, status, intent.provider_reference, actor.username);
    return res.json({ ok: true, status, message: status === "completed" ? "AzamPay confirmed the payout." : `AzamPay payout status: ${status}.` });
  } catch (err) {
    return res.status(502).json({ message: (err as Error).message || "Could not query AzamPay payout status." });
  }
});

azampayRoutes.post("/loans/payouts/:transactionId/close", requireAuth, async (req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!STAFF_ROLES.includes(actor.role)) return res.status(403).json({ message: "Only Finance and authorized managers can close payouts." });
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (note.length < 5 || note.length > 300) return res.status(400).json({ message: "Enter a note (5 to 300 characters) confirming that no money was sent." });
  try {
    const found = await pool.query("SELECT id, provider_reference, status FROM loan_payout_intents WHERE transaction_id=$1", [req.params.transactionId]);
    const intent = found.rows[0];
    if (!intent) return res.status(404).json({ message: "Payout transaction not found." });
    if (intent.provider_reference) return res.status(409).json({ message: "AzamPay has a reference for this payout. Use reconcile instead of closing it." });
    if (!["pending", "ambiguous"].includes(intent.status)) return res.status(409).json({ message: "This payout is not open." });
    await pool.query(
      "UPDATE loan_payout_intents SET status='failed', failure_message=$2, updated_at=now() WHERE id=$1",
      [intent.id, `Closed manually by ${actor.username}: ${note}`]
    );
    await audit(actor.username, "Payout closed manually", String(req.params.transactionId), note);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not close this payout." });
  }
});

async function applyPayoutStatus(intentId: number, status: string, reference: string, username: string) {
  if (!reference || !["pending", "completed", "failed", "reversed"].includes(status)) {
    throw new ReviewError("AzamPay returned an unsupported payout status or missing reference.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM loan_payout_intents WHERE id=$1 FOR UPDATE", [intentId]);
    const payout = found.rows[0];
    if (!payout) {
      await client.query("COMMIT");
      return;
    }

    if (status === "reversed") {
      // Handle reversals uniformly regardless of whether activation already occurred.
      // Never alter the loan state or repayment ledger here; retain the hold for Finance.
      if (payout.status === "reversed") {
        const held = await client.query("UPDATE loans SET payout_reversal_review=TRUE,payout_reversal_at=COALESCE(payout_reversal_at,now()),updated_at=now() WHERE id=$1 AND payout_reversal_review IS NOT TRUE RETURNING loan_number", [payout.loan_id]);
        if (held.rowCount) {
          const reason = payout.failure_message || "AzamPay reversed this payout; Finance review is required.";
          await client.query(
            "INSERT INTO audit_log (username,action,record,detail) VALUES ($1,'Loan payout reversal requires Finance review',$2,$3)",
            [username, String(held.rows[0].loan_number ?? payout.loan_id), `AzamPay payout ${reference}; ${reason} Loan status and repayment ledger were preserved.`]
          );
        }
        await client.query("COMMIT");
        return;
      }
      const afterActivation = payout.status === "paid";
      const reason = afterActivation
        ? "AzamPay reversed the completed payout; Finance review is required."
        : "AzamPay reversed the payout before loan activation; Finance review is required.";
      await client.query(
        "UPDATE loan_payout_intents SET status='reversed',failure_message=$2,provider_reference=COALESCE(provider_reference,$3),updated_at=now() WHERE id=$1",
        [payout.id, reason, reference]
      );
      const loanRow = await client.query("UPDATE loans SET payout_reversal_review=TRUE,payout_reversal_at=COALESCE(payout_reversal_at,now()),updated_at=now() WHERE id=$1 RETURNING loan_number", [payout.loan_id]);
      if (!loanRow.rowCount) throw new Error("Loan missing while recording AzamPay payout reversal.");
      await client.query(
        "INSERT INTO audit_log (username,action,record,detail) VALUES ($1,'Loan payout reversal requires Finance review',$2,$3)",
        [username, String(loanRow.rows[0].loan_number ?? payout.loan_id), `AzamPay payout ${reference}; ${reason} Loan status and repayment ledger were preserved.`]
      );
      await client.query("COMMIT");
      return;
    }
    if (payout.status === "paid") {
      await client.query("COMMIT");
      return;
    }
    if (payout.status === "reversed" && status === "completed") {
      // Late or repeated "completed" for a payout already reversed: ignore.
      await client.query("COMMIT");
      return;
    }

    if (status === "completed") {
      const terms = calculateRepaymentTerms(Number(payout.principal_amount ?? payout.amount));
      const updated = await client.query(
        `UPDATE loans SET stage='repayment',status='active',transfer_reference=$2,disbursed_amount=$3,disbursed_at=now(),
          principal_amount=$4,savings_amount=$5,savings_rate=.05,processing_fee_amount=$6,processing_fee_rate=.10,
          interest_amount=$7,weekly_interest_rate=.0475,installment_count=$8,weekly_installment_amount=$9,
          final_installment_amount=$10,amount_due=$11,amount_paid=0,arrears=0,repayment_performance=0,
          balance=$11,first_due_date=$12,next_due_date=$12,updated_at=now()
         WHERE id=$1 AND stage='disbursement' AND status='in_progress' RETURNING loan_number`,
        [payout.loan_id, reference, payout.amount, terms.principalAmount, terms.savingsAmount, terms.processingFeeAmount, terms.interestAmount, terms.installmentCount, terms.weeklyInstallmentAmount, terms.finalInstallmentAmount, terms.amountDue, payout.next_due_date]
      );
      if (!updated.rowCount) throw new Error("Loan changed before AzamPay payout confirmation.");
      await client.query("UPDATE loan_payout_intents SET status='paid',provider_reference=$2,paid_at=now(),updated_at=now() WHERE id=$1", [payout.id, reference]);
      await client.query("INSERT INTO audit_log (username,action,record,detail) VALUES ($1,'Loan payout confirmed',$2,$3)", [username, updated.rows[0].loan_number, `AzamPay payout ${reference}; TZS ${payout.amount}`]);
      await client.query("COMMIT");
      return;
    }

    if (["failed", "reversed"].includes(status)) {
      await client.query(
        "UPDATE loan_payout_intents SET status=$2,failure_message=$3,provider_reference=COALESCE(provider_reference,$4),updated_at=now() WHERE id=$1",
        [payout.id, status, status === "reversed" ? "AzamPay reversed this payout before loan activation; Finance review is required." : "AzamPay reported this payout failed.", reference]
      );
    } else {
      await client.query("UPDATE loan_payout_intents SET status='pending',provider_reference=COALESCE(provider_reference,$2),updated_at=now() WHERE id=$1", [payout.id, reference]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

azampayRoutes.post("/webhooks/azampay", async (req: Request & { rawBody?: Buffer }, res) => {
  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const callback = req.body as Record<string, any>;
  const signatureValid = rawBody.length > 0 && await verifyAzamPayCallback(callback ?? {});
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const reference = String(callback?.utilityref ?? callback?.transid ?? "").slice(0, 200);
  const externalId = String(callback?.externalreference ?? "").slice(0, 200);
  const statusText = String(callback?.transactionstatus ?? "").toLowerCase();
  const eventType = statusText.slice(0, 120) || "unknown";
  if (!signatureValid) {
    try {
      await pool.query(`INSERT INTO azampay_webhook_events (event_id,event_type,provider_reference,signature_valid,processing_status,payload_sha256,failure_message)
        VALUES ($1,$2,$3,FALSE,'invalid',$4,'AzamPay RSA signature verification failed') ON CONFLICT (event_id) DO NOTHING`,
        [payloadHash, eventType, reference || null, payloadHash]);
    } catch (err) { console.error("Could not persist invalid AzamPay callback", err); }
    return res.status(401).json({ message: "Invalid AzamPay callback signature." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inbox = await client.query(`INSERT INTO azampay_webhook_events (deduplication_key,event_id,event_type,provider_reference,signature_valid,processing_status,payload_sha256)
      VALUES ($1,$2,$3,$4,TRUE,'processing',$5) ON CONFLICT DO NOTHING RETURNING id`,
      [`callback:${payloadHash}`, payloadHash, eventType, reference || null, payloadHash]);
    if (!inbox.rowCount) { await client.query("COMMIT"); return res.json({ ok: true, duplicate: true }); }
    await client.query("COMMIT");

    const success = ["success", "successful", "completed", "paid"].includes(statusText);
    const failure = ["failed", "failure", "rejected", "cancelled", "canceled"].includes(statusText);
    let disposition = "ignored";
    if (externalId.startsWith("BMLP")) {
      const found = await pool.query("SELECT id,amount FROM loan_payout_intents WHERE transaction_id=$1", [externalId]);
      if (found.rowCount && success && Number(callback.amount) === Number(found.rows[0].amount)) {
        await applyPayoutStatus(found.rows[0].id, "completed", reference || externalId, "azampay-webhook"); disposition = "processed";
      } else if (found.rowCount && failure) {
        await applyPayoutStatus(found.rows[0].id, "failed", reference || externalId, "azampay-webhook"); disposition = "processed";
      } else disposition = "needs_review";
    } else {
      const found = await pool.query("SELECT * FROM loan_payment_intents WHERE provider='azampay' AND provider_order_id=$1", [externalId]);
      const intent = found.rows[0];
      if (!intent || !reference || Number(callback.amount) !== Number(intent.amount)) disposition = "needs_review";
      else if (success) {
        try { await settleCompletedPayment(intent.id, reference, String(callback.operator ?? "mobile_money")); disposition = "processed"; }
        catch (err) { if (err instanceof ReviewError) { await markNeedsReview(intent.id, err.message); disposition = "needs_review"; } else throw err; }
      } else if (failure) {
        await pool.query("UPDATE loan_payment_intents SET status='failed',failure_message=$2,updated_at=now() WHERE id=$1 AND status IN ('pending','ambiguous')", [intent.id, `AzamPay status: ${statusText}`]); disposition = "processed";
      }
    }
    await pool.query("UPDATE azampay_webhook_events SET processing_status=$2,failure_message=$3 WHERE event_id=$1", [payloadHash, disposition, disposition === "needs_review" ? "Callback did not match a payment attempt exactly." : null]);
    return res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(err);
    return res.status(500).json({ message: "Could not process AzamPay callback." });
  } finally { client.release(); }
});

/* ------------------------------------------------------------------ */
/* Customer loan accounts                                              */
/* ------------------------------------------------------------------ */

azampayRoutes.get("/customer/loans", requireAuth, async (_req, res) => {
  const user = res.locals.user as JwtUser;
  if (user.role !== "customer") return res.status(403).json({ message: "Only customers can view loan accounts." });
  try {
    const { rows } = await pool.query(
      `SELECT l.id,l.loan_number AS "loanNumber",l.product,l.principal_amount AS "principalAmount",l.amount_due AS "amountDue",
        l.savings_amount AS "savingsAmount",l.savings_rate AS "savingsRate",l.processing_fee_amount AS "processingFeeAmount",
        l.processing_fee_rate AS "processingFeeRate",l.interest_amount AS "interestAmount",l.installment_count AS "installmentCount",
        l.weekly_interest_rate AS "weeklyInterestRate",l.weekly_installment_amount AS "weeklyInstallmentAmount",
        l.final_installment_amount AS "finalInstallmentAmount",l.amount_paid AS "amountPaid",l.balance AS "outstandingBalance",
        l.repayment_performance AS "repaymentPerformance",l.arrears,l.stage,l.transfer_reference AS "transferReference",l.status AS "loanStatus",
        l.next_due_date AS "nextDueDate" FROM loans l JOIN clients c ON c.id=l.client_id WHERE c.user_id=$1 ORDER BY l.created_at DESC`,
      [user.id]
    );
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load loan accounts." });
  }
});

return azampayRoutes;
}

export const azampayRoutes = createAzamPayRouter();
