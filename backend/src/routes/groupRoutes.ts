import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { allow, requireAuth, JwtUser } from "../auth";
import { audit } from "../audit";

export const groupRoutes = Router();

const MEETING_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface GroupValues {
  name: string;
  location: string;
  centre: string;
  zone: string;
  membersExpected: number;
  meetingDay: string;
  notes: string;
}

function parse(body: any): { error: string } | { value: GroupValues } {
  const name = String(body?.name ?? "").trim();
  const location = String(body?.location ?? "").trim();
  const centre = String(body?.centre ?? "").trim();
  const zone = String(body?.zone ?? "").trim();
  const meetingDay = String(body?.meetingDay ?? "").trim();
  const notes = String(body?.notes ?? "").trim();
  const membersExpected = Number(body?.membersExpected);

  if (!name) return { error: "Enter the proposed group name." };
  if (!location) return { error: "Enter the group location." };
  if (!centre || !zone) return { error: "Choose a centre and a zone." };
  if (!Number.isInteger(membersExpected) || membersExpected < 1 || membersExpected > 500) {
    return { error: "Members expected must be a whole number from 1 to 500." };
  }
  if (!MEETING_DAYS.includes(meetingDay)) return { error: "Choose the meeting day." };

  return { value: { name, location, centre, zone, membersExpected, meetingDay, notes } };
}

groupRoutes.use(allow("groups.manage"));

// Save a new group as a prospect
groupRoutes.post("/", async (req, res) => {
  const parsed = parse(req.body);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `INSERT INTO loan_groups
         (name, location, centre, zone, members_expected, meeting_day, notes, officer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, status`,
      [v.name, v.location, v.centre, v.zone, v.membersExpected, v.meetingDay, v.notes, user.id]
    );
    await audit(user.username, "Group saved as prospect", v.name);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the group. Try again." });
  }
});

// Update a prospect that was saved earlier
groupRoutes.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid group." });
  const parsed = parse(req.body);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `UPDATE loan_groups
          SET name = $1, location = $2, centre = $3, zone = $4,
              members_expected = $5, meeting_day = $6, notes = $7
        WHERE id = $8 AND officer_id = $9 AND status = 'prospect'
        RETURNING id, status`,
      [v.name, v.location, v.centre, v.zone, v.membersExpected, v.meetingDay, v.notes, id, user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This group can no longer be edited here." });
    }
    await audit(user.username, "Group prospect updated", v.name);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not save the group. Try again." });
  }
});

// Convert a prospect to registration
groupRoutes.post("/:id/convert", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid group." });
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `UPDATE loan_groups SET status = 'registration'
        WHERE id = $1 AND officer_id = $2 AND status = 'prospect'
        RETURNING id, name, status`,
      [id, user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This group was already converted or does not exist." });
    }
    await audit(user.username, "Group converted to registration", rows[0].name);
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not convert the group. Try again." });
  }
});

// ---------- A2 Group and member registration ----------

const MEMBER_ROLES = ["Leader", "Secretary", "Treasurer", "Member"];

function maskId(v: string): string {
  return v.slice(0, 4) + "•••••";
}

function maskPhone(v: string): string {
  return v.slice(0, 4) + " •••";
}

// Accepts 0712345678, 712345678-style input with +255 or 255 prefix. Stores 07XXXXXXXX.
function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  const m = s.match(/^(?:\+?255|0)([67]\d{8})$/);
  return m ? "0" + m[1] : null;
}

async function ownGroup(id: number, officerId: number) {
  const { rows } = await pool.query(
    "SELECT id, name, status FROM loan_groups WHERE id = $1 AND officer_id = $2",
    [id, officerId]
  );
  return rows[0] as { id: number; name: string; status: string } | undefined;
}

