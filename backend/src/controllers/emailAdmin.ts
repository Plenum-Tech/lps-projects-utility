import type { Request, Response } from "express";
import { companyName, sendEmailOrThrow, smtpErrorHint, testEmailTemplate, verifyEmailTransport } from "../lib/email.js";
import { firstNameOf } from "../lib/notifications.js";

interface TestEmailBody {
  to?: unknown;
}

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

/** Admin: SMTP status (configured, host, from, redirect, verify result). */
export async function emailStatus(_req: Request, res: Response): Promise<void> {
  const status = await verifyEmailTransport();
  res.json({ status });
}

/**
 * Admin: verifies the SMTP connection, then sends a test email
 * (defaults to the admin's own address). Surfaces Microsoft 365 hints on failure.
 */
export async function sendTestEmail(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { to } = (req.body ?? {}) as TestEmailBody;

  if (to !== undefined && to !== null && to !== "" && (typeof to !== "string" || !EMAIL_PATTERN.test(to.trim()))) {
    res.status(400).json({ error: "to must be a valid email address" });
    return;
  }
  const recipient = typeof to === "string" && to.trim() ? to.trim().toLowerCase() : user.email;

  const status = await verifyEmailTransport();
  if (!status.ok) {
    res.status(502).json({ error: status.error ?? "SMTP verification failed", hint: status.hint, status });
    return;
  }

  let info: { messageId?: string; response?: string } = {};
  try {
    info = await sendEmailOrThrow({
      to: recipient,
      subject: `${companyName()} SMTP test email`,
      html: testEmailTemplate({ firstName: firstNameOf(user.name), host: status.host }),
      text: `This is a test email from ${companyName()}. SMTP delivery is working.`,
    });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to send test email",
      hint: smtpErrorHint(err),
      status,
    });
    return;
  }

  res.json({ success: true, to: recipient, deliveredTo: status.redirectTo ?? recipient, smtpResponse: info.response ?? null, messageId: info.messageId ?? null, status });
}
