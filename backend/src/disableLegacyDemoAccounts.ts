import bcrypt from "bcryptjs";
import { pool } from "./db";

// This one-off cleanup is intentionally separate from schema migration.
const LEGACY_DEMO_PASSWORD = "Password123!";
const LEGACY_DEMO_USERNAMES = ["j.mushi", "r.kway", "c.chair", "m.temba", "d.manager", "s.admin"];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, username, password_hash FROM users WHERE lower(username)=ANY($1::text[])",
      [LEGACY_DEMO_USERNAMES]
    );
    const disabled: string[] = [];
    for (const user of rows) {
      if (await bcrypt.compare(LEGACY_DEMO_PASSWORD, user.password_hash)) {
        await client.query(
          "UPDATE users SET active=FALSE, admin_locked=TRUE, password_change_required=TRUE WHERE id=$1",
          [user.id]
        );
        disabled.push(user.username);
      }
    }
    await client.query("COMMIT");
    if (disabled.length) console.warn(`Disabled matching legacy demo accounts: ${disabled.join(", ")}. Review each account before use.`);
    else console.log("No matching legacy demo accounts were changed.");
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
