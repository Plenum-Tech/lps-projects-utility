import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { DEFAULT_COMPANY_NAME } from "../models/CompanySettings.js";
import { apiPublicOrigin, companySettings, logoApiPath, settingsAppUrl } from "./companySettings.js";

// ---------------------------------------------------------------------------
// SMTP transport (Microsoft 365) — created lazily on first use so the app still
// boots without credentials (sending is skipped with a single warning).
// Credentials come from backend/.env only; nothing is stored in the DB.
// ---------------------------------------------------------------------------

let transporter: Transporter | null = null;
let warnedMissingConfig = false;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** Master switch: EMAIL_ENABLED=false blocks every outgoing email, even with SMTP configured. */
export function emailDisabledBySwitch(): boolean {
  return process.env.EMAIL_ENABLED?.trim().toLowerCase() === "false";
}

function readSmtpConfig(): SmtpConfig | null {
  if (emailDisabledBySwitch()) return null;
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = (process.env.SMTP_SECURE ?? "false").toLowerCase() === "true";
  return { host, port, secure, user, pass };
}

/** True when SMTP credentials are configured (emails will actually be attempted). */
export function emailConfigured(): boolean {
  return readSmtpConfig() !== null;
}

/** Returns the pooled transporter, or null (with one warning) when SMTP is not configured. */
function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const config = readSmtpConfig();
  if (!config) {
    if (!warnedMissingConfig) {
      console.warn(
        emailDisabledBySwitch()
          ? "[email] EMAIL_ENABLED=false — all outgoing email is switched off"
          : "[email] SMTP_HOST / SMTP_USER / SMTP_PASS not set — emails will not be sent"
      );
      warnedMissingConfig = true;
    }
    return null;
  }

  transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 3,
    host: config.host,
    port: config.port,
    // false on 587 → STARTTLS upgrade (required by Microsoft 365)
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  return transporter;
}

function getFromAddress(): string {
  // FROM_NAME wins when set; otherwise the company name from settings.
  const name = process.env.FROM_NAME?.trim() || companySettings().name || DEFAULT_COMPANY_NAME;
  const email = process.env.FROM_EMAIL || process.env.SMTP_USER || "";
  return `"${name.replace(/["\\\r\n<>]/g, "")}" <${email}>`;
}

/** Microsoft 365 auth failures come back as 535 5.7.139 — explain the usual fixes. */
export function smtpErrorHint(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/535\s*5\.7\.139/.test(message) || /5\.7\.139/.test(message)) {
    return "Microsoft 365 rejected the login (535 5.7.139): SMTP AUTH is disabled for this mailbox, or MFA requires an app password.";
  }
  if (/535/.test(message)) {
    return "SMTP authentication failed — check SMTP_USER / SMTP_PASS.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(message)) {
    return "Could not reach the SMTP server — check SMTP_HOST / SMTP_PORT and outbound firewall rules.";
  }
  if (/SendAsDenied|5\.7\.60/.test(message)) {
    return "The mailbox is not allowed to send as FROM_EMAIL — set FROM_EMAIL equal to SMTP_USER or grant Send As.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Email sending helpers — fire-and-forget, errors are swallowed
// ---------------------------------------------------------------------------

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Applies the dev-only EMAIL_REDIRECT_TO override: every message goes to that
 * address and the subject is prefixed with the original recipient.
 */
function resolveRecipient(params: SendEmailParams): { to: string; subject: string } {
  const redirect = process.env.EMAIL_REDIRECT_TO?.trim();
  if (!redirect) return { to: params.to, subject: params.subject };
  return { to: redirect, subject: `[to: ${params.to}] ${params.subject}` };
}

/** Rough plain-text rendering of an email's HTML (links kept as "label: url"). */
export function plainTextOf(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return text && text !== href ? `${text}: ${href}` : href;
    })
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)[^>]*>/gi, "\n")
    .replace(/<\/td>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sends one email and throws on failure — used by the admin test endpoint. */
export async function sendEmailOrThrow(params: SendEmailParams): Promise<{ messageId?: string; response?: string; accepted?: unknown[] }> {
  const client = getTransporter();
  if (!client) throw new Error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)");

  const { to, subject } = resolveRecipient(params);
  const info = await client.sendMail({
    from: getFromAddress(),
    to,
    subject,
    html: params.html.trim(),
    // Always include a plain-text part: some clients (notably Outlook desktop)
    // show an empty body for HTML-only messages they cannot render.
    text: params.text ?? plainTextOf(params.html),
  });
  // One line per accepted message, so delivery questions can start from the server log.
  console.log(`[email] sent to=${to} subject="${subject}" response="${info.response ?? ""}"`);
  return info;
}

