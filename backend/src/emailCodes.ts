import { createHmac, randomInt } from "crypto";
import { pool } from "./db";
import { sendEmailCode } from "./email";
import { config } from "./config";

export async function issueEmailCode(
  email: string,
  purpose: "registration" | "password_reset",
  registrationPayload?: object,
  userId?: number,
) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = createHmac("sha256", config.jwtSecret).update(`bml-email-code:${code}`).digest("hex");
  await pool.query("DELETE FROM email_challenges WHERE expires_at <= now()");
  await pool.query(
    `INSERT INTO email_challenges (email, purpose, code_hash, registration_payload, user_id, attempts, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, 0, now() + interval '10 minutes')
     ON CONFLICT (email, purpose) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, registration_payload = EXCLUDED.registration_payload,
           user_id = EXCLUDED.user_id, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [email, purpose, codeHash, registrationPayload ? JSON.stringify(registrationPayload) : null, userId ?? null]
  );
  try {
    await sendEmailCode(email, code, purpose);
  } catch (err) {
    await pool.query("DELETE FROM email_challenges WHERE email = $1 AND purpose = $2 AND code_hash = $3", [email, purpose, codeHash]);
    throw err;
  }
}
