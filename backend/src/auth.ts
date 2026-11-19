import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { pool } from "./db";
import { can } from "./permissions";
import type { Permission, Role } from "./permissions";

export type { Role };

export interface JwtUser {
  id: number;
  username: string;
  role: Role | "customer";
  tokenVersion?: number;
}

const SESSION_ENDED = "Your session has ended. Sign in again.";

// Checks the person is signed in and the account is still switched on.
// The role comes from the database, not from the token, so changes apply straight away.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const cookieToken = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("bml_session="))?.slice("bml_session=".length);
  const token = header.startsWith("Bearer ") ? header.slice(7) : cookieToken ?? "";

  let id: number;
  try {
    id = (jwt.verify(token, config.jwtSecret) as JwtUser).id;
  } catch {
    return res.status(401).json({ message: SESSION_ENDED });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, username, role, active, status, admin_locked, token_version FROM users WHERE id = $1",
      [id]
    );
    const row = rows[0];
    const claims = jwt.verify(token, config.jwtSecret) as JwtUser;
    if (!row || !row.active || row.status !== "active" || row.admin_locked || Number(claims.tokenVersion ?? -1) !== Number(row.token_version)) {
      return res.status(401).json({ message: SESSION_ENDED });
    }
    res.locals.user = { id: row.id, username: row.username, role: row.role } as JwtUser;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong on the server. Try again." });
  }
}

// Checks the person is signed in and their role may do this.
export function allow(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) =>
    requireAuth(req, res, () => {
      const user = res.locals.user as JwtUser;
      if (!can(user.role, permission)) {
        return res.status(403).json({ message: "Your role cannot use this screen." });
      }
      next();
    });
}

// Checks the person is signed in and has one of these roles.
export function allowRoles(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) =>
    requireAuth(req, res, () => {
      const user = res.locals.user as JwtUser;
      if (!roles.includes(user.role)) {
        return res.status(403).json({ message: "Your role cannot use this screen." });
      }
      next();
    });
}
