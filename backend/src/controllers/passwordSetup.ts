import crypto from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { appUrl, emailConfigured, passwordSetupTemplate, sendEmail } from "../lib/email.js";
import type { IPasswordSetupToken } from "../models/PasswordSetupToken.js";
import { PASSWORD_SETUP_LIMITS, PasswordSetupToken } from "../models/PasswordSetupToken.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { issueSessionCookie } from "./auth.js";

// ---------------------------------------------------------------------------
// Set-password links (same token design as invitations): 32 random bytes as
// base64url in the link, only the SHA-256 stored, 7 days, single use. Issuing
// a new link revokes the user's older unused links.
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setupUrlFor(token: string): string {
  return `${appUrl()}/set-password/${token}`;
}

function paramValue(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

interface IssuedLink {
  setupUrl: string;
  expiresAt: Date;
  emailed: boolean;
}

/** Creates a fresh link for `user` (revoking older unused ones) and emails it when SMTP is configured. */
async function issueLink(user: IUser, actor: IUser, sendMail: boolean): Promise<IssuedLink> {
  const now = new Date();
  await PasswordSetupToken.updateMany(
    { user: user._id, usedAt: null, revokedAt: null },
    { $set: { revokedAt: now } }
  );
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_LIMITS.ttlMs);
  await PasswordSetupToken.create({
    user: user._id,
    tokenHash: hashToken(token),
    expiresAt,
    createdBy: actor._id,
  });
  const setupUrl = setupUrlFor(token);
  const emailed = sendMail && emailConfigured();
  if (emailed) {
    // Fire-and-forget: a mail failure never fails the request (the admin still gets the link).
    void sendEmail({
      to: user.email,
      subject: "Set your password",
      html: passwordSetupTemplate({ firstName: user.name.split(" ")[0] || user.name, setupUrl, expiresAt }),
    }).catch(() => undefined);
  }
  return { setupUrl, expiresAt, emailed };
}

function wantsEmail(body: unknown): boolean {
  const value = (body as { sendEmail?: unknown } | undefined)?.sendEmail;
  return value === undefined ? true : value === true;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Admin: POST /api/users/:id/password-link → `{ setupUrl, expiresAt, emailed }`. */
export async function createPasswordLink(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const id = paramValue(req, "id");
  if (!id || !mongoose.isValidObjectId(id)) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const user = await User.findById(id);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const link = await issueLink(user, actor, wantsEmail(req.body));
  logActivity({
    action: "user_updated",
    actor,
    targetType: "user",
    targetId: user._id as mongoose.Types.ObjectId,
    targetName: user.name,
    details: { passwordLink: "created", emailed: link.emailed },
    ip: req.ip,
  });
  res.status(201).json({ ...link, passwordSetupRequired: user.passwordSetupRequired });
}

type BulkStatus = "created" | "not_found" | "invalid";

/**
 * Admin: POST /api/users/password-links `{ userIds: string[] }` or
 * `{ allPending: true }` (every user with `passwordSetupRequired`).
 * Returns `{ results: [{ userId, status, setupUrl?, expiresAt?, emailed? }], emailConfigured }`.
 */
export async function createPasswordLinks(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as { userIds?: unknown; allPending?: unknown };
  let ids: string[];
  if (body.allPending === true) {
    const pending = await User.find({ passwordSetupRequired: true }).select("_id").limit(PASSWORD_SETUP_LIMITS.maxBulk).lean();
    ids = pending.map((u) => String(u._id));
  } else {
    if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
      res.status(400).json({ error: "userIds must be a non-empty array (or pass allPending: true)" });
      return;
    }
    if (body.userIds.length > PASSWORD_SETUP_LIMITS.maxBulk) {
      res.status(400).json({ error: `At most ${PASSWORD_SETUP_LIMITS.maxBulk} users per request` });
      return;
    }
    ids = [...new Set(body.userIds.map((v) => String(v)))];
  }

  const valid = ids.filter((id) => mongoose.isValidObjectId(id));
  const users = await User.find({ _id: { $in: valid } });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const sendMail = wantsEmail(body);

  const results: Array<{ userId: string; status: BulkStatus; setupUrl?: string; expiresAt?: Date; emailed?: boolean }> = [];
  for (const id of ids) {
    if (!mongoose.isValidObjectId(id)) {
      results.push({ userId: id, status: "invalid" });
      continue;
    }
    const user = byId.get(id);
    if (!user) {
      results.push({ userId: id, status: "not_found" });
      continue;
    }
    const link = await issueLink(user, actor, sendMail);
    results.push({ userId: id, status: "created", ...link });
  }
  const created = results.filter((r) => r.status === "created").length;
  if (created > 0) {
    logActivity({
      action: "user_updated",
      actor,
      targetType: "user",
      targetName: `${created} users`,
      details: { passwordLink: "bulk_created", count: created },
      ip: req.ip,
    });
  }
  res.status(201).json({ results, emailConfigured: emailConfigured() });
}

/**
 * Admin: POST /api/users/default-password
 * `{ password, scope: "pending" | "all" | "selected", userIds?, requireChange?: boolean }`
 * Gives every targeted employee the same password so they can sign in now.
 * "pending" = accounts that still have no usable password (imported); "all" =
 * everyone except the acting admin. With `requireChange` (default true) the
 * app asks each person for a new password at their next sign-in. Other active
 * sessions of the targeted users are signed out (tokenVersion bump).
 */
