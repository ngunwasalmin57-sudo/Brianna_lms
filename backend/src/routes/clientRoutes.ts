import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { allow, requireAuth, JwtUser } from "../auth";
import { audit } from "../audit";
import { normalizePhone } from "../validation";

export const clientRoutes = Router();

const SOURCES = ["self", "staff", "officer"];

interface ClientValues {
  source: string;
  fullName: string;
  nationalId: string;
  phone: string;
  businessType: string;
  businessLocation: string;
  introducedBy: string;
}

function parse(body: any): { error: string } | { value: ClientValues } {
  const source = String(body?.source ?? "");
  const fullName = String(body?.fullName ?? "").trim();
  const nationalId = String(body?.nationalId ?? "").replace(/\s/g, "").toUpperCase();
  const phone = normalizePhone(String(body?.phone ?? ""));
  const businessType = String(body?.businessType ?? "").trim();
  const businessLocation = String(body?.businessLocation ?? "").trim();
  const introducedBy = String(body?.introducedBy ?? "").trim();

  if (!SOURCES.includes(source)) return { error: "Choose the registration source." };
  if (!fullName) return { error: "Enter the client's full name." };
  if (!/^[A-Z0-9]{8,20}$/.test(nationalId)) {
    return { error: "Enter a valid national ID (8 to 20 letters or digits)." };
  }
  if (!phone) return { error: "Enter a valid phone number, for example 0712 345 678." };
  if (!businessType) return { error: "Enter the business type." };
  if (!businessLocation) return { error: "Enter the business location." };

  return { value: { source, fullName, nationalId, phone, businessType, businessLocation, introducedBy } };
}

function duplicateMessage(err: any): string | null {
  if (err?.code !== "23505") return null;
  const c = String(err.constraint ?? "");
  if (c.includes("national_id")) return "A client with this ID number is already registered.";
  if (c.includes("phone")) return "A client with this phone number is already registered.";
  return "This client is already registered.";
}

async function officerName(userId: number): Promise<string> {
  const { rows } = await pool.query("SELECT full_name FROM users WHERE id = $1", [userId]);
  return rows[0]?.full_name ?? "";
}

clientRoutes.use(allow("customers.add"));

// Own applications, newest first
clientRoutes.get("/", async (_req, res) => {
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name AS "fullName", application_status AS status,
              introduced_at AS "introducedAt", business_type AS "businessType"
         FROM clients
        WHERE officer_id = $1 AND application_status IS NOT NULL
        ORDER BY introduced_at DESC`,
      [user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the clients. Try again." });
  }
});

// One application
clientRoutes.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid client." });
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `SELECT id, source, full_name AS "fullName", national_id AS "nationalId", phone,
              business_type AS "businessType", business_location AS "businessLocation",
              introduced_by AS "introducedBy", introduced_at AS "introducedAt",
              application_status AS status
         FROM clients
        WHERE id = $1 AND officer_id = $2 AND application_status IS NOT NULL`,
      [id, user.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Client not found." });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load the client. Try again." });
  }
});

// Save a new application as a draft. The introduced time is stamped here.
clientRoutes.post("/", async (req, res) => {
  const parsed = parse(req.body);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const user = res.locals.user as JwtUser;
  try {
    const introducedBy = v.introducedBy || (await officerName(user.id));
    const { rows } = await pool.query(
      `INSERT INTO clients
         (full_name, officer_id, national_id, phone, business_type, business_location,
          source, introduced_by, introduced_at, application_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'draft')
       RETURNING id, application_status AS status,
                 introduced_at AS "introducedAt", introduced_by AS "introducedBy"`,
      [v.fullName, user.id, v.nationalId, v.phone, v.businessType, v.businessLocation, v.source, introducedBy]
    );
    await audit(user.username, "Client registered (draft)", v.fullName);
    res.status(201).json(rows[0]);
  } catch (err) {
    const dup = duplicateMessage(err);
    if (dup) return res.status(409).json({ message: dup });
    console.error(err);
    res.status(500).json({ message: "Could not save the client. Try again." });
  }
});

// Update a draft. The introduced time never changes.
clientRoutes.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid client." });
  const parsed = parse(req.body);
  if ("error" in parsed) return res.status(400).json({ message: parsed.error });
  const v = parsed.value;
  const user = res.locals.user as JwtUser;
  try {
    const introducedBy = v.introducedBy || (await officerName(user.id));
    const { rows } = await pool.query(
      `UPDATE clients
          SET full_name = $1, national_id = $2, phone = $3, business_type = $4,
              business_location = $5, source = $6, introduced_by = $7
        WHERE id = $8 AND officer_id = $9 AND application_status = 'draft'
        RETURNING id, application_status AS status,
                  introduced_at AS "introducedAt", introduced_by AS "introducedBy"`,
      [v.fullName, v.nationalId, v.phone, v.businessType, v.businessLocation, v.source, introducedBy, id, user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This application can no longer be edited." });
    }
    await audit(user.username, "Client draft updated", v.fullName);
    res.json(rows[0]);
  } catch (err) {
    const dup = duplicateMessage(err);
    if (dup) return res.status(409).json({ message: dup });
    console.error(err);
    res.status(500).json({ message: "Could not save the client. Try again." });
  }
});

// Submit the application
clientRoutes.post("/:id/submit", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid client." });
  const user = res.locals.user as JwtUser;
  try {
    const { rows } = await pool.query(
      `UPDATE clients SET application_status = 'submitted'
        WHERE id = $1 AND officer_id = $2 AND application_status = 'draft'
        RETURNING id, full_name, application_status AS status`,
      [id, user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This application was already submitted or does not exist." });
    }
    await audit(user.username, "Application submitted", rows[0].full_name);
    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not submit the application. Try again." });
  }
});