/**
 * Sends a single email to the real recipient (or EMAIL_REDIRECT_TO when set).
 * Failures are caught and logged — never throws.
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  if (!getTransporter()) return;

  try {
    await sendEmailOrThrow(params);
  } catch (err) {
    const hint = smtpErrorHint(err);
    console.error("[email] Send failed to", params.to, err instanceof Error ? err.message : err);
    if (hint) console.error("[email] Hint:", hint);
  }
}

/**
 * Sends every item with a concurrency of 3 (matches the pool size).
 * Failures are caught and logged per item — never throws.
 */
export async function sendBatchEmails(items: SendEmailParams[]): Promise<void> {
  if (items.length === 0) return;
  if (!getTransporter()) {
    // Dev aid: EMAIL_LOG_SKIPPED=true lists what would have been sent without SMTP.
    if (process.env.EMAIL_LOG_SKIPPED === "true") {
      for (const item of items) console.log(`[email] skipped (SMTP off) to=${item.to} subject="${item.subject}"`);
    }
    return;
  }

  const queue = [...items];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await sendEmail(item);
    }
  });
  await Promise.all(workers);
}

export interface VerifyResult {
  ok: boolean;
  configured: boolean;
  host: string | null;
  from: string | null;
  redirectTo: string | null;
  error?: string;
  hint?: string;
}

/** Verifies the SMTP connection + login. Never throws. */
export async function verifyEmailTransport(): Promise<VerifyResult> {
  const config = readSmtpConfig();
  const base = {
    configured: Boolean(config),
    host: config?.host ?? null,
    from: config ? getFromAddress() : null,
    redirectTo: process.env.EMAIL_REDIRECT_TO?.trim() || null,
  };

  const client = getTransporter();
  if (!client) {
    return { ...base, ok: false, error: "SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)" };
  }

  try {
    await client.verify();
    return { ...base, ok: true };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hint: smtpErrorHint(err),
    };
  }
}

/** Logs the SMTP status once at startup. */
export async function logEmailTransportStatus(): Promise<void> {
  const result = await verifyEmailTransport();
  if (result.ok) {
    console.log(`✅ SMTP ready (${result.host})`);
  } else if (result.configured) {
    console.warn(`⚠️  SMTP not ready (${result.host}): ${result.error}`);
    if (result.hint) console.warn(`⚠️  ${result.hint}`);
  }
  // Not configured → getTransporter() already printed its warning.
}

// ---------------------------------------------------------------------------
// Escaping — ALL user-supplied text must go through this before hitting HTML
// ---------------------------------------------------------------------------

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes and keeps line breaks. */
function escapeMultiline(value: unknown): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

/** Frontend base URL (no trailing slash): Company Settings → APP_URL env → localhost:5173. */
export function appUrl(): string {
  return settingsAppUrl();
}

/** Product name shown in every email header, footer and subject suffix. */
export const PRODUCT_NAME = "LPS Projects Utility";

/** Company name for email copy (plain text — escape before putting it in HTML). */
export function companyName(): string {
  return companySettings().name || DEFAULT_COMPANY_NAME;
}

// ---------------------------------------------------------------------------
// Email templates — clean, responsive HTML with inline styles
// ---------------------------------------------------------------------------

const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: #1f2937;
  max-width: 600px;
  margin: 0 auto;
`;

const HEADER_STYLE = `
  padding: 8px 0 20px;
  text-align: center;
`;

const BODY_STYLE = `
  background-color: #ffffff;
  padding: 32px 36px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
`;

const FOOTER_STYLE = `
  text-align: center;
  padding: 16px;
  color: #6b7280;
  font-size: 12px;
`;

const BADGE_STYLE = `
  display: inline-block;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 14px;
  font-weight: 600;
  margin: 8px 0;
`;

const BUTTON_STYLE = `
  display: inline-block;
  background-color: #16a34a;
  color: #ffffff !important;
  text-decoration: none;
  padding: 12px 24px;
  border-radius: 6px;
  font-weight: 600;
  margin: 16px 0;
