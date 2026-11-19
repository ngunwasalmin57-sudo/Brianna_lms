import { Router } from "express";
import { pool } from "../db";
import { requireAuth, JwtUser } from "../auth";

export const messageRoutes = Router();

// Own inbox, newest first
messageRoutes.get("/", requireAuth, async (_req, res) => {
  try {
    const me = res.locals.user as JwtUser;
    const { rows } = await pool.query(
      `SELECT m.id, m.subject, m.body, m.sent_at, m.read_at, u.full_name AS sender_name
         FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.recipient_id = $1 ORDER BY m.sent_at DESC LIMIT 100`,
      [me.id]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.body,
        sentAt: r.sent_at,
        readAt: r.read_at,
        senderName: r.sender_name,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not load your messages. Try again." });
  }
});

messageRoutes.post("/:id/read", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid request." });
  try {
    const me = res.locals.user as JwtUser;
    const { rows } = await pool.query(
      "UPDATE messages SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND recipient_id = $2 RETURNING id",
      [id, me.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Message not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not update the message. Try again." });
  }
});
