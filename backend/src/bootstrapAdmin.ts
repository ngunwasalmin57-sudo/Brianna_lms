import bcrypt from "bcryptjs";
import { pool } from "./db";

async function main() {
  const username = process.env.BML_BOOTSTRAP_ADMIN_USERNAME?.trim().toLowerCase() ?? "";
  const fullName = process.env.BML_BOOTSTRAP_ADMIN_NAME?.trim() ?? "";
  const password = process.env.BML_BOOTSTRAP_ADMIN_PASSWORD ?? "";
  const supplied = [username, fullName, password].filter(Boolean).length;
  if (!supplied) {
    const admins = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin' AND status='active' AND active");
    if (admins.rows[0].count === 0) throw new Error("No active administrator exists. Set all three BML_BOOTSTRAP_ADMIN_* values to create one.");
    console.log("An active administrator already exists; no account changes were made.");
    await pool.end();
    return;
  }
  if (supplied !== 3) throw new Error("Set all three BML_BOOTSTRAP_ADMIN_* values, or leave all three empty.");
  if (!/^[^\s\p{C}]{3,30}$/u.test(username)) throw new Error("BML_BOOTSTRAP_ADMIN_USERNAME must be 3 to 30 characters without spaces.");
  if (fullName.length < 2 || fullName.length > 80) throw new Error("BML_BOOTSTRAP_ADMIN_NAME must be 2 to 80 characters.");
  if (password.length < 12 || password.length > 128) throw new Error("BML_BOOTSTRAP_ADMIN_PASSWORD must be 12 to 128 characters.");
  if (/replace|change-me|example|password123/i.test(password)) throw new Error("Replace the example bootstrap password with a unique secret before setup.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      `INSERT INTO users (username, full_name, password_hash, role, status, active, password_change_required)
       VALUES ($1,$2,$3,'admin','active',TRUE,TRUE)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, fullName, hash]
    );
    if (!inserted.rowCount) {
      const existing = await client.query("SELECT role, status, active, admin_locked FROM users WHERE lower(username)=lower($1)", [username]);
      const account = existing.rows[0];
      if (account?.role !== "admin") throw new Error("The bootstrap username is already in use by a non-admin account. Choose a different username.");
      if (account.status !== "active" || !account.active || account.admin_locked) throw new Error("The bootstrap username belongs to a disabled administrator. Choose a different username and review the old account.");
      console.log(`Administrator ${username} already exists; its password and account settings were left unchanged.`);
    } else {
      console.log(`Created administrator ${username}. The administrator must change the bootstrap password at first sign-in.`);
    }
    await client.query("COMMIT");
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
