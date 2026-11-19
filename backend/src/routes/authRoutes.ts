import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "../db";
import { config } from "../config";
import { audit } from "../audit";
import { requireAuth, JwtUser } from "../auth";
import { issueEmailCode } from "../emailCodes";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const FAIL_MESSAGE = config.requireOtp
  ? "Incorrect username, password or code."
  : "Incorrect username or password.";

// Roles a staff member may ask for. The admin role is never self-requested.
const STAFF_ROLES = ["loan_officer", "supervisor", "committee", "finance", "management", "director", "ceo"];
const PLATFORM_TERMS_VERSION = "2026-11-17-v1";

export const authRoutes = Router();

function hashCode(code: string): string {
  return createHmac("sha256", config.jwtSecret).update(`bml-email-code:${code}`).digest("hex");
}

function validCode(candidate: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashCode(candidate), "hex");
  const expectedHash = Buffer.from(storedHash, "hex");
  return candidateHash.length === expectedHash.length && timingSafeEqual(candidateHash, expectedHash);
}

function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

authRoutes.post("/password-reset/start", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });
  if (!config.emailConfigured) return res.status(503).json({ message: "Email delivery is not configured. Contact the system administrator." });
  try {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE lower(email) = $1 AND email_verified_at IS NOT NULL LIMIT 1", [email]
    );
    if (rows.length) {
      try {
        await issueEmailCode(email, "password_reset", undefined, rows[0].id);
      } catch (err) {
        console.error("Password reset email delivery failed.", err);
      }
    }
    return res.status(202).json({ message: "If a verified account uses that email, a password reset code has been sent." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not start password reset. Please try again." });
  }
});

