import { Router } from "express";
import { pool } from "../db";
import { requireAuth, allowRoles, JwtUser } from "../auth";
import { audit } from "../audit";

export const customerRoutes = Router();

function publicRequest(row: any) {
  return {
    id: row.id, requestType: row.request_type, summary: row.summary, details: row.details,
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    customerName: row.customer_name, customerPhone: row.customer_phone,
    zone: row.zone, assignedSupervisor: row.supervisor_name,
    assignedOfficerId: row.assigned_officer_id, assignedOfficer: row.officer_name,
  };
}

customerRoutes.get("/zones", requireAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT ON (lower(trim(zone))) trim(zone) AS zone FROM (
      SELECT zone FROM loan_groups WHERE trim(zone) <> ''
      UNION ALL SELECT zone FROM supervisor_zones WHERE trim(zone) <> ''
    ) available_zones ORDER BY lower(trim(zone)), trim(zone)`);
    res.json(rows.map((row) => row.zone));
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not load zones." }); }
});

customerRoutes.get("/officers", allowRoles("supervisor"), async (_req, res) => {
  const supervisor = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(`SELECT u.id, u.username, u.full_name AS "fullName",
        array_agg(DISTINCT trim(lg.zone)) AS zones FROM users u
      WHERE u.role = 'loan_officer' AND u.status = 'active' AND u.active
        AND EXISTS (SELECT 1 FROM loan_groups lg JOIN supervisor_zones sz ON lower(trim(sz.zone))=lower(trim(lg.zone))
                     WHERE lg.officer_id=u.id AND sz.supervisor_id=$1)
      GROUP BY u.id, u.username, u.full_name
      ORDER BY u.full_name`, [supervisor.id]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not load loan officers." }); }
});

customerRoutes.get("/requests", requireAuth, async (_req, res) => {
  const user = res.locals.user as JwtUser;
  try {
    let predicate = "r.customer_id = $1";
    if (user.role === "supervisor") predicate = `EXISTS (
      SELECT 1 FROM supervisor_zones sz
       WHERE sz.supervisor_id = $1
         AND lower(trim(sz.zone)) = lower(trim(COALESCE(NULLIF(r.zone, ''), r.details ->> 'zone', '')))
    )`;
    else if (user.role === "loan_officer") predicate = "r.assigned_officer_id = $1 AND r.request_type = 'assessment'";
    else if (user.role === "director" || user.role === "ceo") predicate = "TRUE";
    else if (user.role !== "customer") return res.status(403).json({ message: "Your role cannot view customer requests." });
    const { rows } = await pool.query(
      `SELECT r.*, c.full_name AS customer_name, c.phone AS customer_phone,
              s.full_name AS supervisor_name, o.full_name AS officer_name
         FROM customer_requests r JOIN users c ON c.id = r.customer_id
         LEFT JOIN users s ON s.id = r.assigned_supervisor_id
         LEFT JOIN users o ON o.id = r.assigned_officer_id
        WHERE ${predicate} ORDER BY r.created_at DESC`, [user.id]
    );
    res.json(rows.map(publicRequest));
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not load customer requests." }); }
});

customerRoutes.post("/requests", allowRoles("customer"), async (req, res) => {
  const user = res.locals.user as JwtUser;
  const requestType = String(req.body?.requestType ?? "");
  const summary = String(req.body?.summary ?? "").trim();
  const details = req.body?.details;
  if (!["loan", "group_registration", "assessment", "member_performance"].includes(requestType)) return res.status(400).json({ message: "Choose a valid request type." });
  if (!summary || summary.length > 160 || !details || typeof details !== "object" || Array.isArray(details)) return res.status(400).json({ message: "Complete the request details." });
  const zone = String(details.zone ?? "").trim();
  if (!zone || zone.length > 100) return res.status(400).json({ message: "Select your service zone before submitting the request." });
  try {
    if (requestType === "assessment") {
      const registered = await pool.query(
        `SELECT details ->> 'zone' AS zone FROM customer_requests
          WHERE customer_id = $1 AND request_type = 'group_registration' ORDER BY created_at DESC LIMIT 1`, [user.id]
      );
      if (!registered.rows[0]?.zone || registered.rows[0].zone.trim().toLowerCase() !== (zone ?? "").toLowerCase()) {
        return res.status(400).json({ message: "Submit a group registration with its service zone before requesting an assessment." });
      }
    }
    const mapped = await pool.query(
      `SELECT sz.supervisor_id FROM supervisor_zones sz JOIN users u ON u.id=sz.supervisor_id
        WHERE lower(trim(sz.zone))=lower(trim($1)) AND u.role='supervisor' AND u.active AND u.status='active'`, [zone]
    );
    if (!mapped.rows[0]) return res.status(409).json({ message: `No active supervisor is assigned to the ${zone} zone yet. Please contact BML.` });
    const supervisorId = Number(mapped.rows[0].supervisor_id);
    const client = await pool.connect();
    let request: any;
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO customer_requests (customer_id, request_type, summary, details, zone, assigned_supervisor_id)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *`,
        [user.id, requestType, summary, JSON.stringify({ ...details, zone }), zone, supervisorId]
      );
      request = inserted.rows[0];
      await client.query(`INSERT INTO messages (sender_id, recipient_id, subject, body) VALUES ($1,$2,$3,$4)`,
        [user.id, supervisorId, `New ${requestType.replace(/_/g, " ")} request`, `A customer submitted a ${requestType.replace(/_/g, " ")} request for the ${zone} zone. Request: ${summary}`]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally { client.release(); }
    await audit(user.username, "Customer request submitted", summary, requestType === "assessment" ? `Assessment · ${zone}` : requestType);
    res.status(201).json(publicRequest({ ...request, customer_name: null, customer_phone: null }));
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not submit the request." }); }
});

