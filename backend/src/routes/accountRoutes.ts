import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { allowRoles, requireAuth, JwtUser } from "../auth";
import { audit } from "../audit";

// These share the /api/auth address with the sign-in routes.
export const accountRoutes = Router();

// ---------- staff registration requests (admin only) ----------

accountRoutes.get("/pending-users", allowRoles("admin"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, full_name, phone, requested_role, requested_zone, created_at
         FROM users WHERE status = 'pending' ORDER BY created_at`
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.full_name,
        phone: r.phone,
        requestedRole: r.requested_role,
        requestedZone: r.requested_zone,
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the requests. Try again." });
  }
});

// Approving switches the account on with the role that was asked for.
accountRoutes.post("/pending-users/:id/approve", allowRoles("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid request." });
  const admin = res.locals.user as JwtUser;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: pending } = await client.query(
      "SELECT username, requested_role, requested_zone FROM users WHERE id = $1 AND status = 'pending' FOR UPDATE", [id]
    );
    if (!pending.length) { await client.query("ROLLBACK"); return res.status(404).json({ message: "This request was already handled or does not exist." }); }
    const request = pending[0];
    if (request.requested_role === "supervisor") {
      const zone = String(request.requested_zone ?? "").trim();
      if (!zone) { await client.query("ROLLBACK"); return res.status(400).json({ message: "This supervisor request has no zone. Ask them to submit it again with a zone." }); }
      const existing = await client.query("SELECT 1 FROM supervisor_zones WHERE lower(zone) = lower($1)", [zone]);
      if (existing.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ message: `The ${zone} zone already has a supervisor assigned.` }); }
    }
    const { rows } = await client.query(
      `UPDATE users SET status = 'active', active = TRUE, role = requested_role
        WHERE id = $1 AND status = 'pending' RETURNING username, role, requested_zone`, [id]
    );
    if (rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ message: "This request was already handled or does not exist." }); }
    if (rows[0].role === "supervisor") {
      await client.query("INSERT INTO supervisor_zones (zone, supervisor_id) VALUES ($1, $2)", [rows[0].requested_zone.trim().toLowerCase(), id]);
    }
    await client.query("COMMIT");
    await audit(admin.username, "Staff registration approved", rows[0].username, rows[0].role === "supervisor" ? `${rows[0].role} · ${rows[0].requested_zone}` : rows[0].role);
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(err);
    res.status(500).json({ message: "Could not approve the request. Try again." });
  } finally { client.release(); }
});

// Rejecting removes the request, so the person can apply again.
accountRoutes.delete("/pending-users/:id", allowRoles("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid request." });
  const admin = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      "DELETE FROM users WHERE id = $1 AND status = 'pending' RETURNING username",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This request was already handled or does not exist." });
    }
    await audit(admin.username, "Staff registration rejected", rows[0].username);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not reject the request. Try again." });
  }
});

// ---------- own profile (any signed-in person) ----------

accountRoutes.patch("/profile", requireAuth, async (req, res) => {
  const me = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query("SELECT username, full_name, profile_image, password_hash FROM users WHERE id = $1", [me.id]);
    if (!rows[0]) return res.status(404).json({ message: "Your account could not be found." });
    let username: string = rows[0].username;
    let fullName: string = rows[0].full_name;
    let image: string | null = rows[0].profile_image;

    if (req.body?.username !== undefined) {
      const nextUsername = String(req.body.username).trim().toLowerCase();
      const currentPassword = String(req.body.currentPassword ?? "");
      if (!/^[^\s\p{C}]{3,30}$/u.test(nextUsername)) return res.status(400).json({ message: "Choose a username with 3 to 30 characters and no spaces." });
      if (nextUsername !== username && !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
        return res.status(400).json({ message: "Enter your current password to change your username." });
      }
      username = nextUsername;
    }

    if (req.body?.fullName !== undefined) {
      const name = String(req.body.fullName).trim();
      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ message: "Enter your full name." });
      }
      fullName = name;
    }
    if (req.body?.profileImage !== undefined) {
      const img = req.body.profileImage;
      if (img === "" || img === null) {
        image = null;
      } else if (typeof img !== "string" || !img.startsWith("data:image/") || img.length > 700_000) {
        return res.status(400).json({ message: "Choose a smaller photo (a JPG or PNG under about 500 KB)." });
      } else {
        image = img;
      }
    }

    await pool.query("UPDATE users SET username = $1, full_name = $2, profile_image = $3 WHERE id = $4", [username, fullName, image, me.id]);
    await audit(me.username, username === me.username ? "Profile updated" : "Username changed", username === me.username ? "" : username);
    res.json({ ok: true, username, fullName, ...(image ? { profileImage: image } : {}) });
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ message: "That username is already in use." });
    console.error(err);
    res.status(500).json({ message: "Could not save your profile. Try again." });
  }
});
