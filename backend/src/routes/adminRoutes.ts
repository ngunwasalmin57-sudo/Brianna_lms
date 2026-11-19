import { Router } from "express";
import { pool } from "../db";
import { config } from "../config";
import { requireAuth, JwtUser } from "../auth";
import { audit } from "../audit";
import { normalizeTanzanianPhone, sendBeemSms } from "../sms";
import { issueEmailCode } from "../emailCodes";

export const adminRoutes = Router();

adminRoutes.use(requireAuth, (req, res, next) => {
  const user = res.locals.user as JwtUser;
  if (user.role === "admin") return next();
  if (user.role === "committee" && ((req.method === "GET" && req.path === "/message-recipients") || (req.method === "POST" && req.path === "/messages"))) return next();
  return res.status(403).json({ message: "Only a system administrator can manage users." });
});

adminRoutes.get("/supervisor-zones", async (_req, res) => {
  try {
    const [{ rows: zones }, { rows: supervisors }] = await Promise.all([
      pool.query(`SELECT z.zone, sz.supervisor_id, u.full_name AS supervisor_name
        FROM (SELECT DISTINCT lower(trim(zone)) AS zone FROM loan_groups WHERE trim(zone) <> ''
              UNION SELECT lower(trim(zone)) FROM supervisor_zones) z
        LEFT JOIN supervisor_zones sz ON lower(sz.zone) = lower(z.zone)
        LEFT JOIN users u ON u.id = sz.supervisor_id
        ORDER BY z.zone`),
      pool.query("SELECT id, username, full_name AS \"fullName\" FROM users WHERE role = 'supervisor' AND status = 'active' AND active ORDER BY full_name"),
    ]);
    res.json({ zones: zones.map((row) => ({ zone: row.zone, supervisorId: row.supervisor_id, supervisorName: row.supervisor_name })), supervisors });
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not load supervisor zone assignments." }); }
});

adminRoutes.put("/supervisor-zones", async (req, res) => {
  const zone = String(req.body?.zone ?? "").trim();
  const supervisorId = Number(req.body?.supervisorId);
  if (!zone || zone.length > 100 || !Number.isInteger(supervisorId) || supervisorId < 1) return res.status(400).json({ message: "Enter a zone and choose its supervisor." });
  const admin = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `INSERT INTO supervisor_zones (zone, supervisor_id) SELECT $1, id FROM users
        WHERE id = $2 AND role = 'supervisor' AND status = 'active' AND active
       ON CONFLICT (zone) DO UPDATE SET supervisor_id = EXCLUDED.supervisor_id
       RETURNING zone`, [zone.toLowerCase(), supervisorId]
    );
    if (!rows.length) return res.status(400).json({ message: "Choose an active supervisor account." });
    await audit(admin.username, "Supervisor zone assigned", zone, `Supervisor ${supervisorId}`);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not save this zone assignment." }); }
});

adminRoutes.get("/password-reset-requests", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.requested_username, r.contact_phone, r.created_at,
              u.username AS account_username, u.full_name, u.role
         FROM password_reset_requests r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC`
    );
    res.json(rows.map((row) => ({
      id: row.id,
      requestedUsername: row.requested_username,
      contactPhone: row.contact_phone,
      accountUsername: row.account_username,
      fullName: row.full_name,
      role: row.role,
      createdAt: row.created_at,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load password reset requests." });
  }
});

adminRoutes.post("/password-reset-requests/:id/issue", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Invalid request." });
  if (!config.emailConfigured) return res.status(503).json({ message: "Email delivery is not configured." });
  const admin = res.locals.user as JwtUser;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT r.user_id, r.requested_username, u.username, u.email, u.email_verified_at
         FROM password_reset_requests r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.status = 'pending'
        FOR UPDATE OF r`,
      [id]
    );
    const request = rows[0];
    if (!request) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "This request was already handled or does not exist." });
    }
    if (!request.user_id || !request.username) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No account matches this username. Ask the requester to check the details." });
    }
    if (!request.email || !request.email_verified_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This account has no verified email. Ask the user to contact the system administrator." });
    }
    await issueEmailCode(request.email, "password_reset", undefined, request.user_id);
    await client.query(
      `UPDATE password_reset_requests
          SET status = 'completed', handled_at = now(), handled_by = $2
        WHERE id = $1`,
      [id, admin.username]
    );
    await client.query(
      `INSERT INTO audit_log (username, action, record, detail)
       VALUES ($1, 'Password reset code emailed', $2, $3)`,
      [admin.username, request.username, `Request ${id}`]
    );
    await client.query("COMMIT");
    res.json({ username: request.username, message: "A reset code was sent to the account's verified email." });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(err);
    res.status(500).json({ message: "Could not send a reset code." });
  } finally {
    client.release();
  }
});

