import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { NextFunction, Request, Response } from "express";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_SECRET = "unit-test-secret-that-is-at-least-thirty-two-characters";

const { createLoanRouter } = await import("../src/routes/loanRoutes");

class RepaymentPool {
  inserts = 0;
  async query() {
    return { rows: [{ id: 9, officer_id: 2, stage: "repayment", status: "active", balance: 1000, principal_amount: 1000, amount_due: 1100, amount_paid: 100, loan_number: "BEL-009" }], rowCount: 1 };
  }
  async connect() {
    return {
      query: async (sql: string) => {
        if (sql.includes("SELECT balance, status, payout_reversal_review")) {
          return { rows: [{ balance: 1000, status: "active", payout_reversal_review: true }], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO loan_payments")) this.inserts++;
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    };
  }
}

test("manual repayment is blocked by a Finance-review hold without writing a ledger entry", async () => {
  const pool = new RepaymentPool();
  const authenticate = (_req: Request, res: Response, next: NextFunction) => {
    res.locals.user = { id: 2, username: "officer", role: "loan_officer" };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api/loans", createLoanRouter({ pool: pool as any, authenticate: authenticate as any, auditEvent: async () => undefined }));
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/loans/9/action`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "repay", amount: 100 }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as any).message, /Finance review/);
    assert.equal(pool.inserts, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
