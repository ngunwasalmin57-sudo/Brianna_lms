import { Router, Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import { pool as defaultPool } from "../db";
import { requireAuth as defaultRequireAuth, JwtUser } from "../auth";
import { audit as defaultAudit } from "../audit";
import { config } from "../config";
import { SnippeError, snippeRequest as defaultSnippeRequest, verifySnippeWebhook as defaultVerifyWebhook } from "../snippe";
import { calculateRepaymentTerms } from "../repaymentTerms";

type Dependencies = { pool?: typeof defaultPool; request?: typeof defaultSnippeRequest; verifyWebhook?: typeof defaultVerifyWebhook; authenticate?: typeof defaultRequireAuth; auditEvent?: typeof defaultAudit };
const amountValue = (value: any) => typeof value === "object" && value !== null ? Number(value.value) : Number(value);

export function createSnippeRouter(deps: Dependencies = {}) {
  const router = Router();
  const pool = deps.pool ?? defaultPool;
  const request = deps.request ?? defaultSnippeRequest;
  const verify = deps.verifyWebhook ?? defaultVerifyWebhook;
  const authenticate = deps.authenticate ?? defaultRequireAuth;
  const audit = deps.auditEvent ?? defaultAudit;
  const auth = Router(); auth.use(authenticate);

  auth.get("/customer/payment-intents", async (_req, res) => {
    const user = res.locals.user as JwtUser;
    try {
      const { rows } = await pool.query(`SELECT i.id,i.loan_id AS "loanId",l.loan_number AS "loanNumber",i.provider_order_id AS "orderId",i.gateway_reference AS "gatewayReference",i.amount,i.provider,i.status,i.checkout_url AS "checkoutUrl",i.payment_method AS "paymentMethod",i.qr_code AS "qrCode",i.created_at AS "createdAt" FROM loan_payment_intents i JOIN loans l ON l.id=i.loan_id WHERE i.customer_id=$1 AND i.provider='snippe' ORDER BY i.created_at DESC LIMIT 30`, [user.id]);
      res.json(rows);
    } catch (error) { console.error(error); res.status(500).json({ message: "Could not load payment requests." }); }
  });

  auth.post("/customer/loans/:loanId/payment-intents", async (req, res) => {
    const user = res.locals.user as JwtUser;
    const loanId = Number(req.params.loanId), amount = Number(req.body?.amount);
    const mobile = String(req.body?.mobile ?? "").replace(/[\s()+-]/g, "");
    if (user.role !== "customer") return res.status(403).json({ message: "Customer repayments are only available in the customer portal." });
    if (!Number.isSafeInteger(loanId) || loanId < 1 || !Number.isSafeInteger(amount) || amount < 500 || !/^255\d{9}$/.test(mobile)) return res.status(400).json({ message: "Enter a valid amount (minimum TZS 500) and Tanzanian mobile number." });
    if (!config.snippeEnabled) return res.status(503).json({ message: "Snippe payments are not configured yet. Contact BML." });
    const orderId = `BML-${randomUUID()}`;
    try {
      const owned = await pool.query(`SELECT l.id,l.client_id,l.loan_number,l.balance,l.status,l.payout_reversal_review,c.full_name AS customer_name,u.email AS customer_email FROM loans l JOIN clients c ON c.id=l.client_id JOIN users u ON u.id=c.user_id WHERE l.id=$1 AND c.user_id=$2`, [loanId, user.id]);
      const loan = owned.rows[0];
      if (!loan) return res.status(404).json({ message: "Loan not found." });
      if (loan.status !== "active" || loan.payout_reversal_review || amount > Number(loan.balance)) return res.status(409).json({ message: "This amount cannot be applied to the current loan balance." });
      if (!String(loan.customer_email ?? "").includes("@")) return res.status(409).json({ message: "Add a valid email address to your customer profile before making a Snippe payment." });
      const open = await pool.query("SELECT 1 FROM loan_payment_intents WHERE loan_id=$1 AND status IN ('pending','ambiguous','needs_review')", [loanId]);
      if (open.rowCount) return res.status(409).json({ message: "A payment request is already open for this loan. Check its status before retrying." });
      const inserted = await pool.query(`INSERT INTO loan_payment_intents(loan_id,customer_id,client_id,provider,provider_order_id,amount,payment_method) VALUES($1,$2,$3,'snippe',$4,$5,'push') RETURNING id`, [loanId, user.id, loan.client_id, orderId, amount]);
      try {
        const customerName = String(loan.customer_name ?? "Customer").trim().split(/\s+/);
        const result: any = await request("/v1/payments", { method: "POST", headers: { "Idempotency-Key": `bmlpay${inserted.rows[0].id}` }, body: JSON.stringify({ payment_type: "mobile", details: { amount, currency: "TZS" }, phone_number: mobile, customer: { firstname: customerName[0], lastname: customerName.slice(1).join(" ") || customerName[0], email: loan.customer_email }, webhook_url: config.snippeWebhookUrl, metadata: { order_id: orderId, loan_number: loan.loan_number } }) });
        const data = result?.data ?? result;
        const reference = String(data?.reference ?? "");
        if (!reference) throw new Error("Snippe response did not include a payment reference.");
        await pool.query("UPDATE loan_payment_intents SET gateway_reference=$2,updated_at=now() WHERE id=$1", [inserted.rows[0].id, reference]);
        return res.status(201).json({ intentId: inserted.rows[0].id, orderId, provider: "snippe", status: "pending", amount, reference, paymentMethod: "push", message: "Snippe sent a payment request to your phone. Approve it there; your balance updates after confirmation." });
      } catch (error) {
        const definite = error instanceof SnippeError && !!error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500;
        await pool.query("UPDATE loan_payment_intents SET status=$2,failure_message=$3,updated_at=now() WHERE id=$1", [inserted.rows[0].id, definite ? "failed" : "ambiguous", (error as Error).message]);
        return res.status(definite ? error.httpStatus ?? 502 : 202).json({ intentId: inserted.rows[0].id, orderId, provider: "snippe", status: definite ? "failed" : "ambiguous", amount, message: definite ? (error as Error).message : "Payment status is uncertain. Check its status before retrying." });
      }
    } catch (error) { console.error(error); return res.status(500).json({ message: "Could not start the payment request." }); }
  });

  auth.post("/loans/:id/payout", async (req, res) => {
    const user = res.locals.user as JwtUser;
    const id = Number(req.params.id), amount = Number(req.body?.amount);
    const provider = String(req.body?.provider ?? "");
    const destination = String(req.body?.destination ?? "").replace(/[\s()+-]/g, "");
    const name = String(req.body?.destinationName ?? "").trim();
    const dueDate = String(req.body?.nextDueDate ?? "");
    if (!["finance", "supervisor", "director", "ceo"].includes(user.role)) return res.status(403).json({ message: "Your role cannot initiate loan payouts." });
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amount) || amount < 500 || !["snippe_mobile", "snippe_bank"].includes(provider) || destination.length < 5 || name.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ message: "Enter valid payout details and an amount of at least TZS 500." });
    if (!config.snippeEnabled) return res.status(503).json({ message: "Snippe payouts are not configured." });
    try {
      const found = await pool.query("SELECT l.id,l.loan_number,l.stage,l.status,l.principal_amount,l.amount_due,l.payout_reversal_review,c.phone AS client_phone,c.bank_code,c.bank_account_number,c.bank_account_name,c.bank_details_submitted_by,c.bank_details_verified_by,c.bank_details_verified_at FROM loans l JOIN clients c ON c.id=l.client_id WHERE l.id=$1", [id]);
      const loan = found.rows[0];
      if (!loan || loan.stage !== "disbursement" || loan.status !== "in_progress") return res.status(409).json({ message: "This loan is not ready for payout." });
      if (loan.payout_reversal_review) return res.status(409).json({ message: "This loan is frozen for Finance review after a reversed payout." });
      if (provider === "snippe_mobile" && String(loan.client_phone ?? "").replace(/\D/g, "") !== destination) return res.status(400).json({ message: "The mobile number must match the customer's registered number." });
      if (provider === "snippe_bank" && (!loan.bank_details_verified_at || Number(loan.bank_details_submitted_by) === Number(loan.bank_details_verified_by) || Number(loan.bank_details_verified_by) === Number(user.id) || destination !== String(loan.bank_account_number ?? "") || String(req.body?.bankCode ?? "") !== String(loan.bank_code ?? ""))) return res.status(400).json({ message: "Use the customer's verified bank account before sending a payout." });
      const pending = await pool.query("SELECT 1 FROM loan_payout_intents WHERE loan_id=$1 AND status IN ('pending','ambiguous')", [id]);
      if (pending.rowCount) return res.status(409).json({ message: "A payout is already pending for this loan." });
      const terms = calculateRepaymentTerms(Number(loan.principal_amount ?? loan.amount_due));
      if (amount !== terms.principalAmount) return res.status(400).json({ message: "Payout amount must match the approved principal." });
      const disbursementAmount = terms.netDisbursedAmount;
      const feeQuoteResult: any = await request(`/v1/payouts/fee?amount=${disbursementAmount}`);
      const quote = feeQuoteResult?.data ?? feeQuoteResult;
      const fee = Number(quote?.fee_amount), totalDebit = Number(quote?.total_amount);
      if (quote?.currency !== "TZS" || Number(quote?.amount) !== disbursementAmount || !Number.isFinite(fee) || fee < 0 || totalDebit !== disbursementAmount + fee) return res.status(502).json({ message: "Snippe returned an invalid payout fee quote." });
      const transactionId = randomUUID();
      const inserted = await pool.query(`INSERT INTO loan_payout_intents(loan_id,initiated_by,provider,transaction_id,amount,principal_amount,destination,destination_name,destination_bank_code,next_due_date,currency,fee_amount,total_debit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TZS',$11,$12) RETURNING id`, [id,user.id,provider,transactionId,disbursementAmount,terms.principalAmount,destination,name,provider === "snippe_bank" ? req.body?.bankCode ?? null : null,dueDate,fee,totalDebit]);
      const payload = provider === "snippe_mobile" ? { amount: disbursementAmount, channel: "mobile", recipient_phone: destination, recipient_name: name, webhook_url: config.snippeWebhookUrl, narration: `Loan ${loan.loan_number}`, metadata: { payout_id: String(inserted.rows[0].id), loan_number: loan.loan_number } } : { amount: disbursementAmount, channel: "bank", recipient_bank: String(req.body?.bankCode ?? ""), recipient_account: destination, recipient_name: name, webhook_url: config.snippeWebhookUrl, narration: `Loan ${loan.loan_number}`, metadata: { payout_id: String(inserted.rows[0].id), loan_number: loan.loan_number } };
      try {
        const result: any = await request("/v1/payouts/send", { method: "POST", headers: { "Idempotency-Key": `bmlpayout${inserted.rows[0].id}` }, body: JSON.stringify(payload) });
        const data = result?.data ?? result;
        const reference = String(data?.reference ?? data?.id ?? "");
        await pool.query("UPDATE loan_payout_intents SET provider_reference=$2,status='pending',updated_at=now() WHERE id=$1", [inserted.rows[0].id, reference || null]);
        return res.status(202).json({ ok: true, status: "pending", transactionId, message: "Snippe payout submitted. The loan activates after Snippe confirms delivery." });
      } catch (error) {
        const definite = error instanceof SnippeError && !!error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500;
        await pool.query("UPDATE loan_payout_intents SET status=$2,failure_message=$3,updated_at=now() WHERE id=$1", [inserted.rows[0].id, definite ? "failed" : "ambiguous", (error as Error).message]);
        return res.status(definite ? error.httpStatus ?? 502 : 202).json({ ok: true, status: definite ? "failed" : "ambiguous", transactionId, message: definite ? (error as Error).message : "Payout status is uncertain. Check it before retrying." });
      }
    } catch (error) { console.error(error); return res.status(500).json({ message: "Could not submit the payout." }); }
  });

  auth.get("/loans/payouts/pending", async (req, res) => {
    const user = res.locals.user as JwtUser;
    if (!["finance", "supervisor", "director", "ceo"].includes(user.role)) return res.status(403).json({ message: "Your role cannot view payouts." });
    try { const { rows } = await pool.query(`SELECT p.id,p.loan_id AS "loanId",p.transaction_id AS "transactionId",p.provider,p.amount,p.destination,p.destination_name AS "destinationName",p.status,p.provider_reference AS "providerReference",p.created_at AS "createdAt",c.full_name AS "clientName",l.loan_number AS "loanNumber",l.payout_reversal_review AS "reversalReview" FROM loan_payout_intents p JOIN loans l ON l.id=p.loan_id JOIN clients c ON c.id=l.client_id WHERE p.status IN ('pending','ambiguous','reversed') ORDER BY p.created_at DESC LIMIT 100`); res.json(rows); }
    catch (error) { console.error(error); res.status(500).json({ message: "Could not load pending payouts." }); }
  });

  auth.post("/loans/payouts/:transactionId/reconcile", async (req, res) => {
    const user = res.locals.user as JwtUser;
    if (!["finance", "supervisor", "director", "ceo"].includes(user.role)) return res.status(403).json({ message: "Your role cannot reconcile payouts." });
    try {
      const found = await pool.query("SELECT id,provider_reference FROM loan_payout_intents WHERE transaction_id=$1 AND provider IN ('snippe_mobile','snippe_bank')", [req.params.transactionId]);
      const payout = found.rows[0]; if (!payout?.provider_reference) return res.status(409).json({ message: "Snippe has not returned a payout reference. Check the Snippe dashboard before retrying." });
      const result: any = await request(`/v1/payouts/${encodeURIComponent(payout.provider_reference)}`);
      const data = result?.data ?? result, status = String(data?.status ?? "pending").toLowerCase();
      if (status === "completed") await settlePayout(payout.id, payout.provider_reference, data);
      else if (["failed", "reversed"].includes(status)) await pool.query("UPDATE loan_payout_intents SET status=$2,failure_message=$3,updated_at=now() WHERE id=$1", [payout.id,status,String(data?.failure_reason ?? `Snippe payout ${status}.`)]);
      return res.json({ ok: true, status, message: `Snippe payout status: ${status}.` });
    } catch (error) { console.error(error); res.status(502).json({ message: "Could not query Snippe payout status." }); }
  });

  router.post("/webhooks/snippe", async (req: Request, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const payload = req.body ?? {};
    const valid = await verify(payload, req.headers as any, raw);
    const digest = createHash("sha256").update(raw ?? Buffer.from(JSON.stringify(payload))).digest("hex");
    const type = String(payload.type ?? payload.event ?? ""), data = payload.data ?? payload;
    const reference = String(data.reference ?? "");
    if (!valid) {
      await pool.query(`INSERT INTO snippe_webhook_events(event_type,provider_reference,signature_valid,processing_status,payload_sha256,failure_message) VALUES($1,$2,false,'invalid',$3,'Invalid Snippe signature')`, [type,reference,digest]).catch(() => undefined);
      return res.status(401).json({ message: "Invalid Snippe webhook signature." });
    }
    const eventId = String(payload.id ?? "");
    const key = eventId ? `event:${eventId}` : `payload:${digest}`;
    try {
      const inbox = await pool.query(`INSERT INTO snippe_webhook_events(deduplication_key,event_id,event_type,provider_reference,signature_valid,processing_status,payload_sha256) VALUES($1,$2,$3,$4,true,'processing',$5) ON CONFLICT DO NOTHING RETURNING id`, [key,eventId || null,type,reference,digest]);
      if (!inbox.rowCount) return res.json({ ok: true, duplicate: true });
      let status = "processed";
      if (type.startsWith("payment.")) {
        const intentResult = await pool.query("SELECT * FROM loan_payment_intents WHERE provider='snippe' AND (gateway_reference=$1 OR provider_order_id=$2) ORDER BY id DESC LIMIT 1", [reference,String(data.external_reference ?? data.metadata?.order_id ?? "")]);
        const intent = intentResult.rows[0];
        if (!intent) status = "ignored";
        else if (type === "payment.completed") {
          const paid = amountValue(data.amount);
          if (!Number.isFinite(paid) || paid !== Number(intent.amount) || (data.amount?.currency && data.amount.currency !== "TZS")) {
            await pool.query("UPDATE loan_payment_intents SET status='needs_review',failure_message='Snippe amount or currency mismatch',updated_at=now() WHERE id=$1 AND status <> 'paid'", [intent.id]); status = "needs_review";
          } else {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const existing = await client.query("SELECT id,loan_id,amount,payment_intent_id FROM loan_payments WHERE provider='snippe' AND provider_transaction_id=$1 FOR UPDATE", [reference]);
              if (existing.rowCount && (Number(existing.rows[0].loan_id) !== Number(intent.loan_id) || Number(existing.rows[0].amount) !== Number(intent.amount) || Number(existing.rows[0].payment_intent_id) !== Number(intent.id))) {
                await client.query("UPDATE loan_payment_intents SET status='needs_review',failure_message='Snippe reference is already linked to another repayment',updated_at=now() WHERE id=$1 AND status <> 'paid'", [intent.id]);
                status = "needs_review";
              } else if (!existing.rowCount) {
                const posted = await client.query(`INSERT INTO loan_payments(loan_id,amount,reference,provider,provider_transaction_id,payment_intent_id) VALUES($1,$2,$3,'snippe',$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [intent.loan_id,intent.amount,reference,reference,intent.id]);
                if (posted.rowCount) {
                const changed = await client.query("UPDATE loans SET balance=GREATEST(balance-$2,0),amount_paid=COALESCE(amount_paid,0)+$2,status=CASE WHEN balance-$2<=0 THEN 'closed' ELSE status END,updated_at=now() WHERE id=$1 RETURNING id", [intent.loan_id,intent.amount]);
                if (!changed.rowCount) throw new Error("Loan not found while posting Snippe repayment.");
                }
              }
              if (status !== "needs_review") await client.query("UPDATE loan_payment_intents SET status='paid',gateway_reference=COALESCE(gateway_reference,$2),provider_transaction_id=$2,channel=$3,paid_at=now(),updated_at=now() WHERE id=$1", [intent.id,reference,data.channel?.provider ?? null]);
              await client.query("COMMIT");
              await audit("snippe-webhook", "Snippe repayment credited", String(intent.loan_id), `Reference ${reference}; TZS ${intent.amount}`);
            } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
          }
        } else if (["payment.failed","payment.voided","payment.expired"].includes(type)) await pool.query("UPDATE loan_payment_intents SET status='failed',failure_message=$2,updated_at=now() WHERE id=$1 AND status IN ('pending','ambiguous')", [intent.id,String(data.failure_reason ?? type)]);
      } else if (type.startsWith("payout.")) {
        const payoutResult = await pool.query("SELECT * FROM loan_payout_intents WHERE provider_reference=$1 OR transaction_id=$2 ORDER BY id DESC LIMIT 1", [reference,String(data.external_reference ?? data.metadata?.payout_id ?? "")]);
        const payout = payoutResult.rows[0];
        if (!payout) status = "ignored";
        else if (type === "payout.completed") await settlePayout(payout.id,reference,data);
        else if (type === "payout.reversed") {
          await pool.query("UPDATE loan_payout_intents SET status='reversed',failure_message='Snippe reversed this payout',updated_at=now() WHERE id=$1", [payout.id]);
          const held = await pool.query("UPDATE loans SET payout_reversal_review=true,payout_reversal_at=now() WHERE id=$1 AND payout_reversal_review=false RETURNING loan_number", [payout.loan_id]);
          if (held.rowCount) await pool.query("INSERT INTO audit_log(username,action,record,detail) VALUES('snippe-webhook','Loan payout reversal requires Finance review',$1,$2)", [held.rows[0].loan_number, `Snippe payout ${reference} reversed. Loan status and repayment ledger were preserved.`]);
        } else await pool.query("UPDATE loan_payout_intents SET status='failed',failure_message=$2,updated_at=now() WHERE id=$1", [payout.id,String(data.failure_reason ?? "Snippe payout failed.")]);
      } else status = "ignored";
      await pool.query("UPDATE snippe_webhook_events SET processing_status=$2 WHERE deduplication_key=$1", [key,status]);
      return res.json({ ok: true });
    } catch (error) {
      console.error("Snippe webhook processing failed", error);
      await pool.query("UPDATE snippe_webhook_events SET processing_status='failed',failure_message=$2 WHERE deduplication_key=$1", [key,(error as Error).message]).catch(() => undefined);
      return res.status(500).json({ message: "Snippe webhook processing failed." });
    }
  });

  async function settlePayout(payoutId: number, reference: string, data: any) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query("SELECT * FROM loan_payout_intents WHERE id=$1 FOR UPDATE", [payoutId]);
      const p = found.rows[0]; if (!p || p.status === "paid") { await client.query("COMMIT"); return; }
      const actual = amountValue(data.amount);
      if (!Number.isFinite(actual) || data.amount?.currency !== "TZS" || actual !== Number(p.amount)) {
        await client.query("UPDATE loan_payout_intents SET status='ambiguous',failure_message=$2,updated_at=now() WHERE id=$1", [p.id,"Snippe payout completion omitted the exact TZS amount; Finance review is required."]);
        await client.query("COMMIT");
        return;
      }
      const due = String(p.next_due_date).slice(0,10);
      const terms = calculateRepaymentTerms(Number(p.principal_amount));
      await client.query(`UPDATE loans SET stage='repayment',status='active',principal_amount=$2,amount_due=$3,balance=$3,amount_paid=0,first_due_date=$4,next_due_date=$4,weekly_installment_amount=$5,final_installment_amount=$6,installment_count=$7,transfer_reference=$8,disbursed_amount=$9,disbursed_at=now(),updated_at=now() WHERE id=$1`, [p.loan_id,p.principal_amount,terms.amountDue,due,terms.weeklyInstallmentAmount,terms.finalInstallmentAmount,terms.installmentCount,reference,p.amount]);
      await client.query("UPDATE loan_payout_intents SET status='paid',provider_reference=$2,paid_at=now(),updated_at=now() WHERE id=$1", [p.id,reference]);
      await client.query("INSERT INTO audit_log(username,action,record,detail) SELECT 'snippe-webhook','Loan payout confirmed',loan_number,$2 FROM loans WHERE id=$1", [p.loan_id,`Snippe confirmed payout ${reference}; TZS ${p.amount}`]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  return router;
}

export const snippeRoutes = createSnippeRouter();