adminRoutes.post("/password-reset-requests/:id/dismiss", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Invalid request." });
  const admin = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `UPDATE password_reset_requests SET status = 'dismissed', handled_at = now(), handled_by = $2
        WHERE id = $1 AND status = 'pending' RETURNING requested_username`,
      [id, admin.username]
    );
    if (!rows.length) return res.status(404).json({ message: "This request was already handled or does not exist." });
    await audit(admin.username, "Password reset request dismissed", rows[0].requested_username);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not dismiss this request." });
  }
});

// Every account that is switched on, newest first. Pending requests are in their own list.
adminRoutes.get("/accounts", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, full_name, phone, role, requested_role, active, admin_locked, created_at
         FROM users WHERE status = 'active' ORDER BY created_at DESC`
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.full_name,
        phone: r.phone,
        role: r.role,
        requestedRole: r.requested_role,
        active: r.active,
        adminLocked: r.admin_locked,
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the accounts. Try again." });
  }
});

adminRoutes.get("/recent-signins", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id::int AS id, username, at AS "signedInAt"
         FROM audit_log WHERE action = 'Signed in' ORDER BY at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the sign-ins. Try again." });
  }
});

async function setLock(id: number, locked: boolean, adminName: string, adminId: number) {
  if (locked && id === adminId) return "self" as const;
  // Unlocking also clears the failed-attempt lock, so the person can sign in straight away.
  const { rows } = await pool.query(
    `UPDATE users
        SET admin_locked = $2,
            failed_attempts = CASE WHEN $2 THEN failed_attempts ELSE 0 END,
            locked_until = CASE WHEN $2 THEN locked_until ELSE NULL END
      WHERE id = $1 AND status = 'active'
      RETURNING username`,
    [id, locked]
  );
  if (rows.length === 0) return "missing" as const;
  await audit(adminName, locked ? "Account locked" : "Account unlocked", rows[0].username);
  return "ok" as const;
}

for (const locked of [true, false]) {
  adminRoutes.post(`/accounts/:id/${locked ? "lock" : "unlock"}`, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid request." });
    const admin = res.locals.user as JwtUser;
    try {
      const result = await setLock(id, locked, admin.username, admin.id);
      if (result === "self") return res.status(400).json({ message: "You cannot lock your own account." });
      if (result === "missing") return res.status(404).json({ message: "Account not found." });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Could not change the account. Try again." });
    }
  });
}

// People the admin can write to
adminRoutes.get("/message-recipients", async (_req, res) => {
  try {
    const admin = res.locals.user as JwtUser;
    if (admin.role === "committee") return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, username, full_name, phone, role FROM users
        WHERE status = 'active' AND active AND id <> $1 ORDER BY full_name`,
      [admin.id]
    );
    res.json(rows.map((r) => ({ id: r.id, username: r.username, fullName: r.full_name, phone: r.phone, role: r.role })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the people list. Try again." });
  }
});