customerRoutes.patch("/requests/:id", requireAuth, async (req, res) => {
  const user = res.locals.user as JwtUser;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Invalid request." });
  try {
    if (user.role === "supervisor") {
      const officerId = Number(req.body?.assignedOfficerId);
      if (!Number.isInteger(officerId) || officerId < 1) return res.status(400).json({ message: "Choose a loan officer to assign this visit." });
      const { rows } = await pool.query(
        `UPDATE customer_requests r SET assigned_officer_id = $3, status = 'reviewing', updated_at = now()
          WHERE r.id = $1 AND r.request_type = 'assessment'
            AND EXISTS (SELECT 1 FROM supervisor_zones sz WHERE sz.supervisor_id=$2 AND lower(trim(sz.zone))=lower(trim(r.zone)))
            AND EXISTS (SELECT 1 FROM users u WHERE u.id = $3 AND u.role = 'loan_officer' AND u.active AND u.status = 'active'
              AND EXISTS (SELECT 1 FROM loan_groups lg JOIN supervisor_zones sz ON lower(trim(sz.zone))=lower(trim(lg.zone))
                           WHERE lg.officer_id=u.id AND sz.supervisor_id=$2 AND lower(trim(lg.zone))=lower(trim(r.zone))))
          RETURNING r.summary`, [id, user.id, officerId]
      );
      if (!rows.length) return res.status(404).json({ message: "This assessment request or loan officer is unavailable." });
      await pool.query(`INSERT INTO messages (sender_id, recipient_id, subject, body)
        SELECT $1, $2, 'Assessment visit assigned', $3
        WHERE EXISTS (SELECT 1 FROM users WHERE id=$2 AND role='loan_officer' AND active AND status='active')`,
        [user.id, officerId, `You have been assigned an assessment visit in your zone. Request: ${rows[0].summary}`]);
      await audit(user.username, "Assessment visit assigned", rows[0].summary, `Officer ${officerId}`);
      return res.json({ ok: true });
    }
    if (user.role !== "loan_officer") return res.status(403).json({ message: "Your role cannot update this request." });
    const status = String(req.body?.status ?? "");
    if (!["visited", "approved", "rejected", "completed"].includes(status)) return res.status(400).json({ message: "Invalid request status." });
    const visitNotes = String(req.body?.visitNotes ?? "").trim();
    const { rows } = await pool.query(
      `UPDATE customer_requests SET status = $3, visit_notes = CASE WHEN $3 = 'visited' THEN $4 ELSE visit_notes END, updated_at = now()
        WHERE id = $1 AND assigned_officer_id = $2 AND request_type = 'assessment' AND status = 'reviewing'
        RETURNING summary`, [id, user.id, status, visitNotes]
    );
    if (!rows.length) return res.status(404).json({ message: "This assessment is not assigned to you or is already handled." });
    await audit(user.username, "Assessment visit updated", rows[0].summary, status);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ message: "Could not update the request." }); }
});
