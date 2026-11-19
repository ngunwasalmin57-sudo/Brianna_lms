import bcrypt from "bcryptjs";
import { pool } from "./db";

const SAMPLE_PASSWORD = "Password123!";
const users = [
  ["j.mushi", "J. Mushi", "loan_officer"],
  ["r.kway", "R. Kway", "supervisor"],
  ["c.chair", "Credit Committee Chair", "committee"],
  ["m.temba", "M. Temba", "finance"],
  ["d.manager", "D. Manager", "management"],
  ["s.admin", "System Admin", "admin"],
];
const loans: [string, string, string, string, number, number | null][] = [
  ["Asha Mwakyusa", "Emergency", "repayment", "active", 1310000, 0],
  ["Upendo Traders", "Group", "repayment", "active", 9800000, 0],
  ["Juma Mrema", "Emergency", "repayment", "active", 1820000, 2],
  ["Neema Group", "Group", "repayment", "active", 7300000, 5],
  ["Pili Mtui", "Emergency", "repayment", "active", 1820000, -3],
  ["Said Mtaume", "Emergency", "repayment", "active", 1500000, -12],
  ["Grace Ndege", "Business Emergency", "verification", "in_progress", 2000000, null],
  ["Mary Lyimo", "Emergency", "disbursement", "in_progress", 1500000, null],
];

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error("Demo seeding is disabled unless ALLOW_DEMO_SEED=true is explicitly set outside production.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash(SAMPLE_PASSWORD, 10);
    for (const [username, fullName, role] of users) {
      await client.query(
        `INSERT INTO users (username, full_name, password_hash, role)
         VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING`,
        [username, fullName, hash, role]
      );
    }
    const existing = await client.query("SELECT count(*)::int AS n FROM loans");
    if (existing.rows[0].n === 0) {
      const officer = (await client.query("SELECT id FROM users WHERE username = 'j.mushi'")).rows[0].id;
      let number = 142;
      for (const [name, product, stage, status, balance, days] of loans) {
        const created = await client.query("INSERT INTO clients (full_name, officer_id) VALUES ($1, $2) RETURNING id", [name, officer]);
        await client.query(
          `INSERT INTO loans (loan_number, client_id, officer_id, product, stage, status, balance, next_due_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE + $8::int)`,
          [`BEL-${String(number++).padStart(4, "0")}`, created.rows[0].id, officer, product, stage, status, balance, days]
        );
      }
    }
    await client.query("COMMIT");
    console.log("Local demo records are ready. Change all demo passwords before using this data beyond local development.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
