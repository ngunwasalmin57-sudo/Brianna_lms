import { Router } from "express";
import { pool } from "../db";
import { allow, JwtUser } from "../auth";
import { can, roleNames } from "../permissions";
import type { Role } from "../permissions";

export const dashboardRoutes = Router();

type Stat = { label: string; value: number | string; highlight?: boolean };

const nextScreen: Record<Role, string> = {
  loan_officer: "the screen for the selected phase",
  supervisor: "B1 Supervisor verification",
  committee: "B2 Credit Committee workspace",
  finance: "C1 Loan account creation",
  management: "Team oversight",
  director: "Company portfolio and operations",
  ceo: "Company portfolio and operations",
  admin: "X1 Users and roles",
  customer: "Customer portal",
};

const money = (n: number) => `TZS ${Math.round(n).toLocaleString("en-US")}`;
const millions = (n: number) => `${(n / 1_000_000).toFixed(1)}M`;
const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";

dashboardRoutes.get("/", allow("dashboard.view"), async (_req, res) => {
  try {
    const user = res.locals.user as JwtUser;
    if (user.role === "customer") return res.status(403).json({ message: "Customers use the account portal." });
    const roleLabel = `${roleNames[user.role]} view`;

    // The admin sees how the system is used, never client or loan records.
    if (user.role === "admin") {
      const a = await pool.query(
        `SELECT
           (SELECT count(*) FROM users WHERE active)::int AS users,
           (SELECT count(*) FROM users WHERE locked_until > now())::int AS locked,
           (SELECT count(*) FROM audit_log WHERE action = 'Signed in' AND at >= CURRENT_DATE)::int AS signins,
           (SELECT count(*) FROM audit_log WHERE action = 'Sign-in failed' AND at >= CURRENT_DATE)::int AS failed`
      );
      const x = a.rows[0];
      const stats: Stat[] = [
        { label: "Active users", value: x.users, highlight: true },
        { label: "Locked accounts", value: x.locked },
        { label: "Sign-ins today", value: x.signins },
        { label: "Failed sign-ins today", value: x.failed },
      ];
      return res.json({ roleLabel, stats, rows: [], nextScreen: nextScreen.admin });
    }

    // Loan officers see their own portfolio. Other roles see everything.
    const scope = user.role === "loan_officer" ? user.id : null;

    const q = await pool.query(
      `SELECT
         (SELECT count(*) FROM clients WHERE ($1::int IS NULL OR officer_id = $1))::int AS customers,
         (SELECT count(*) FROM clients c
           WHERE ($1::int IS NULL OR c.officer_id = $1)
             AND c.application_status = 'submitted'
             AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.client_id = c.id))::int AS submitted_apps,
         count(*) FILTER (WHERE status = 'active' AND next_due_date = CURRENT_DATE)::int AS due_today,
         count(*) FILTER (WHERE status = 'active' AND next_due_date < CURRENT_DATE)::int AS overdue,
         count(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
         count(*) FILTER (WHERE stage = 'verification')::int AS awaiting_verification,
         count(*) FILTER (WHERE stage = 'approval')::int AS awaiting_approval,
         count(*) FILTER (WHERE stage = 'disbursement')::int AS ready_to_disburse,
         count(*) FILTER (WHERE status = 'active')::int AS active_loans,
         COALESCE(sum(balance) FILTER (WHERE status = 'active'), 0)::float AS portfolio,
         COALESCE(sum(balance) FILTER (WHERE status = 'active' AND next_due_date < CURRENT_DATE), 0)::float AS par1,
         COALESCE(sum(balance) FILTER (WHERE status = 'active' AND next_due_date < CURRENT_DATE - 30), 0)::float AS par30
       FROM loans
       WHERE ($1::int IS NULL OR officer_id = $1)`,
      [scope]
    );
    const s = q.rows[0];

    const byRole: Record<Exclude<Role, "admin">, Stat[]> = {
      loan_officer: [
        { label: "My customers", value: s.customers, highlight: true },
        { label: "Active loans", value: s.active_loans },
        { label: "Pending applications", value: s.in_progress + s.submitted_apps },
        { label: "Portfolio balance", value: money(s.portfolio) },
      ],
      supervisor: [
        { label: "Awaiting verification", value: s.awaiting_verification, highlight: true },
        { label: "Due today", value: s.due_today },
        { label: "Overdue", value: s.overdue },
        { label: "In progress", value: s.in_progress },
      ],
      committee: [
        { label: "Awaiting decision", value: s.awaiting_approval, highlight: true },
        { label: "Active loans", value: s.active_loans },
        { label: "Overdue", value: s.overdue },
        { label: "In progress", value: s.in_progress },
      ],
      finance: [
        { label: "Ready to disburse", value: s.ready_to_disburse, highlight: true },
        { label: "Active loans", value: s.active_loans },
        { label: "Due today", value: s.due_today },
        { label: "Overdue", value: s.overdue },
      ],
      management: [
        { label: "Portfolio (TZS)", value: millions(s.portfolio), highlight: true },
        { label: "PAR 1 day", value: percent(s.par1, s.portfolio) },
        { label: "PAR 30 days", value: percent(s.par30, s.portfolio) },
        { label: "Overdue loans", value: s.overdue },
      ],
      director: [
        { label: "Portfolio (TZS)", value: millions(s.portfolio), highlight: true },
        { label: "PAR 1 day", value: percent(s.par1, s.portfolio) },
        { label: "PAR 30 days", value: percent(s.par30, s.portfolio) },
        { label: "Overdue loans", value: s.overdue },
      ],
      ceo: [
        { label: "Portfolio (TZS)", value: millions(s.portfolio), highlight: true },
        { label: "PAR 1 day", value: percent(s.par1, s.portfolio) },
        { label: "PAR 30 days", value: percent(s.par30, s.portfolio) },
        { label: "Overdue loans", value: s.overdue },
      ],
      customer: [],
    };
    const stats = byRole[user.role as Exclude<Role, "admin">];

    let rows: unknown[] = [];
    if (can(user.role, "dashboard.dueList")) {
      const r = await pool.query(
        `SELECT l.id, c.full_name AS client, l.product,
                (l.next_due_date - CURRENT_DATE)::int AS days
           FROM loans l
           JOIN clients c ON c.id = l.client_id
          WHERE l.status = 'active' AND ($1::int IS NULL OR l.officer_id = $1)
          ORDER BY l.next_due_date
          LIMIT 50`,
        [scope]
      );
      rows = r.rows.map((x) => ({
        id: x.id,
        client: x.client,
        product: x.product,
        due: x.days === 0 ? "Today" : x.days < 0 ? `${-x.days} days late` : `${x.days} days`,
        status: x.days < 0 ? "Overdue" : x.days === 0 ? "Due" : "On track",
      }));
    }

    res.json({ roleLabel, stats, rows, nextScreen: nextScreen[user.role] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the dashboard. Try again." });
  }
});
