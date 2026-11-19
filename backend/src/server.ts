import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { pool } from "./db";
import { authRoutes } from "./routes/authRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { adminRoutes } from "./routes/adminRoutes";
import { messageRoutes } from "./routes/messageRoutes";
import { dashboardRoutes } from "./routes/dashboardRoutes";
import { overviewRoutes } from "./routes/overviewRoutes";
import { groupRoutes } from "./routes/groupRoutes";
import { clientRoutes } from "./routes/clientRoutes";
import { assessmentRoutes } from "./routes/assessmentRoutes";
import { customerRoutes } from "./routes/customerRoutes";
import { loanRoutes } from "./routes/loanRoutes";
import { snippeRoutes } from "./routes/snippeRoutes";
import { managementRoutes } from "./routes/managementRoutes";

const app = express();
const emailChallengeCleanup = setInterval(() => {
  void pool.query("DELETE FROM email_challenges WHERE expires_at <= now()").catch(() => undefined);
}, 15 * 60 * 1000);
emailChallengeCleanup.unref();
// The production request path is client -> Caddy -> Nginx -> API.
app.set("trust proxy", process.env.NODE_ENV === "production" ? 2 : false);
app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      if (!origin || config.clientOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
app.use(express.json({ limit: "1mb", verify: (req, _res, body) => { (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(body); } }));
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/api/webhooks/snippe") return next();
  if ((req.headers.cookie ?? "").includes("bml_session=") && (!req.header("origin") || !config.clientOrigins.includes(req.header("origin")!))) return res.status(403).json({ message: "Request origin is not allowed." });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { message: "Too many sign-in attempts. Wait 15 minutes and try again." } });
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { message: "Too many registration attempts. Try again later." } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { message: "Too many password help requests. Try again later." } });
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/register", registrationLimiter);
app.use("/api/auth/register-staff", registrationLimiter);
app.use("/api/auth/register/verify", registrationLimiter);
app.use("/api/auth/register-staff/verify", registrationLimiter);
app.use("/api/auth/password-reset/start", resetLimiter);
app.use("/api/auth/password-reset/complete", resetLimiter);
app.use("/api/auth/password-reset-requests", resetLimiter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/health/ready", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT to_regclass('public.users') IS NOT NULL AS schema_ready");
    if (!rows[0]?.schema_ready) return res.status(503).json({ ok: false });
    res.json({ ok: true });
  }
  catch { res.status(503).json({ ok: false }); }
});
app.use("/api/auth", authRoutes);
app.use("/api/auth", accountRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api", snippeRoutes);
app.use("/api/management", managementRoutes);

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`BML LMS API running on http://localhost:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received; closing API and database connections.`);
  server.close(() => { void pool.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