`;

/**
 * Absolute logo URL for emails, or null. SVG is skipped (most mail clients don't
 * render it) and so is a logo without a reachable API origin (API_PUBLIC_URL).
 */
function emailLogoUrl(): string | null {
  const settings = companySettings();
  const origin = apiPublicOrigin();
  const path = logoApiPath(settings);
  if (!origin || !path || settings.logo?.mimeType === "image/svg+xml") return null;
  return `${origin}/api${path}`;
}

/** Footer address line(s) from Company Settings, escaped. Empty when no address is set. */
function companyAddressHtml(): string {
  const { address } = companySettings();
  const cityLine = [address.city, address.state, address.postalCode].filter(Boolean).join(", ");
  const parts = [address.line1, address.line2, cityLine, address.country].filter(Boolean);
  return parts.map((part) => escapeHtml(part)).join("<br>");
}

/** `headerTitle` must already be safe (static text or escaped). */
function wrapTemplate(headerTitle: string, bodyHtml: string): string {
  const brand = escapeHtml(PRODUCT_NAME);
  const companyRaw = companyName();
  // "LPS – Projects Utility" and "LPS Projects Utility" are the same brand: no "for …" suffix.
  const sameAsBrand = companyRaw.replace(/[^a-z0-9]/gi, "").toLowerCase() === PRODUCT_NAME.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const company = escapeHtml(companyRaw);
  const logoUrl = emailLogoUrl();
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${brand}" height="44" style="display: block; margin: 0 auto 6px; max-height: 44px; max-width: 220px; border: 0;">`
    : `<div style="font-size: 22px; font-weight: 700; color: #111827; letter-spacing: -0.01em;">${brand}</div>`;
  const address = companyAddressHtml();
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${headerTitle}</title></head>
<body style="margin: 0; padding: 28px 16px; background-color: #f3f4f6;">
  <div style="${BASE_STYLE}">
    <div style="${HEADER_STYLE}">
      ${logo}
      <p style="margin: 6px 0 0; color: #6b7280; font-size: 13px;">${headerTitle}</p>
    </div>
    <div style="${BODY_STYLE}">
      ${bodyHtml}
    </div>
    <div style="${FOOTER_STYLE}">
      This is an automated notification from ${brand}${company && !sameAsBrand ? ` for ${company}` : ""}.
      You can turn task, project and time-log emails off in your notification settings.
      ${address ? `<div style="margin-top: 8px;">${company}<br>${address}</div>` : ""}
    </div>
  </div>
