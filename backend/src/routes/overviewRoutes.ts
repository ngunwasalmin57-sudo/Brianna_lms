import { Router } from "express";
import { pool } from "../db";
import { allow, requireAuth, JwtUser } from "../auth";

export const overviewRoutes = Router();

const stageNames: Record<string, string> = {
  assessment: "Assessment",
  verification: "Verification",
  approval: "Approval",
  disbursement: "Disbursement",
  repayment: "Repayment",
};

// Numbers for the dashboard. Loan officers see their own clients, everyone else sees all.
overviewRoutes.get("/", allow("dashboard.portfolio"), async (_req, res) => {
  try {
    const user = res.locals.user as JwtUser;
    const scope = user.role === "loan_officer" ? user.id : null;

    const totals = await pool.query(
      `SELECT
         (SELECT count(*) FROM clients
           WHERE ($1::int IS NULL OR officer_id = $1))::int AS customers,
         (SELECT count(*) FROM clients
           WHERE ($1::int IS NULL OR officer_id = $1)
             AND created_at >= date_trunc('month', now()))::int AS customers_month,
         (SELECT count(*) FROM clients c
           WHERE ($1::int IS NULL OR c.officer_id = $1)
             AND c.application_status = 'submitted'
             AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.client_id = c.id))::int AS submitted_apps,
         count(*) FILTER (WHERE status = 'active')::int AS active_loans,
         count(*) FILTER (WHERE status = 'active'
                            AND created_at >= date_trunc('month', now()))::int AS loans_month,
         count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
         COALESCE(sum(balance) FILTER (WHERE status = 'active'), 0)::float AS portfolio
       FROM loans
       WHERE ($1::int IS NULL OR officer_id = $1)`,
      [scope]
    );
    const t = totals.rows[0];

    // Loan balances opened in each of the last ten months
    const monthly = await pool.query(
      `SELECT to_char(m, 'Mon') AS label, COALESCE(sum(l.balance), 0)::float AS value
         FROM generate_series(
                date_trunc('month', now()) - interval '9 months',
                date_trunc('month', now()),
                interval '1 month') AS m
         LEFT JOIN loans l
                ON date_trunc('month', l.created_at) = m
               AND ($1::int IS NULL OR l.officer_id = $1)
        GROUP BY m
        ORDER BY m`,
      [scope]
    );

    const stages = await pool.query(
      `SELECT stage, count(*)::int AS count
         FROM loans
        WHERE ($1::int IS NULL OR officer_id = $1)
        GROUP BY stage`,
      [scope]
    );
    const counts = new Map<string, number>(stages.rows.map((r) => [r.stage, r.count]));

    res.json({
      customers: t.customers,
      customersThisMonth: t.customers_month,
      activeLoans: t.active_loans,
      loansThisMonth: t.loans_month,
      pendingApplications: t.in_progress + t.submitted_apps,
      portfolioBalance: t.portfolio,
      monthly: monthly.rows,
      stages: Object.keys(stageNames)
        .filter((key) => (counts.get(key) ?? 0) > 0)
        .map((key) => ({ label: stageNames[key], count: counts.get(key) as number })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the dashboard numbers. Try again." });
  }
});