authRoutes.post("/password-reset/complete", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const code = String(req.body?.code ?? "").trim();
  const newPassword = String(req.body?.newPassword ?? "");
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: "Enter the email address and six-digit code." });
  if (newPassword.length < 12 || newPassword.length > 128) return res.status(400).json({ message: "Choose a password between 12 and 128 characters." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT user_id, code_hash, attempts, expires_at FROM email_challenges WHERE email = $1 AND purpose = 'password_reset' FOR UPDATE", [email]
    );
    const challenge = rows[0];
    if (!challenge || new Date(challenge.expires_at) <= new Date() || challenge.attempts >= 5) {
      if (challenge) await client.query("DELETE FROM email_challenges WHERE email = $1 AND purpose = 'password_reset'", [email]);
      await client.query("COMMIT");
      return res.status(400).json({ message: "That code is invalid or expired. Request a new one." });
    }
    if (!validCode(code, challenge.code_hash)) {
      await client.query("UPDATE email_challenges SET attempts = attempts + 1 WHERE email = $1 AND purpose = 'password_reset'", [email]);
      await client.query("COMMIT");
      return res.status(400).json({ message: "That code is invalid or expired. Request a new one." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await client.query(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1, password_change_required = FALSE,
          failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [challenge.user_id, passwordHash]
    );
    await client.query("DELETE FROM email_challenges WHERE email = $1 AND purpose = 'password_reset'", [email]);
    await client.query("DELETE FROM email_challenges WHERE user_id = $1 AND purpose = 'password_reset'", [challenge.user_id]);
    await client.query("COMMIT");
    await audit(email, "Password reset completed");
    return res.json({ ok: true, message: "Password reset. You can now sign in with your new password." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(err);
    return res.status(500).json({ message: "Could not reset the password. Please try again." });
  } finally {
    client.release();
  }
});

authRoutes.post("/password-reset-requests", async (req, res) => {
  const username = String(req.body?.username ?? "").trim().toLowerCase();
  const phone = String(req.body?.phone ?? "").trim();
  if (!/^[^\s\p{C}]{3,30}$/u.test(username)) {
    return res.status(400).json({ message: "Enter the username for the account." });
  }
  if (!/^\+?[0-9][0-9\s()-]{6,18}$/.test(phone)) {
    return res.status(400).json({ message: "Enter a phone number where the system administrator can reach you." });
  }

  try {
    const { rows: users } = await pool.query(
      "SELECT id FROM users WHERE lower(username) = $1 LIMIT 1", [username]
    );
    const { rows: pending } = await pool.query(
      `SELECT id FROM password_reset_requests
        WHERE lower(requested_username) = $1 AND status = 'pending'
          AND created_at > now() - interval '24 hours' LIMIT 1`,
      [username]
    );
    if (!pending.length) {
      await pool.query(
        `INSERT INTO password_reset_requests (requested_username, contact_phone, user_id)
         VALUES ($1, $2, $3)`,
        [username, phone, users[0]?.id ?? null]
      );
    }
    res.status(202).json({
      message: "If the account matches, your request has been sent to the system administrator. They will verify your identity before issuing a temporary password.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not submit the request. Please try again." });
  }
});

// ---------- small helpers ----------

// Accepts +255712345678, 255712345678 or 0712345678 (spaces and dashes are fine).
// Stores +255712345678.
function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, "");
  const m = s.match(/^(?:\+?255|0)([67]\d{8})$/);
  return m ? "+255" + m[1] : null;
}

// The shape the frontend reads after sign-in.
function publicUser(row: any) {
  return {
    username: row.username as string,
    role: row.role as string,
    fullName: row.full_name as string,
    ...(row.phone ? { phone: row.phone as string } : {}),
    ...(row.profile_image ? { profileImage: row.profile_image as string } : {}),
    ...(row.terms_version ? { termsVersion: row.terms_version as string } : {}),
    mustChangePassword: Boolean(row.password_change_required),
  };
}

interface Signup {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  profileImage: string | null;
}

function readSignup(body: any): { error: string } | { value: Signup } {
  const fullName = String(body?.fullName ?? "").trim();
  const username = String(body?.username ?? "").trim().toLowerCase();
  const email = String(body?.email ?? "").trim().toLowerCase();
  const phone = normalizePhone(String(body?.phone ?? ""));
  const password = String(body?.password ?? "");
  const image = body?.profileImage;

  if (fullName.length < 2 || fullName.length > 80) return { error: "Enter your full name." };
  if (!/^[^\s\p{C}]{3,30}$/u.test(username)) {
    return { error: "Choose a username with 3 to 30 characters and no spaces." };
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (!phone) {
    return { error: "Enter a valid mobile number with country code, for example +255 712 345 678." };
  }
  if (password.length < 10 || password.length > 128) {
    return { error: "Choose a password between 10 and 128 characters." };
  }
  if (image !== undefined && image !== null && image !== "") {
    if (typeof image !== "string" || !image.startsWith("data:image/") || image.length > 700_000) {
      return { error: "Choose a smaller photo (a JPG or PNG under about 500 KB)." };
    }
  }
  return {
    value: { fullName, username, email, phone, password, profileImage: image ? String(image) : null },
  };
}

const DUPLICATE_MESSAGE = "An account with this username, email or phone number already exists. Sign in instead.";

// ---------- sign in ----------

authRoutes.post("/login", async (req, res) => {
  try {
    const { username, password, code } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Enter your username and password." });
    }
    if (config.requireOtp && typeof code !== "string") {
      return res.status(400).json({ message: "Enter your username, password and one-time code." });
    }

    const typed = username.trim();
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE lower(username) = $1 OR phone = $2 LIMIT 1",
      [typed.toLowerCase(), normalizePhone(typed) ?? typed]
    );
    const user = rows[0];

    if (!user || user.status === "rejected") {
      await audit(typed.toLowerCase(), "Sign-in failed", "", "Unknown or rejected account");
      return res.status(401).json({ message: FAIL_MESSAGE });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await audit(user.username, "Sign-in blocked", "", "Account is locked");
      return res.status(423).json({
        message: `Account locked after repeated failed attempts. Try again in ${LOCK_MINUTES} minutes or ask the system admin.`,
      });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    const codeOk = !config.requireOtp || (config.devOtp !== "" && code === config.devOtp);

    if (!passwordOk || !codeOk) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= MAX_ATTEMPTS;
      await pool.query(
        `UPDATE users
            SET failed_attempts = CASE WHEN $3::boolean THEN 0 ELSE $2::int END,
                locked_until = CASE WHEN $3::boolean THEN now() + ($4::int * interval '1 minute') ELSE NULL END
          WHERE id = $1`,
        [user.id, attempts, lock, LOCK_MINUTES]
      );
      await audit(user.username, "Sign-in failed", "", lock ? "Account locked" : `Attempt ${attempts}`);
      return res.status(401).json({ message: FAIL_MESSAGE });
    }

    // Only someone who knows the password learns the account is not switched on.
    if (user.status === "pending") {
      await audit(user.username, "Sign-in blocked", "", "Staff registration not approved yet");
      return res.status(403).json({
        message: "Your staff registration is waiting for administrator approval. You can sign in once it is approved.",
      });
    }
    if (user.admin_locked) {
      await audit(user.username, "Sign-in blocked", "", "Locked by the administrator");
      return res.status(403).json({ message: "This account was locked by the administrator. Ask them to unlock it." });
    }
    if (!user.active) {
      await audit(user.username, "Sign-in blocked", "", "Account is switched off");
      return res.status(403).json({ message: "This account is switched off. Ask the system admin." });
    }

    await pool.query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, tokenVersion: Number(user.token_version ?? 0) },
      config.jwtSecret,
      { expiresIn: "8h" }
    );
    res.cookie("bml_session", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/" });
    await audit(user.username, "Signed in");
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong on the server. Try again." });
  }
});

