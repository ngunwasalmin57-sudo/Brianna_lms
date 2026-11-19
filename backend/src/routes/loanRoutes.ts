import { Router } from "express";
import { randomUUID } from "crypto";
import { pool as defaultPool } from "../db";
import { audit as defaultAudit } from "../audit";
import { requireAuth as defaultRequireAuth, JwtUser } from "../auth";

type LoanRouteDependencies = {
  pool?: typeof defaultPool;
  auditEvent?: typeof defaultAudit;
  authenticate?: typeof defaultRequireAuth;
};

export function createLoanRouter(dependencies: LoanRouteDependencies = {}) {
const loanRoutes = Router();
const pool = dependencies.pool ?? defaultPool;
const audit = dependencies.auditEvent ?? defaultAudit;
const requireAuth = dependencies.authenticate ?? defaultRequireAuth;
loanRoutes.use(requireAuth);

const loanSelect = `SELECT l.id, l.loan_number AS "loanNumber", l.client_id AS "clientId",
  c.full_name AS "clientName", c.phone AS "clientPhone", c.business_type AS "businessType",
  c.business_location AS "businessLocation", l.product, l.stage, l.status, l.principal_amount AS "principalAmount",
  l.amount_due AS "amountDue", l.amount_paid AS "amountPaid", l.repayment_performance AS "repaymentPerformance", l.balance,
  l.savings_amount AS "savingsAmount", l.processing_fee_amount AS "processingFeeAmount", l.interest_amount AS "interestAmount",
  l.savings_rate AS "savingsRate", l.processing_fee_rate AS "processingFeeRate", l.weekly_interest_rate AS "weeklyInterestRate",
  l.installment_count AS "installmentCount", l.weekly_installment_amount AS "weeklyInstallmentAmount", l.final_installment_amount AS "finalInstallmentAmount",
  l.next_due_date AS "nextDueDate", l.transfer_reference AS "transferReference", l.disbursed_amount AS "disbursedAmount",
  COALESCE(l.arrears, 0) AS arrears,
  CASE WHEN COALESCE(l.first_due_date, l.next_due_date) <= CURRENT_DATE THEN GREATEST((CASE
    WHEN l.first_due_date IS NULL THEN COALESCE(l.weekly_installment_amount, l.amount_due, 0)
    WHEN LEAST(l.installment_count, FLOOR((CURRENT_DATE - l.first_due_date)::numeric / 7)::int + 1) >= l.installment_count THEN COALESCE(l.amount_due, 0)
    ELSE LEAST(l.installment_count, FLOOR((CURRENT_DATE - l.first_due_date)::numeric / 7)::int + 1) * COALESCE(l.weekly_installment_amount, 0)
  END) - COALESCE(l.amount_paid, 0), 0) ELSE 0 END AS "overdueAmount",
  (SELECT MAX(p.received_at) FROM loan_payments p WHERE p.loan_id = l.id) AS "paymentDate",
  l.created_at AS "createdAt", l.updated_at AS "updatedAt", l.officer_id AS "officerId",
  COALESCE(u.full_name, 'Unassigned') AS "officerName", COALESCE(u.phone, '') AS "officerPhone"
  FROM loans l JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.officer_id`;

loanRoutes.get("/decisions", async (_req, res) => {
  const actor = res.locals.user as JwtUser;
  if (actor.role !== "committee") return res.status(403).json({ message: "Committee decision records are restricted to Credit Committee members." });
  try {
    const result = await pool.query(
      `SELECT d.id, d.loan_id AS "loanId", l.loan_number AS "loanNumber", c.full_name AS "clientName",
              l.product, COALESCE(l.principal_amount, l.amount_due, 0) AS amount,
              d.decision, d.rationale, COALESCE(u.full_name, u.username) AS "decidedBy",
              d.decided_at AS "decidedAt", COALESCE(s.full_name, s.username) AS "signedBy", d.signed_at AS "signedAt"
         FROM loan_decision_records d
         JOIN loans l ON l.id = d.loan_id
         JOIN clients c ON c.id = l.client_id
         JOIN users u ON u.id = d.reviewer_id
         LEFT JOIN users s ON s.id = d.signer_id
        ORDER BY d.decided_at DESC, d.id DESC LIMIT 500`
    );
    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not load committee decision records." });
  }
});

loanRoutes.get("/", async (_req, res) => {
  const actor = res.locals.user as JwtUser;
  if (!["loan_officer", "supervisor", "committee", "finance", "management", "director", "ceo"].includes(actor.role)) return res.status(403).json({ message: "Your role cannot view loan records." });
  try {
    const zoneFilter = actor.role === "supervisor" ? `WHERE EXISTS (SELECT 1 FROM loan_groups lg JOIN supervisor_zones sz ON lower(sz.zone)=lower(lg.zone) WHERE lg.officer_id=l.officer_id AND sz.supervisor_id=$1)` : "";
    const result = await pool.query(
      `${loanSelect} ${actor.role === "loan_officer" ? "WHERE l.officer_id = $1" : zoneFilter} ORDER BY l.updated_at DESC, l.id DESC LIMIT 500`,
      [actor.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load loan records." });
  }
});

loanRoutes.post("/:id/action", async (req, res) => {
  const actor = res.locals.user as JwtUser;
  const id = Number(req.params.id);
  const { action, amount, reference, decisionNote, electronicSignature } = req.body ?? {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Invalid loan record." });
  try {
    const result = await pool.query(
      "SELECT id, officer_id, stage, status, balance, principal_amount, amount_due, amount_paid, loan_number FROM loans WHERE id = $1",
      [id]
    );
    const loan = result.rows[0];
    if (!loan) return res.status(404).json({ message: "Loan record not found." });
    if (actor.role === "loan_officer" && loan.officer_id !== actor.id) return res.status(403).json({ message: "You can only update loans assigned to you." });

    let nextStage: string | undefined;
    let detail = "";
    if (action === "submit") {
      if (actor.role !== "loan_officer" || loan.stage !== "assessment") return res.status(403).json({ message: "This loan cannot be submitted by your role." });
      nextStage = "verification"; detail = "Submitted for supervisor verification";
    } else if (action === "verify") {
      if (actor.role !== "supervisor" || loan.stage !== "verification") return res.status(403).json({ message: "This loan is not available for supervisor verification." });
      const assigned = await pool.query(`SELECT 1 FROM loans l JOIN loan_groups lg ON lg.officer_id=l.officer_id JOIN supervisor_zones sz ON lower(sz.zone)=lower(lg.zone) WHERE l.id=$1 AND sz.supervisor_id=$2 LIMIT 1`, [id, actor.id]);
      if (!assigned.rowCount) return res.status(403).json({ message: "This loan is outside your assigned zones." });
      nextStage = "approval"; detail = "Verified and sent to Credit Committee";
    } else if (action === "approve") {
      if (actor.role !== "committee" || loan.stage !== "approval") return res.status(403).json({ message: "This loan is not available for committee approval." });
      if (typeof decisionNote !== "string" || decisionNote.trim().length < 10 || decisionNote.trim().length > 1000) return res.status(400).json({ message: "Enter a decision rationale between 10 and 1000 characters." });
      if (electronicSignature !== true) return res.status(400).json({ message: "Electronic signing is required." });
      nextStage = "disbursement"; detail = `Approved by Credit Committee; rationale: ${decisionNote.trim()}`;
    } else if (action === "return") {
      if (!["supervisor", "committee"].includes(actor.role) || !["verification", "approval"].includes(loan.stage)) return res.status(403).json({ message: "This loan cannot be returned by your role." });
      if (actor.role === "committee" && (typeof decisionNote !== "string" || decisionNote.trim().length < 10 || decisionNote.trim().length > 1000)) return res.status(400).json({ message: "Enter a decision rationale between 10 and 1000 characters." });
      if (actor.role === "committee" && electronicSignature !== true) return res.status(400).json({ message: "Electronic signing is required." });
      nextStage = "assessment"; detail = `Returned to loan officer from ${loan.stage}${actor.role === "committee" ? `; rationale: ${decisionNote.trim()}` : ""}`;
    } else if (action === "disburse") {
      return res.status(409).json({ message: "Loan disbursement must be sent and confirmed through Snippe." });
    } else if (action === "repay") {
      if (!["loan_officer", "finance", "supervisor", "director", "ceo"].includes(actor.role) || loan.status !== "active") return res.status(403).json({ message: "This active loan is not available for repayment recording." });
      const payment = Number(amount);
      if (!Number.isFinite(payment) || payment <= 0 || payment > Number(loan.balance)) return res.status(400).json({ message: "Enter a payment greater than zero and no more than the outstanding balance." });
      const cleanReference = typeof reference === "string" ? reference.trim().slice(0, 120) : "";
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query("SELECT balance, status, payout_reversal_review, amount_due, principal_amount, amount_paid, first_due_date, installment_count, weekly_installment_amount, final_installment_amount FROM loans WHERE id = $1 FOR UPDATE", [id]);
        if (!current.rowCount || current.rows[0].status !== "active" || current.rows[0].payout_reversal_review) {
          await client.query("ROLLBACK");
          return res.status(409).json({ message: current.rows[0]?.payout_reversal_review ? "This loan is frozen for Finance review after a reversed payout." : "This loan is no longer active. Refresh the records." });
        }
        if (payment > Number(current.rows[0].balance)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ message: "The payment is greater than the current outstanding balance. Refresh and try again." });
        }
        await client.query("INSERT INTO loan_payments (loan_id, amount, reference, received_by) VALUES ($1, $2, $3, $4)", [id, payment, cleanReference, actor.id]);
        await client.query(
        `UPDATE loans SET balance = GREATEST(balance - $2, 0),
             amount_paid = COALESCE(amount_paid, 0) + $2,
             arrears = CASE WHEN first_due_date IS NOT NULL AND weekly_installment_amount > 0 AND CURRENT_DATE >= first_due_date
               THEN GREATEST((CASE
                 WHEN LEAST(installment_count, FLOOR((CURRENT_DATE - first_due_date)::numeric / 7)::int + 1) >= installment_count THEN amount_due
                 ELSE LEAST(installment_count, FLOOR((CURRENT_DATE - first_due_date)::numeric / 7)::int + 1) * weekly_installment_amount
               END) - COALESCE(amount_paid, 0) - $2, 0)
               ELSE GREATEST(COALESCE(arrears, 0) - $2, 0) END,
             next_due_date = CASE WHEN first_due_date IS NOT NULL AND weekly_installment_amount > 0
               THEN first_due_date + (LEAST(installment_count - 1, FLOOR((COALESCE(amount_paid, 0) + $2) / weekly_installment_amount)::int) * 7)
               ELSE next_due_date END,
             repayment_performance = CASE WHEN COALESCE(amount_due, principal_amount, 0) > 0
               THEN LEAST(100, ((COALESCE(amount_paid, 0) + $2) / COALESCE(amount_due, principal_amount)) * 100) ELSE repayment_performance END,
             status = CASE WHEN GREATEST(balance - $2, 0) = 0 THEN 'closed' ELSE status END,
             updated_at = now() WHERE id = $1`, [id, payment]
        );
        await client.query("COMMIT");
      } catch (err) { await client.query("ROLLBACK").catch(() => undefined); throw err; }
      finally { client.release(); }
      detail = `Payment recorded: ${payment.toFixed(2)}${cleanReference ? `; reference ${cleanReference}` : ""}`;
      await audit(actor.username, "Loan repayment recorded", loan.loan_number, detail);
      return res.json({ ok: true });
    } else {
      return res.status(400).json({ message: "Unknown loan action." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query("UPDATE loans SET stage = $2, updated_at = now() WHERE id = $1 AND stage = $3 AND status = 'in_progress' RETURNING id", [id, nextStage, loan.stage]);
      if (!updated.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "This loan stage changed before the action was recorded. Refresh and try again." });
      }
      if (actor.role === "committee" && (action === "approve" || action === "return")) {
        await client.query(
          "INSERT INTO loan_decision_records (loan_id, reviewer_id, decision, rationale, signer_id, signed_at) VALUES ($1, $2, $3, $4, $5, now())",
          [id, actor.id, action === "approve" ? "approved" : "returned", decisionNote.trim(), actor.id]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await audit(actor.username, actor.role === "committee" ? "Committee decision signed" : "Loan stage updated", loan.loan_number, detail);
    return res.json({ ok: true, stage: nextStage });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not update this loan." });
  }
});

return loanRoutes;
}

export const loanRoutes = createLoanRouter();
