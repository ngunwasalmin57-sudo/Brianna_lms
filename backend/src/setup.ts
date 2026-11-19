import fs from "fs";
import path from "path";
import { pool } from "./db";

/** Apply database schema and migrations only. Account operations are separate opt-in commands. */
async function main() {
  const schema = fs.readFileSync(path.join(process.cwd(), "sql", "schema.sql"), "utf8");
  const paymentHardening = fs.readFileSync(path.join(process.cwd(), "sql", "payments-hardening.sql"), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(schema);
    await client.query(paymentHardening);
    await client.query("COMMIT");
    console.log("Database schema and migrations are current.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
