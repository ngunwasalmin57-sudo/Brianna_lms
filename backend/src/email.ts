import nodemailer from "nodemailer";
import { config } from "./config";

export async function sendEmailCode(to: string, code: string, purpose: "registration" | "password_reset") {
  if (!config.emailConfigured) throw new Error("Email delivery is not configured.");
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  });
  const registration = purpose === "registration";
  const subject = registration ? "Verify your BML account email" : "Your BML password reset code";
  const action = registration ? "finish creating your account" : "reset your password";
  await transporter.sendMail({
    from: config.emailFrom,
    to,
    subject,
    text: `Your BML verification code is ${code}. Enter it to ${action}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<p>Your BML verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>Enter it to ${action}. It expires in 10 minutes.</p><p>If you did not request this, ignore this email.</p>`,
  });
}