// Groups of the signed-in officer, optionally filtered by status
groupRoutes.get("/", async (req, res) => {
  const user = res.locals.user as JwtUser;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  try {
    const { rows } = await pool.query(
      `SELECT g.id, g.name, g.status, g.members_expected AS "membersExpected",
              (SELECT count(*) FROM members m WHERE m.group_id = g.id)::int AS "memberCount"
         FROM loan_groups g
        WHERE g.officer_id = $1 AND ($2::text IS NULL OR g.status = $2)
        ORDER BY g.created_at DESC`,
      [user.id, status]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the groups. Try again." });
  }
});

// One group with its members (ID and phone are masked)
groupRoutes.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid group." });
  const user = res.locals.user as JwtUser;
  try {
    const g = await pool.query(
      `SELECT id, name, location, centre, zone, members_expected AS "membersExpected",
              meeting_day AS "meetingDay", notes, status
         FROM loan_groups WHERE id = $1 AND officer_id = $2`,
      [id, user.id]
    );
    if (!g.rows[0]) return res.status(404).json({ message: "Group not found." });

    const m = await pool.query(
      `SELECT id, full_name, national_id, phone, business, role
         FROM members WHERE group_id = $1 ORDER BY id`,
      [id]
    );
    res.json({
      ...g.rows[0],
      members: m.rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        idMasked: maskId(r.national_id),
        phoneMasked: maskPhone(r.phone),
        business: r.business,
        role: r.role,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the group. Try again." });
  }
});

// Add a member
groupRoutes.post("/:id/members", async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: "Invalid group." });
  const user = res.locals.user as JwtUser;

  const fullName = String(req.body?.fullName ?? "").trim();
  const nationalId = String(req.body?.nationalId ?? "").replace(/\s/g, "").toUpperCase();
  const phone = normalizePhone(String(req.body?.phone ?? ""));
  const business = String(req.body?.business ?? "").trim();
  const role = String(req.body?.role ?? "");

  if (!fullName) return res.status(400).json({ message: "Enter the member's full name." });
  if (!/^[A-Z0-9]{8,20}$/.test(nationalId)) {
    return res.status(400).json({ message: "Enter a valid ID number (8 to 20 letters or digits)." });
  }
  if (!phone) {
    return res.status(400).json({ message: "Enter a valid phone number, for example 0712 345 678." });
  }
  if (!business) return res.status(400).json({ message: "Enter the member's business." });
  if (!MEMBER_ROLES.includes(role)) return res.status(400).json({ message: "Choose a role." });

  try {
    const group = await ownGroup(groupId, user.id);
    if (!group) return res.status(404).json({ message: "Group not found." });
    if (group.status !== "registration") {
      return res.status(409).json({ message: "Members can only be changed while the group is in registration." });
    }

    if (role !== "Member") {
      const taken = await pool.query("SELECT 1 FROM members WHERE group_id = $1 AND role = $2", [groupId, role]);
      if (taken.rows.length > 0) {
        return res.status(409).json({ message: `This group already has a ${role.toLowerCase()}.` });
      }
    }

    const dup = await pool.query(
      `SELECT m.group_id
         FROM members m JOIN loan_groups g ON g.id = m.group_id
        WHERE (m.national_id = $1 OR m.phone = $2) AND g.status <> 'closed'
        LIMIT 1`,
      [nationalId, phone]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({
        message:
          dup.rows[0].group_id === groupId
            ? "This person is already in this group."
            : "This ID or phone number already belongs to a member of another active group. Check the details or ask your supervisor.",
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO members (group_id, full_name, national_id, phone, business, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [groupId, fullName, nationalId, phone, business, role]
    );
    await audit(user.username, "Member added", group.name, fullName);
    res.status(201).json({
      id: rows[0].id,
      fullName,
      idMasked: maskId(nationalId),
      phoneMasked: maskPhone(phone),
      business,
      role,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ message: `This group already has a ${role.toLowerCase()}.` });
    }
    console.error(err);
    res.status(500).json({ message: "Could not save the member. Try again." });
  }
});

// Remove a member
groupRoutes.delete("/:id/members/:memberId", async (req, res) => {
  const groupId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  if (!Number.isInteger(groupId) || !Number.isInteger(memberId)) {
    return res.status(400).json({ message: "Invalid request." });
  }
  const user = res.locals.user as JwtUser;
  try {
    const group = await ownGroup(groupId, user.id);
    if (!group) return res.status(404).json({ message: "Group not found." });
    if (group.status !== "registration") {
      return res.status(409).json({ message: "Members can only be changed while the group is in registration." });
    }
    const { rows } = await pool.query(
      "DELETE FROM members WHERE id = $1 AND group_id = $2 RETURNING full_name",
      [memberId, groupId]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Member not found." });
    await audit(user.username, "Member removed", group.name, rows[0].full_name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not remove the member. Try again." });
  }
});

// Submit the group for field assessment
groupRoutes.post("/:id/submit", async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ message: "Invalid group." });
  const user = res.locals.user as JwtUser;
  try {
    const group = await ownGroup(groupId, user.id);
    if (!group) return res.status(404).json({ message: "Group not found." });
    if (group.status !== "registration") {
      return res.status(409).json({ message: "This group was already submitted." });
    }

    const counts = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE role = 'Leader')::int AS leaders
         FROM members WHERE group_id = $1`,
      [groupId]
    );
    if (counts.rows[0].total === 0) {
      return res.status(400).json({ message: "Add at least one member before submitting." });
    }
    if (counts.rows[0].leaders === 0) {
      return res.status(400).json({ message: "Choose a group leader before submitting." });
    }

    await pool.query("UPDATE loan_groups SET status = 'assessment' WHERE id = $1", [groupId]);
    await audit(user.username, "Group submitted for assessment", group.name);
    res.json({ id: groupId, status: "assessment" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not submit the group. Try again." });
  }
});