export async function setDefaultPassword(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as { password?: unknown; scope?: unknown; userIds?: unknown; requireChange?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 128) {
    res.status(400).json({ error: "password must be 8–128 characters" });
    return;
  }
  const scope = body.scope === "all" ? "all" : body.scope === "pending" ? "pending" : body.scope === "selected" ? "selected" : null;
  if (!scope) {
    res.status(400).json({ error: 'scope must be "pending", "all" or "selected"' });
    return;
  }
  const requireChange = body.requireChange !== false;

  let filter: Record<string, unknown>;
  if (scope === "selected") {
    const ids = Array.isArray(body.userIds) ? [...new Set(body.userIds.map((v) => String(v)))] : [];
    if (ids.length === 0 || ids.length > PASSWORD_SETUP_LIMITS.maxBulk || !ids.every((id) => mongoose.isValidObjectId(id))) {
      res.status(400).json({ error: `userIds must be 1–${PASSWORD_SETUP_LIMITS.maxBulk} valid ids` });
      return;
    }
    // Never the acting admin: that would silently replace their own password.
    filter = { _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)), $ne: actor._id } };
  } else {
    filter = scope === "pending" ? { passwordSetupRequired: true } : { _id: { $ne: actor._id } };
  }
  const users = await User.find(filter).select("_id");
  let updated = 0;
  for (const user of users) {
    // save() runs the hashing hook; bumping tokenVersion signs out other sessions.
    user.password = password;
    user.passwordSetupRequired = false;
    user.mustChangePassword = requireChange;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    updated++;
  }
  if (updated > 0) {
    await PasswordSetupToken.updateMany(
      { user: { $in: users.map((u) => u._id) }, usedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    ).catch(() => undefined);
  }
  logActivity({
    action: "user_updated",
    actor,
    targetType: "user",
    targetName: `${updated} users`,
    details: { defaultPassword: scope, requireChange, count: updated },
    ip: req.ip,
  });
  res.json({ updated, scope, requireChange });
}

// ---------------------------------------------------------------------------
// Public (the link is the credential; rate-limited in server.ts)
// ---------------------------------------------------------------------------

const GONE: Record<"used" | "expired" | "revoked", string> = {
  used: "This link was already used — sign in with your password",
  expired: "This link has expired — ask your administrator for a new one",
  revoked: "This link was replaced by a newer one — use the latest link you received",
};

async function findUsableToken(
  req: Request,
  res: Response
): Promise<{ token: IPasswordSetupToken; user: IUser } | undefined> {
  const raw = paramValue(req, "token");
  if (!raw || raw.length < 20 || raw.length > 128) {
    res.status(404).json({ error: "This link isn't valid" });
    return undefined;
  }
  const token = await PasswordSetupToken.findOne({ tokenHash: hashToken(raw) });
  const user = token ? await User.findById(token.user) : null;
  if (!token || !user) {
    res.status(404).json({ error: "This link isn't valid" });
    return undefined;
  }
  const reason = token.usedAt ? "used" : token.revokedAt ? "revoked" : token.expiresAt.getTime() < Date.now() ? "expired" : null;
  if (reason) {
    res.status(410).json({ error: GONE[reason], reason });
    return undefined;
  }
  return { token, user };
}

/** Public: GET /api/password-setup/:token → `{ name, email, expiresAt }`. */
export async function previewPasswordSetup(req: Request, res: Response): Promise<void> {
  const found = await findUsableToken(req, res);
  if (!found) return;
  res.json({ name: found.user.name, email: found.user.email, expiresAt: found.token.expiresAt });
}

/** Public: POST /api/password-setup/:token `{ password }` → sets the password and signs the user in. */
export async function completePasswordSetup(req: Request, res: Response): Promise<void> {
  const { password } = (req.body ?? {}) as { password?: unknown };
  if (typeof password !== "string" || password.length < PASSWORD_SETUP_LIMITS.passwordMin) {
    res.status(400).json({ error: `password must be at least ${PASSWORD_SETUP_LIMITS.passwordMin} characters` });
    return;
  }
  if (password.length > PASSWORD_SETUP_LIMITS.passwordMax) {
    res.status(400).json({ error: `password must be at most ${PASSWORD_SETUP_LIMITS.passwordMax} characters` });
    return;
  }

  const found = await findUsableToken(req, res);
  if (!found) return;

  // Claim atomically so a link can't be used twice in parallel.
  const now = new Date();
  const claimed = await PasswordSetupToken.findOneAndUpdate(
    { _id: found.token._id, usedAt: null, revokedAt: null, expiresAt: { $gte: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );
  if (!claimed) {
    res.status(410).json({ error: GONE.used, reason: "used" });
    return;
  }

  const user = await User.findById(found.user._id).select("+password");
  if (!user) {
    res.status(404).json({ error: "This link isn't valid" });
    return;
  }
  user.password = password; // hashed by the model's pre-save hook
  user.passwordSetupRequired = false;
  await user.save();
  await PasswordSetupToken.updateMany(
    { user: user._id, usedAt: null, revokedAt: null },
    { $set: { revokedAt: now } }
  );

  logActivity({
    action: "user_updated",
    actor: user,
    targetType: "user",
    targetId: user._id as mongoose.Types.ObjectId,
    targetName: user.name,
    details: { changed: ["password"], via: "password_link" },
    ip: req.ip,
  });

  issueSessionCookie(res, user);
  res.json({ user: user.toJSON() });
}