// Send an in-app update or one-way SMS to one person or everyone.
adminRoutes.post("/messages", async (req, res) => {
  const admin = res.locals.user as JwtUser;
  const subject = String(req.body?.subject ?? "").trim();
  const body = String(req.body?.body ?? "").trim();
  const to = req.body?.recipientId;
  const delivery = req.body?.delivery ?? "in_app";
  const customerAudiences = ["customers", "customers_due", "customers_due_soon", "customers_overdue"];

  if (admin.role === "committee" && (delivery !== "sms" || to !== "customers_due")) {
    return res.status(403).json({ message: "Credit Committee members may send repayment reminders only to customers with due or overdue repayments." });
  }

  if (!subject || subject.length > 120) return res.status(400).json({ message: "Enter a subject of up to 120 characters." });
  if (!body || body.length > 2000) return res.status(400).json({ message: "Enter a message of up to 2,000 characters." });
  if (delivery === "sms" && subject.length + body.length + 1 > 1600) return res.status(400).json({ message: "The subject and message must total 1,600 characters or fewer for SMS." });
  if (delivery !== "in_app" && delivery !== "sms") return res.status(400).json({ message: "Choose a valid message delivery method." });
  if (delivery === "in_app" && to !== "all" && !Number.isInteger(to)) return res.status(400).json({ message: "Choose who to send this to." });
  if (delivery === "sms" && to !== "all" && !Number.isInteger(to) && !customerAudiences.includes(String(to))) return res.status(400).json({ message: "Choose who to send this to." });

  try {
    if (delivery === "sms") {
      const recipients = customerAudiences.includes(String(to))
        ? await pool.query(
          `SELECT DISTINCT c.id, c.full_name, c.phone
             FROM clients c LEFT JOIN loans l ON l.client_id = c.id
            WHERE c.phone IS NOT NULL AND (
              $1 = 'customers'
              OR ($1 = 'customers_due' AND l.status = 'active' AND l.next_due_date <= CURRENT_DATE)
              OR ($1 = 'customers_due_soon' AND l.status = 'active' AND l.next_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 3)
              OR ($1 = 'customers_overdue' AND l.status = 'active' AND l.next_due_date < CURRENT_DATE)
            )
            ORDER BY c.id`, [String(to)]
        )
        : await pool.query(
          `SELECT id, full_name, phone FROM users
            WHERE status = 'active' AND active AND id <> $1
              AND ($2::text = 'all' OR id = $2::int)
            ORDER BY id`, [admin.id, String(to)]
        );
      if (!recipients.rowCount) return res.status(404).json({ message: "No matching recipients were found." });
      const phoneRecipients = recipients.rows.flatMap((user) => {
        const phone = normalizeTanzanianPhone(String(user.phone ?? ""));
        return /^255[67]\d{8}$/.test(phone) ? [{ ...user, phone }] : [];
      });
      const skipped = recipients.rowCount - phoneRecipients.length;
      if (Number.isInteger(to) && !phoneRecipients.length) return res.status(400).json({ message: "This user has no valid Tanzanian mobile number on their account." });
      if (!phoneRecipients.length) return res.status(400).json({ message: "No matching recipients have a valid Tanzanian mobile number." });

      const sms = await sendBeemSms(phoneRecipients.map((user) => user.phone), `${subject}\n${body}`);
      const sent = Math.min(sms.successful, phoneRecipients.length);
      const audienceLabel = to === "all" ? "all active users" : to === "customers" ? "all BML customers" : to === "customers_due" ? "customers with due or overdue repayments" : to === "customers_due_soon" ? "customers due within 3 days" : to === "customers_overdue" ? "customers with overdue repayments" : `user ${to}`;
      await audit(admin.username, admin.role === "committee" ? "Repayment reminder SMS submitted" : "SMS submitted", audienceLabel, `Beem request ${sms.requestId ?? "unknown"}; accepted ${sent}; skipped ${skipped + sms.invalid + sms.duplicates}`)
        .catch((err) => console.error("Could not record SMS audit event", err));
      return res.status(201).json({ sent, skipped: skipped + sms.invalid + sms.duplicates, requestId: sms.requestId });
    }

    const result = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, subject, body)
       SELECT $1, u.id, $2, $3 FROM users u
        WHERE u.status = 'active' AND u.active AND u.id <> $1
          AND ($4::text = 'all' OR u.id = $4::int)`,
      [admin.id, subject, body, String(to)]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "No one to send this to." });
    await audit(admin.username, "Message sent", to === "all" ? "everyone" : `user ${to}`, subject);
    res.status(201).json({ sent: result.rowCount });
  } catch (err) {
    console.error(err);
    if (delivery === "sms") {
      const message = err instanceof Error ? err.message : "Could not send SMS through Beem.";
      return res.status(message.includes("not configured") ? 503 : 502).json({ message });
    }
    res.status(500).json({ message: "Could not send the message. Try again." });
  }
});