authRoutes.post("/change-password", requireAuth, async (req, res) => {
  const me = res.locals.user as JwtUser;
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (newPassword.length < 12 || newPassword.length > 128) {
    return res.status(400).json({ message: "Choose a password between 12 and 128 characters." });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: "Choose a new password different from the temporary password." });
  }
  try {
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [me.id]);
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return res.status(400).json({ message: "The current password is incorrect." });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    const updated = await pool.query(
      `UPDATE users SET password_hash = $2, token_version = token_version + 1, password_change_required = FALSE,
          failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING token_version`,
      [me.id, hash]
    );
    const renewedToken = jwt.sign({ id: me.id, username: me.username, role: me.role, tokenVersion: Number(updated.rows[0].token_version) }, config.jwtSecret, { expiresIn: "8h" });
    res.cookie("bml_session", renewedToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/" });
    await audit(me.username, "Password changed");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not change the password. Try again." });
  }
});

authRoutes.post("/logout", requireAuth, async (_req, res) => {
  const me = res.locals.user as JwtUser;
  await pool.query("UPDATE users SET token_version=token_version+1 WHERE id=$1", [me.id]);
  res.clearCookie("bml_session", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

// ---------- who am I ----------

// The frontend calls this when a page loads. The role comes from the database,
// so a change by the admin shows up here.
authRoutes.get("/me", requireAuth, async (_req, res) => {
  try {
    const me = res.locals.user as JwtUser;
    const { rows } = await pool.query(
      "SELECT username, phone, role, full_name, profile_image, password_change_required, terms_version FROM users WHERE id = $1",
      [me.id]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong on the server. Try again." });
  }
});

// Registration data stays in a short-lived verification challenge until its email code is confirmed.
async function startRegistration(req: any, res: any, kind: "customer" | "staff") {
  const parsed = readSignup(req.body);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const requestedRole = kind === "staff" ? String(req.body?.requestedRole ?? "") : "";
  const requestedZone = kind === "staff" ? String(req.body?.requestedZone ?? "").trim() : "";
  if (kind === "staff" && !STAFF_ROLES.includes(requestedRole)) return res.status(400).json({ message: "Choose the role you are asking for." });
  if (kind === "staff" && requestedRole === "supervisor" && (!requestedZone || requestedZone.length > 100)) {
    return res.status(400).json({ message: "Enter the zone this supervisor will be responsible for." });
  }
  if (req.body?.acceptTerms !== true) return res.status(400).json({ message: "Agree to the BML Terms of Use before registering." });
  if (!config.emailConfigured) return res.status(503).json({ message: "Email delivery is not configured. Contact the system administrator." });
  try {
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM users WHERE lower(username) = $1 OR lower(email) = $2 OR phone = $3 LIMIT 1",
      [v.username, v.email, v.phone]
    );
    const { rows: pending } = await pool.query(
      `SELECT 1 FROM email_challenges WHERE purpose = 'registration' AND email <> $1
        AND (registration_payload->>'username' = $2 OR registration_payload->>'phone' = $3) LIMIT 1`,
      [v.email, v.username, v.phone]
    );
    if (existing.length || pending.length) return res.status(409).json({ message: DUPLICATE_MESSAGE });
    const passwordHash = await bcrypt.hash(v.password, 10);
    const payload = {
      kind, username: v.username, email: v.email, phone: v.phone, fullName: v.fullName,
      passwordHash, profileImage: v.profileImage, requestedRole,
      requestedZone: requestedRole === "supervisor" ? requestedZone : null,
      termsVersion: PLATFORM_TERMS_VERSION, termsAcceptedAt: new Date().toISOString(),
    };
    await issueEmailCode(v.email, "registration", payload);
    return res.status(202).json({ message: "We sent a six-digit verification code to your email. Enter it to finish registration." });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ message: DUPLICATE_MESSAGE });
    console.error("Registration verification email failed.", err);
    return res.status(503).json({ message: "Could not send the verification email. Please try again later." });
  }
}

async function verifyRegistration(req: any, res: any) {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const code = String(req.body?.code ?? "").trim();
  if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: "Enter the email address and six-digit code." });
  const client = await pool.connect();
  let payload: any;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT code_hash, registration_payload, attempts, expires_at FROM email_challenges WHERE email = $1 AND purpose = 'registration' FOR UPDATE", [email]
    );
    const challenge = rows[0];
    if (!challenge || new Date(challenge.expires_at) <= new Date() || challenge.attempts >= 5) {
      if (challenge) await client.query("DELETE FROM email_challenges WHERE email = $1 AND purpose = 'registration'", [email]);
      await client.query("COMMIT");
      return res.status(400).json({ message: "That code is invalid or expired. Start registration again." });
    }
    if (!validCode(code, challenge.code_hash)) {
      await client.query("UPDATE email_challenges SET attempts = attempts + 1 WHERE email = $1 AND purpose = 'registration'", [email]);
      await client.query("COMMIT");
      return res.status(400).json({ message: "That code is invalid or expired. Start registration again." });
    }
    payload = challenge.registration_payload;
    if (payload.kind === "customer") {
      await client.query(
        `INSERT INTO users (username, email, email_verified_at, phone, full_name, password_hash, role, profile_image, status, active, terms_version, terms_accepted_at)
         VALUES ($1, $2, now(), $3, $4, $5, 'customer', $6, 'active', TRUE, $7, $8)`,
        [payload.username, payload.email, payload.phone, payload.fullName, payload.passwordHash, payload.profileImage, payload.termsVersion, payload.termsAcceptedAt]
      );
    } else {
      await client.query(
        `INSERT INTO users
          (username, email, email_verified_at, phone, full_name, password_hash, role, profile_image, status, active, requested_role, requested_zone, terms_version, terms_accepted_at)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, 'pending', FALSE, $6, $8, $9, $10)`,
        [payload.username, payload.email, payload.phone, payload.fullName, payload.passwordHash, payload.requestedRole, payload.profileImage, payload.requestedZone, payload.termsVersion, payload.termsAcceptedAt]
      );
    }
    await client.query("DELETE FROM email_challenges WHERE email = $1 AND purpose = 'registration'", [email]);
    await client.query("COMMIT");
    await audit(payload.username, "Terms of use accepted", "", payload.termsVersion);
    if (payload.kind === "customer") await audit(payload.username, "Customer registered and email verified");
    else await audit(payload.username, "Staff registration requested", "", payload.requestedRole === "supervisor" ? `${payload.requestedRole} · ${payload.requestedZone}` : payload.requestedRole);
    return res.status(201).json({ ok: true, message: payload.kind === "customer"
      ? "Email verified and account created. You can now sign in."
      : "Email verified. Your registration was sent to the administrator; you can sign in after approval." });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.code === "23505") return res.status(409).json({ message: DUPLICATE_MESSAGE });
    console.error(err);
    return res.status(500).json({ message: "Could not finish registration. Please try again." });
  } finally {
    client.release();
  }
}

authRoutes.post("/accept-terms", requireAuth, async (req, res) => {
  if (req.body?.acceptTerms !== true) return res.status(400).json({ message: "Choose I agree to continue using the BML platform." });
  const user = res.locals.user as JwtUser;
  try {
    const saved = await pool.query("UPDATE users SET terms_version=$2,terms_accepted_at=now() WHERE id=$1 RETURNING username", [user.id, PLATFORM_TERMS_VERSION]);
    if (!saved.rowCount) return res.status(401).json({ message: "Your account is unavailable. Sign in again." });
    await audit(saved.rows[0].username, "Terms of use accepted", "", PLATFORM_TERMS_VERSION);
    return res.json({ ok: true, termsVersion: PLATFORM_TERMS_VERSION });
  } catch (error) { console.error(error); return res.status(500).json({ message: "Could not save your agreement. Please try again." }); }
});

authRoutes.post("/register", (req, res) => startRegistration(req, res, "customer"));
authRoutes.post("/register-staff", (req, res) => startRegistration(req, res, "staff"));
authRoutes.post("/register/verify", verifyRegistration);
authRoutes.post("/register-staff/verify", verifyRegistration);