</body>
</html>`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// -- Leave templates -------------------------------------------------------

export function leaveApprovedTemplate(params: {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  note?: string;
  /** Name of the admin / department head who decided the request. */
  decidedBy?: string;
}): string {
  const badgeColor = "#10b981";
  const body = `
    <p>Hi <strong>${escapeHtml(params.employeeName)}</strong>,</p>
    <p>Your leave request has been <span style="${BADGE_STYLE} background-color: ${badgeColor}; color: white;">✅ Approved</span></p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">Leave Type</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(capitalize(params.leaveType))}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Duration</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.startDate)} → ${escapeHtml(params.endDate)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Days</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.days)}</td></tr>
      ${params.decidedBy ? `<tr><td style="padding: 8px 0; color: #6b7280;">Approved by</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.decidedBy)}</td></tr>` : ""}
      ${params.note ? `<tr><td style="padding: 8px 0; color: #6b7280;">Note</td><td style="padding: 8px 0;">${escapeMultiline(params.note)}</td></tr>` : ""}
    </table>
    <a href="${appUrl()}/leaves" style="${BUTTON_STYLE}">View Leave Requests</a>
  `;
  return wrapTemplate("Leave Approved", body);
}

export function leaveRejectedTemplate(params: {
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  note?: string;
  /** Name of the admin / department head who decided the request. */
  decidedBy?: string;
}): string {
  const badgeColor = "#ef4444";
  const body = `
    <p>Hi <strong>${escapeHtml(params.employeeName)}</strong>,</p>
    <p>Your leave request has been <span style="${BADGE_STYLE} background-color: ${badgeColor}; color: white;">❌ Rejected</span></p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">Leave Type</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(capitalize(params.leaveType))}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Duration</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.startDate)} → ${escapeHtml(params.endDate)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Days</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.days)}</td></tr>
      ${params.decidedBy ? `<tr><td style="padding: 8px 0; color: #6b7280;">Rejected by</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.decidedBy)}</td></tr>` : ""}
      ${params.note ? `<tr><td style="padding: 8px 0; color: #6b7280;">Reason</td><td style="padding: 8px 0;">${escapeMultiline(params.note)}</td></tr>` : ""}
    </table>
    <a href="${appUrl()}/leaves" style="${BUTTON_STYLE}">View Leave Requests</a>
  `;
  return wrapTemplate("Leave Rejected", body);
}

// -- Feedback template -----------------------------------------------------

export function feedbackRespondedTemplate(params: {
  employeeName: string;
  category: string;
  responseBody: string;
  respondedBy: string;
}): string {
  const body = `
    <p>Hi <strong>${escapeHtml(params.employeeName)}</strong>,</p>
    <p>An admin has responded to your <strong>${escapeHtml(params.category)}</strong> feedback.</p>
    <div style="background-color: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
      <p style="margin: 0 0 8px; color: #6b7280; font-size: 13px;"><strong>${escapeHtml(params.respondedBy)}</strong> responded:</p>
      <p style="margin: 0; color: #374151;">${escapeMultiline(params.responseBody)}</p>
    </div>
    <a href="${appUrl()}/feedback" style="${BUTTON_STYLE}">View Feedback</a>
  `;
  return wrapTemplate("Feedback Response", body);
}

// -- Announcement template -------------------------------------------------

export function announcementCreatedTemplate(params: {
  recipientName: string;
  announcementTitle: string;
  announcementBody: string;
  departmentName: string;
  authorName: string;
}): string {
  const body = `
    <p>Hi <strong>${escapeHtml(params.recipientName)}</strong>,</p>
    <p>A new announcement has been posted in <strong>${escapeHtml(params.departmentName)}</strong>.</p>
    <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; padding: 16px; margin: 16px 0; border-radius: 6px;">
      <h3 style="margin: 0 0 8px; color: #1e40af;">${escapeHtml(params.announcementTitle)}</h3>
      <p style="margin: 0; color: #374151;">${escapeMultiline(params.announcementBody)}</p>
      <p style="margin: 12px 0 0; color: #6b7280; font-size: 13px;">Posted by ${escapeHtml(params.authorName)}</p>
    </div>
    <a href="${appUrl()}/announcements" style="${BUTTON_STYLE}">View Announcements</a>
  `;
  return wrapTemplate("New Announcement", body);
}

// -- Performance Review templates ------------------------------------------

export function reviewAssignedTemplate(params: {
  employeeName: string;
  period: string;
  reviewerName: string;
}): string {
  const badgeColor = "#8b5cf6";
  const body = `
    <p>Hi <strong>${escapeHtml(params.employeeName)}</strong>,</p>
    <p>A performance review has been <span style="${BADGE_STYLE} background-color: ${badgeColor}; color: white;">📋 Assigned</span></p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">Review Period</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.period)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Reviewer</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.reviewerName)}</td></tr>
    </table>
    <p style="color: #6b7280; font-size: 14px;">Your review is being generated by AI. You'll receive another notification when it's ready for your acknowledgment.</p>
    <a href="${appUrl()}/performance-reviews" style="${BUTTON_STYLE}">View Performance Reviews</a>
  `;
  return wrapTemplate("Performance Review Assigned", body);
}

export function reviewReadyTemplate(params: {
  employeeName: string;
  period: string;
  overallScore: number;
  reviewerName: string;
}): string {
  const badgeColor = "#10b981";
  const body = `
    <p>Hi <strong>${escapeHtml(params.employeeName)}</strong>,</p>
    <p>Your performance review is <span style="${BADGE_STYLE} background-color: ${badgeColor}; color: white;">✅ Ready</span></p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">Review Period</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.period)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Reviewer</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.reviewerName)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Overall Score</td><td style="padding: 8px 0; font-weight: 600;">${params.overallScore.toFixed(1)}/5</td></tr>
    </table>
    <p style="color: #6b7280; font-size: 14px;">Please review your performance feedback and acknowledge when you're ready.</p>
    <a href="${appUrl()}/performance-reviews" style="${BUTTON_STYLE}">View & Acknowledge</a>
  `;
  return wrapTemplate("Performance Review Ready", body);
}

// -- Task template ---------------------------------------------------------

const PRIORITY_COLORS: Record<string, string> = {
  low: "#6b7280",
  medium: "#3b82f6",
  high: "#f59e0b",
  urgent: "#ef4444",
};

/**
 * One layout for every task notification: greeting, intro line, a card with the
 * task title / due date / priority, an optional quote (comment, review notes…)
 * and a button that opens the task detail sheet.
 */
export function taskEmailTemplate(params: {
  /** Greeting name (full name preferred). */
  firstName: string;
  /** Header line (static text, escaped anyway). */
  heading: string;
  /** Intro sentence — plain text, escaped. */
  intro: string;
  taskId: string;
  taskTitle: string;
  /** "HRUHSC-21" or "#13655". */
  taskCode?: string | null;
  projectName?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  priority?: string | null;
  status?: string | null;
  /** Optional quoted text (comment body, review notes…) — escaped. */
  quote?: string | null;
  quoteAuthor?: string | null;
  buttonLabel?: string;
}): string {
  const color = PRIORITY_COLORS[params.priority ?? ""] || "#16a34a";
  const link = `${appUrl()}/tasks?task=${encodeURIComponent(params.taskId)}`;
  const row = (label: string, valueHtml: string) =>
    `<tr><td style="padding: 6px 12px 6px 0; color: #6b7280; font-size: 13px; white-space: nowrap; vertical-align: top;">${escapeHtml(label)}</td><td style="padding: 6px 0; font-weight: 600; font-size: 14px; color: #111827;">${valueHtml}</td></tr>`;
  const titleLine = params.taskCode
    ? `${escapeHtml(params.taskTitle)} <span style="color: #6b7280; font-weight: 500;">· ${escapeHtml(params.taskCode)}</span>`
    : escapeHtml(params.taskTitle);
  const body = `
    <h2 style="margin: 0 0 12px; font-size: 22px; color: #111827;">Hello ${escapeHtml(params.firstName)}!</h2>
    <p style="margin: 0 0 16px; color: #374151; font-size: 15px;">${escapeHtml(params.intro)}</p>
    <div style="background-color: #f9fafb; border-left: 4px solid ${color}; padding: 16px 18px; margin: 16px 0; border-radius: 0 8px 8px 0;">
      <h3 style="margin: 0 0 10px; font-size: 17px; color: #111827;">${titleLine}</h3>
      <table style="width: 100%; border-collapse: collapse;">
        ${params.projectName ? row("Project", escapeHtml(params.projectName)) : ""}
        ${row("Start date", params.startDate ? escapeHtml(params.startDate) : "Not set")}
        ${row("Due date", params.dueDate ? escapeHtml(params.dueDate) : "No due date")}
        ${params.status ? row("Status", escapeHtml(params.status)) : ""}
        ${params.priority ? row("Priority", `<span style="${BADGE_STYLE} background-color: ${color}; color: white; font-size: 12px; margin: 0;">${escapeHtml(params.priority.toUpperCase())}</span>`) : ""}
      </table>
      ${
        params.quote
          ? `<div style="margin: 12px 0 0; padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px;">
              ${params.quoteAuthor ? `<p style="margin: 0 0 4px; color: #6b7280; font-size: 13px;"><strong>${escapeHtml(params.quoteAuthor)}</strong> wrote:</p>` : ""}
              <p style="margin: 0; color: #374151; font-size: 14px;">${escapeMultiline(params.quote)}</p>
            </div>`
          : ""
      }
    </div>
    <div style="text-align: center; margin: 24px 0 8px;">
      <a href="${link}" style="${BUTTON_STYLE}">${escapeHtml(params.buttonLabel ?? "View Task")}</a>
    </div>
    <p style="margin: 0; text-align: center; color: #6b7280; font-size: 12px;">Or open this link: <a href="${link}" style="color: #16a34a;">${escapeHtml(link)}</a></p>
  `;
  return wrapTemplate(escapeHtml(params.heading), body);
}

/**
 * Subtask notifications (created / assigned / completed): the subtask card with
 * its parent task, dates, assignee, escaped description and attachment count,
 * plus a button that opens the task sheet with the subtask expanded.
 */
export function subtaskTemplate(params: {
  firstName: string;
  heading: string;
  intro: string;
  taskId: string;
  taskTitle: string;
  taskShortCode?: string | null;
  subtaskId: string;
  subtaskTitle: string;
  startDate?: string | null;
  dueDate?: string | null;
  assigneeName?: string | null;
  description?: string | null;
  attachmentCount: number;
  buttonLabel?: string;
}): string {
  const link = `${appUrl()}/tasks?task=${encodeURIComponent(params.taskId)}&subtask=${encodeURIComponent(params.subtaskId)}`;
  const parent = params.taskShortCode ? `${params.taskShortCode} · ${params.taskTitle}` : params.taskTitle;
  const row = (label: string, value: string) =>
    `<tr><td style="padding: 4px 12px 4px 0; color: #6b7280; font-size: 13px; white-space: nowrap;">${escapeHtml(label)}</td><td style="padding: 4px 0; font-weight: 600; font-size: 13px;">${escapeHtml(value)}</td></tr>`;
  const attachments =
    params.attachmentCount === 0
      ? "None"
      : `${params.attachmentCount} file${params.attachmentCount === 1 ? "" : "s"}`;
  const body = `
    <p>Hi <strong>${escapeHtml(params.firstName)}</strong>,</p>
    <p>${escapeHtml(params.intro)}</p>
    <div style="background-color: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
      <p style="margin: 0 0 4px; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;">Subtask</p>
      <h3 style="margin: 0 0 8px; color: #1f2937;">${escapeHtml(params.subtaskTitle)}</h3>
      <table style="width: 100%; border-collapse: collapse;">
        ${row("Task", parent)}
        ${row("Start date", params.startDate ?? "Not set")}
        ${row("Due date", params.dueDate ?? "No due date")}
        ${row("Assigned to", params.assigneeName ?? "Unassigned")}
        ${row("Attachments", attachments)}
      </table>
      ${
        params.description
          ? `<div style="margin: 12px 0 0; padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px;">
              <p style="margin: 0; color: #374151; font-size: 14px;">${escapeMultiline(params.description)}</p>
            </div>`
          : ""
      }
    </div>
    <a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(params.buttonLabel ?? "View Subtask")}</a>
  `;
  return wrapTemplate(escapeHtml(params.heading), body);
}

// -- Generic notification template (projects, time logs, timesheets) --------

/**
 * One layout for project / time-tracking notifications: greeting, intro, an
 * optional title card with label/value rows, an optional quote (reason, note...)
 * and a button. Every piece of user text is escaped here.
 */
export function genericEmailTemplate(params: {
  firstName: string;
  heading: string;
  intro: string;
  cardTitle?: string | null;
  rows?: Array<[label: string, value: string]>;
  quote?: string | null;
  quoteAuthor?: string | null;
  /** App path, e.g. "/projects/123" (prefixed with APP_URL). */
  path: string;
  buttonLabel?: string;
}): string {
  const rows = (params.rows ?? [])
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 4px 0; color: #6b7280; font-size: 13px;">${escapeHtml(label)}</td><td style="padding: 4px 0; font-weight: 600; font-size: 13px;">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const quote = params.quote
    ? `<div style="margin: 12px 0 0; padding: 12px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px;">
        ${params.quoteAuthor ? `<p style="margin: 0 0 4px; color: #6b7280; font-size: 13px;"><strong>${escapeHtml(params.quoteAuthor)}</strong> wrote:</p>` : ""}
        <p style="margin: 0; color: #374151; font-size: 14px;">${escapeMultiline(params.quote)}</p>
      </div>`
    : "";
  const card =
    params.cardTitle || rows || quote
      ? `<div style="background-color: #f9fafb; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
      ${params.cardTitle ? `<h3 style="margin: 0 0 8px; color: #1f2937;">${escapeHtml(params.cardTitle)}</h3>` : ""}
      ${rows ? `<table style="width: 100%; border-collapse: collapse;">${rows}</table>` : ""}
      ${quote}
    </div>`
      : "";
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const body = `
    <p>Hi <strong>${escapeHtml(params.firstName)}</strong>,</p>
    <p>${escapeHtml(params.intro)}</p>
    ${card}
    <a href="${escapeHtml(appUrl() + path)}" style="${BUTTON_STYLE}">${escapeHtml(params.buttonLabel ?? "Open")}</a>
  `;
  return wrapTemplate(escapeHtml(params.heading), body);
}

/** "in 3 days" / "today" / "expired 2 days ago" (or "was 2 days ago" for non-documents). */
export function relativeDays(inDays: number, pastPrefix = "expired"): string {
  if (inDays === 0) return "today";
  if (inDays > 0) return `in ${inDays} day${inDays === 1 ? "" : "s"}`;
  const ago = -inDays;
  return `${pastPrefix} ${ago} day${ago === 1 ? "" : "s"} ago`;
}

/** Employee document expiring / expired (to the owner and admins). All user text escaped. */
export function documentExpiringTemplate(params: {
  firstName: string;
  documentName: string;
  /** Human label, e.g. "Work permit". */
  documentType: string;
  ownerName: string;
  /** Formatted expiry date, e.g. "Nov 25, 2026". */
  expiryDate: string;
  inDays: number;
  /** True when the recipient owns the document. */
  isOwner: boolean;
}): string {
  const when = relativeDays(params.inDays);
  const expired = params.inDays < 0;
  const whose = params.isOwner ? "Your document" : `${params.ownerName}'s document`;
  return genericEmailTemplate({
    firstName: params.firstName,
    heading: expired ? "Document Expired" : "Document Expiring Soon",
    intro: expired
      ? `${whose} "${params.documentName}" has expired (${when}).`
      : `${whose} "${params.documentName}" expires ${when}.`,
    cardTitle: params.documentName,
    rows: [
      ["Type", params.documentType],
      ["Owner", params.ownerName],
      ["Expiry date", params.expiryDate],
      ["Status", expired ? when : `Expires ${when}`],
    ],
    path: "/documents",
    buttonLabel: "Open Documents",
  });
}

/** Probation / notice period / internship ending (to the employee, their head and admins). */
export function hrDateTemplate(params: {
  firstName: string;
  employeeName: string;
  /** "Probation", "Notice period" or "Internship". */
  label: string;
  /** Formatted end date. */
  date: string;
  inDays: number;
  isSelf: boolean;
}): string {
  const when = params.inDays === 0 ? "today" : `in ${params.inDays} day${params.inDays === 1 ? "" : "s"}`;
  const who = params.isSelf ? "Your" : `${params.employeeName}'s`;
  return genericEmailTemplate({
    firstName: params.firstName,
    heading: `${params.label} Ending ${params.inDays === 0 ? "Today" : "Soon"}`,
    intro: `${who} ${params.label.toLowerCase()} ends ${when} (${params.date}).`,
    cardTitle: params.employeeName,
    rows: [
      ["Date", `${params.label} end`],
      ["Ends on", params.date],
      ["When", when],
    ],
    path: params.isSelf ? "/profile" : "/dashboard",
    buttonLabel: params.isSelf ? "Open Profile" : "Open Dashboard",
  });
}

/** Summary table email (daily time-log report). Every cell is escaped. */
export function tableEmailTemplate(params: {
  firstName: string;
  heading: string;
  intro: string;
  columns: string[];
  rows: string[][];
  path: string;
  buttonLabel?: string;
}): string {
  const head = params.columns
    .map(
      (c) =>
        `<th style="text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; color: #6b7280;">${escapeHtml(c)}</th>`
    )
    .join("");
  const body = params.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td style="padding: 6px 8px; border-bottom: 1px solid #f3f4f6; font-size: 13px;">${escapeHtml(cell)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  const html = `
    <p>Hi <strong>${escapeHtml(params.firstName)}</strong>,</p>
    <p>${escapeHtml(params.intro)}</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <a href="${escapeHtml(appUrl() + params.path)}" style="${BUTTON_STYLE}">${escapeHtml(params.buttonLabel ?? "Open")}</a>
  `;
  return wrapTemplate(escapeHtml(params.heading), html);
}

/** Plain-text test message for the admin "send test email" action. */
export function testEmailTemplate(params: { firstName: string; host: string | null }): string {
  const body = `
    <p>Hi <strong>${escapeHtml(params.firstName)}</strong>,</p>
    <p>This is a test email from ${escapeHtml(companyName())}. If you can read this, SMTP delivery${params.host ? ` via <strong>${escapeHtml(params.host)}</strong>` : ""} is working.</p>
    <p style="color: #6b7280; font-size: 13px;">Sent at ${escapeHtml(new Date().toISOString())}</p>
  `;
  return wrapTemplate("SMTP Test", body);
}

/**
 * Invitation to join the workspace (company name, or "LPS – Projects Utility"). Sent to someone without an account yet, so it is
 * rendered without a first name. `acceptUrl` carries the one-time token.
 */
export function invitationTemplate(params: {
  inviterName: string;
  role: string;
  departmentName: string | null;
  message?: string | null;
  acceptUrl: string;
  expiresAt: Date;
}): string {
  const roleLabel = params.role === "head" ? "Head of Department" : capitalize(params.role);
  const expires = params.expiresAt.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const body = `
    <p>Hi there,</p>
    <p><strong>${escapeHtml(params.inviterName)}</strong> invited you to join ${escapeHtml(companyName())}.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">Role</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(roleLabel)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">Department</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.departmentName ?? "Not assigned yet")}</td></tr>
    </table>
    ${
      params.message
        ? `<div style="background-color: #f9fafb; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
        <p style="margin: 0 0 4px; color: #6b7280; font-size: 13px;"><strong>${escapeHtml(params.inviterName)}</strong> wrote:</p>
        <p style="margin: 0; color: #374151; font-size: 14px;">${escapeMultiline(params.message)}</p>
      </div>`
        : ""
    }
    <a href="${escapeHtml(params.acceptUrl)}" style="${BUTTON_STYLE}">Join ${escapeHtml(companyName())}</a>
    <p style="color: #6b7280; font-size: 13px;">This link expires on <strong>${escapeHtml(expires)}</strong> and can be used once.</p>
    <p style="color: #6b7280; font-size: 13px;">If you weren't expecting this, ignore this email.</p>
  `;
  return wrapTemplate("You're invited", body);
}

/**
 * Set-password link for an existing account without a usable password (e.g.
 * migrated from Worksuite). `setupUrl` carries the one-time token.
 */
/** Forgot password: the 6-digit code in large type (the code is digits only, still escaped). */
export function passwordResetCodeTemplate(params: { firstName: string; code: string }): string {
  const body = `
    <p>Hi ${escapeHtml(params.firstName)},</p>
    <p>Use this code to reset your ${escapeHtml(companyName())} password:</p>
    <p style="margin: 24px 0; text-align: center;">
      <span style="display: inline-block; padding: 12px 20px; font-size: 32px; font-weight: 700; letter-spacing: 8px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; background-color: #f3f4f6; border-radius: 8px; color: #111827;">${escapeHtml(params.code)}</span>
    </p>
    <p style="color: #6b7280; font-size: 13px;">This code expires in <strong>10 minutes</strong> and can be used once.</p>
    <p style="color: #6b7280; font-size: 13px;">If you didn't request this, ignore this email — your password stays the same.</p>
  `;
  return wrapTemplate("Your password reset code", body);
}

/** Confirmation after a password reset, with when and from where. */
export function passwordChangedTemplate(params: { firstName: string; when: string; ip?: string }): string {
  const body = `
    <p>Hi ${escapeHtml(params.firstName)},</p>
    <p>The password for your ${escapeHtml(companyName())} account was just changed, and every other session was signed out.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr><td style="padding: 8px 0; color: #6b7280;">When</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.when)}</td></tr>
      <tr><td style="padding: 8px 0; color: #6b7280;">IP address</td><td style="padding: 8px 0; font-weight: 600;">${escapeHtml(params.ip ?? "Unknown")}</td></tr>
    </table>
    <p style="color: #6b7280; font-size: 13px;">If this wasn't you, reset your password right away from the sign-in page and contact your administrator.</p>
  `;
  return wrapTemplate("Your password was changed", body);
}

export function passwordSetupTemplate(params: { firstName: string; setupUrl: string; expiresAt: Date }): string {
  const expires = params.expiresAt.toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const body = `
    <p>Hi ${escapeHtml(params.firstName)},</p>
    <p>Your ${escapeHtml(companyName())} account is ready. Choose a password to sign in.</p>
    <a href="${escapeHtml(params.setupUrl)}" style="${BUTTON_STYLE}">Set your password</a>
    <p style="color: #6b7280; font-size: 13px;">This link expires on <strong>${escapeHtml(expires)}</strong> and can be used once.</p>
    <p style="color: #6b7280; font-size: 13px;">If you weren't expecting this, ignore this email or contact your administrator.</p>
  `;
  return wrapTemplate("Set your password", body);
}
