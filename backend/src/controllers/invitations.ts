import crypto from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { logActivity } from "../lib/activityLog.js";
import { appUrl, companyName, invitationTemplate, sendEmail } from "../lib/email.js";
import { isDuplicateKeyError } from "../lib/errors.js";
import { notifyUsers } from "../lib/notifications.js";
import { parsePagination, searchRegex } from "../lib/pagination.js";
import { pushProjectUpdate, recordProjectActivity } from "../lib/projectAccess.js";
import { Department } from "../models/Department.js";
import type { IInvitation, InvitationState } from "../models/Invitation.js";
import { INVITATION_LIMITS, Invitation, invitationState } from "../models/Invitation.js";
import { Project } from "../models/Project.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { issueSessionCookie } from "./auth.js";
import { notifyMembersAdded } from "./projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type InviteRole = IInvitation["role"];

const EMAIL_REGEX = /^\S+@\S+\.\S+$/;
const ROLES: readonly InviteRole[] = ["employee", "head", "admin"];
const STATE_FILTERS: readonly InvitationState[] = ["pending", "accepted", "expired", "revoked"];

const INVITE_POPULATE = [
  { path: "invitedBy", select: "name email" },
  { path: "department", select: "name" },
  { path: "projects", select: "name code archivedAt" },
  { path: "acceptedUser", select: "name email" },
];

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** 32 random bytes as base64url, plus the SHA-256 hash that is the only thing stored. */
function newToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function acceptUrlFor(token: string): string {
  return `${appUrl()}/invite/${token}`;
}

function newExpiry(now = new Date()): Date {
  return new Date(now.getTime() + INVITATION_LIMITS.ttlMs);
}

function paramValue(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return typeof value === "string" ? value : undefined;
}

/** Sends the invitation email (fire-and-forget; a failure never fails the request). */
function sendInvitationEmail(
  invitation: Pick<IInvitation, "email" | "role" | "message" | "expiresAt">,
  inviter: Pick<IUser, "name">,
  departmentName: string | null,
  token: string
): void {
  void sendEmail({
    to: invitation.email,
    subject: `${inviter.name} invited you to join ${companyName()}`,
    html: invitationTemplate({
      inviterName: inviter.name,
      role: invitation.role,
      departmentName,
      message: invitation.message ?? null,
      acceptUrl: acceptUrlFor(token),
      expiresAt: invitation.expiresAt,
    }),
  }).catch(() => undefined);
}

async function populated(id: mongoose.Types.ObjectId): Promise<Record<string, unknown> | null> {
  const doc = await Invitation.findById(id).populate(INVITE_POPULATE);
  return doc ? (doc.toJSON() as unknown as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Admin: create / refresh invites
// ---------------------------------------------------------------------------

interface CreateInvitationsBody {
  emails?: unknown;
  role?: unknown;
  department?: unknown;
  projects?: unknown;
  message?: unknown;
}

type ResultStatus = "invited" | "resent" | "already_user" | "invalid";

interface InviteResult {
  email: string;
  status: ResultStatus;
  invitation?: Record<string, unknown> | null;
  acceptUrl?: string;
}

/**
 * Admin: invites up to 50 emails with one role/department/projects/message.
 * Existing users come back as `already_user`; an open invite for the same email
 * is refreshed (`resent`). `acceptUrl` is returned once per send so the admin
 * can share the link manually if email delivery fails.
 */
export async function createInvitations(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const body = (req.body ?? {}) as CreateInvitationsBody;

  if (!Array.isArray(body.emails) || body.emails.length === 0) {
    res.status(400).json({ error: "emails must be a non-empty array" });
    return;
  }
  if (body.emails.length > INVITATION_LIMITS.maxEmails) {
    res.status(400).json({ error: `You can invite at most ${INVITATION_LIMITS.maxEmails} emails at once` });
    return;
  }
  if (!body.emails.every((email) => typeof email === "string")) {
    res.status(400).json({ error: "emails must be strings" });
    return;
  }

  const role: InviteRole = body.role === undefined ? "employee" : (body.role as InviteRole);
  if (!ROLES.includes(role)) {
    res.status(400).json({ error: "role must be employee, head, or admin" });
    return;
  }

  let departmentId: mongoose.Types.ObjectId | null = null;
  let departmentName: string | null = null;
  if (body.department !== undefined && body.department !== null && body.department !== "") {
    if (typeof body.department !== "string" || !mongoose.isValidObjectId(body.department)) {
      res.status(400).json({ error: "department must be a valid id or null" });
      return;
    }
    const department = await Department.findById(body.department).select("name").lean();
    if (!department) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    departmentId = department._id as mongoose.Types.ObjectId;
    departmentName = department.name;
  }
  if (role === "head" && !departmentId) {
    res.status(400).json({ error: "A head of department must be assigned to a department" });
    return;
  }

  let projectIds: mongoose.Types.ObjectId[] = [];
  if (body.projects !== undefined && body.projects !== null) {
    if (!Array.isArray(body.projects) || !body.projects.every((id) => typeof id === "string" && mongoose.isValidObjectId(id))) {
      res.status(400).json({ error: "projects must be an array of project ids" });
      return;
    }
    const unique = [...new Set(body.projects as string[])];
    if (unique.length > INVITATION_LIMITS.maxProjects) {
      res.status(400).json({ error: `You can add at most ${INVITATION_LIMITS.maxProjects} projects` });
      return;
    }
    const found = await Project.find({ _id: { $in: unique }, archivedAt: null }).select("_id").lean();
    if (found.length !== unique.length) {
      res.status(404).json({ error: "One or more projects were not found or are archived" });
      return;
    }
    projectIds = unique.map((id) => new mongoose.Types.ObjectId(id));
  }

  let message: string | undefined;
  if (body.message !== undefined && body.message !== null) {
    if (typeof body.message !== "string") {
      res.status(400).json({ error: "message must be a string" });
      return;
    }
    message = body.message.trim();
    if (message.length > INVITATION_LIMITS.messageMax) {
      res.status(400).json({ error: `message must be at most ${INVITATION_LIMITS.messageMax} characters` });
      return;
    }
    if (!message) message = undefined;
  }

  // Normalise + de-duplicate, keeping the caller's order.
  const emails: string[] = [];
  for (const raw of body.emails as string[]) {
    const email = normalizeEmail(raw);
    if (email && !emails.includes(email)) emails.push(email);
  }
  if (emails.length === 0) {
    res.status(400).json({ error: "emails must contain at least one address" });
    return;
  }

  const validEmails = emails.filter((email) => EMAIL_REGEX.test(email));
  const [existingUsers, openInvites] = await Promise.all([
    User.find({ email: { $in: validEmails } }).select("email").lean(),
    Invitation.find({ email: { $in: validEmails }, status: "pending" }),
  ]);
  const userEmails = new Set(existingUsers.map((user) => user.email));
  const openByEmail = new Map(openInvites.map((invite) => [invite.email, invite]));

  const results: InviteResult[] = [];
  for (const email of emails) {
    if (!EMAIL_REGEX.test(email)) {
      results.push({ email, status: "invalid" });
      continue;
    }
    if (userEmails.has(email)) {
      results.push({ email, status: "already_user" });
      continue;
    }

    const now = new Date();
    const { token, tokenHash } = newToken();
    const existing = openByEmail.get(email);
    let invitation: IInvitation;
    let status: ResultStatus;

    if (existing) {
      existing.tokenHash = tokenHash;
      existing.expiresAt = newExpiry(now);
      existing.role = role;
      existing.department = departmentId;
      existing.projects = projectIds;
      existing.message = message;
      existing.invitedBy = actor._id as mongoose.Types.ObjectId;
      existing.lastSentAt = now;
      existing.sendCount = (existing.sendCount ?? 0) + 1;
      await existing.save();
      invitation = existing;
      status = "resent";
    } else {
      try {
        invitation = await Invitation.create({
          email,
          role,
          department: departmentId,
          projects: projectIds,
          message,
          tokenHash,
          status: "pending",
          expiresAt: newExpiry(now),
          invitedBy: actor._id,
          lastSentAt: now,
          sendCount: 1,
        });
      } catch (error) {
        // Another request opened an invite for this email at the same moment.
        if (isDuplicateKeyError(error)) {
          results.push({ email, status: "invalid" });
          continue;
        }
        throw error;
      }
      status = "invited";
    }

    sendInvitationEmail(invitation, actor, departmentName, token);
    logActivity({
      action: status === "resent" ? "invitation_resent" : "user_invited",
      actor,
      targetType: "invitation",
      targetId: invitation._id as mongoose.Types.ObjectId,
      targetName: email,
      details: { email, role, department: departmentName, projects: projectIds.length },
      ip: req.ip,
    });
    results.push({
      email,
      status,
      invitation: await populated(invitation._id as mongoose.Types.ObjectId),
      acceptUrl: acceptUrlFor(token),
    });
  }

  res.status(201).json({ results });
}

// ---------------------------------------------------------------------------
// Admin: list
// ---------------------------------------------------------------------------

function stateFilter(state: InvitationState, now: Date): Record<string, unknown> {
  switch (state) {
    case "pending":
      return { status: "pending", expiresAt: { $gte: now } };
    case "expired":
      return { status: "pending", expiresAt: { $lt: now } };
    default:
      return { status: state };
  }
}

/** Admin: `{ invitations, total, limit, offset, counts }` with status/search filters. */
export async function listInvitations(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const search = searchRegex(req.query.search);
  const now = new Date();

  const rawStatus = typeof req.query.status === "string" ? req.query.status : "";
  if (rawStatus && rawStatus !== "all" && !STATE_FILTERS.includes(rawStatus as InvitationState)) {
    res.status(400).json({ error: "status must be pending, accepted, expired, revoked, or all" });
    return;
  }

  const base: Record<string, unknown> = search ? { email: search } : {};
  const filter =
    rawStatus && rawStatus !== "all"
      ? { ...base, ...stateFilter(rawStatus as InvitationState, now) }
      : base;

  let query = Invitation.find(filter).sort({ createdAt: -1 }).populate(INVITE_POPULATE);
  if (limit !== null) query = query.skip(offset).limit(limit);

  const [invitations, total, pending, accepted, expired, revoked] = await Promise.all([
    query,
    Invitation.countDocuments(filter),
    ...STATE_FILTERS.map((state) => Invitation.countDocuments({ ...base, ...stateFilter(state, now) })),
  ]);

  res.json({
    invitations: invitations.map((invitation) => invitation.toJSON()),
    total,
    limit,
    offset,
    counts: { pending, accepted, expired, revoked },
  });
}

// ---------------------------------------------------------------------------
// Admin: resend / revoke
// ---------------------------------------------------------------------------

async function getInvitationOr404(req: Request, res: Response): Promise<IInvitation | undefined> {
  const id = paramValue(req, "id");
  if (!id || !mongoose.isValidObjectId(id)) {
    res.status(404).json({ error: "Invitation not found" });
    return undefined;
  }
  const invitation = await Invitation.findById(id);
  if (!invitation) {
    res.status(404).json({ error: "Invitation not found" });
    return undefined;
  }
  return invitation;
}

/** Admin: rotates the token of a pending/expired invite, extends it 7 days and emails it again. */
export async function resendInvitation(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const invitation = await getInvitationOr404(req, res);
  if (!invitation) return;

  if (invitation.status !== "pending") {
    res.status(409).json({ error: `This invitation was ${invitation.status} and can't be resent` });
    return;
  }
  const sinceLast = Date.now() - invitation.lastSentAt.getTime();
  if (sinceLast < INVITATION_LIMITS.resendCooldownMs) {
    const wait = Math.ceil((INVITATION_LIMITS.resendCooldownMs - sinceLast) / 1000);
    res.setHeader("Retry-After", wait);
    res.status(429).json({ error: `This invite was just sent. Try again in ${wait} seconds.` });
    return;
  }
  if (await User.exists({ email: invitation.email })) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const now = new Date();
  const { token, tokenHash } = newToken();
  invitation.tokenHash = tokenHash;
  invitation.expiresAt = newExpiry(now);
  invitation.lastSentAt = now;
  invitation.sendCount = (invitation.sendCount ?? 0) + 1;
  await invitation.save();

  const department = invitation.department
    ? await Department.findById(invitation.department).select("name").lean()
    : null;
  sendInvitationEmail(invitation, actor, department?.name ?? null, token);
  logActivity({
    action: "invitation_resent",
    actor,
    targetType: "invitation",
    targetId: invitation._id as mongoose.Types.ObjectId,
    targetName: invitation.email,
    details: { email: invitation.email, sendCount: invitation.sendCount },
    ip: req.ip,
  });

  res.json({
    invitation: await populated(invitation._id as mongoose.Types.ObjectId),
    acceptUrl: acceptUrlFor(token),
  });
}

/** Admin: revokes a pending (or expired) invite; accepted invites can't be revoked. */
export async function revokeInvitation(req: Request, res: Response): Promise<void> {
  const actor = req.user!;
  const invitation = await getInvitationOr404(req, res);
  if (!invitation) return;

  if (invitation.status === "accepted") {
    res.status(409).json({ error: "This invitation was already accepted and can't be revoked" });
    return;
  }
  if (invitation.status === "revoked") {
    res.status(409).json({ error: "This invitation is already revoked" });
    return;
  }

  invitation.status = "revoked";
  invitation.revokedAt = new Date();
  invitation.revokedBy = actor._id as mongoose.Types.ObjectId;
  await invitation.save();

  logActivity({
    action: "invitation_revoked",
    actor,
    targetType: "invitation",
    targetId: invitation._id as mongoose.Types.ObjectId,
    targetName: invitation.email,
    details: { email: invitation.email },
    ip: req.ip,
  });

  res.json({ invitation: await populated(invitation._id as mongoose.Types.ObjectId) });
}

// ---------------------------------------------------------------------------
// Public: preview + accept
// ---------------------------------------------------------------------------

const GONE_MESSAGES: Record<"expired" | "revoked" | "accepted", string> = {
  expired: "This invitation has expired",
  revoked: "This invitation was revoked",
  accepted: "This invitation was already used",
};

/** Looks the token up by hash; responds 404 (unknown) or 410 (expired/revoked/accepted). */
async function findUsableInvitation(req: Request, res: Response): Promise<IInvitation | undefined> {
  const token = paramValue(req, "token");
  // base64url of 32 bytes is 43 chars; reject obvious junk without a DB hit.
  if (!token || token.length < 20 || token.length > 128) {
    res.status(404).json({ error: "This invite link isn't valid" });
    return undefined;
  }
  const invitation = await Invitation.findOne({ tokenHash: hashToken(token) });
  if (!invitation) {
    res.status(404).json({ error: "This invite link isn't valid" });
    return undefined;
  }
  const state = invitationState(invitation);
  if (state !== "pending") {
    res.status(410).json({ error: GONE_MESSAGES[state], reason: state });
    return undefined;
  }
  return invitation;
}

/** Public: invite preview for the /invite/:token page. */
export async function previewInvitation(req: Request, res: Response): Promise<void> {
  const invitation = await findUsableInvitation(req, res);
  if (!invitation) return;

  const [department, inviter] = await Promise.all([
    invitation.department ? Department.findById(invitation.department).select("name").lean() : null,
    User.findById(invitation.invitedBy).select("name").lean(),
  ]);

  res.json({
    email: invitation.email,
    role: invitation.role,
    department: department ? { name: department.name } : null,
    invitedBy: { name: inviter?.name ?? "An admin" },
    expiresAt: invitation.expiresAt,
  });
}

/**
 * Public: creates the account from the invite, joins the invited projects,
 * marks the invite accepted and signs the new user in.
 *
 * Runs in careful order instead of a transaction (local MongoDB is usually a
 * standalone server): the invite is claimed atomically first, so two parallel
 * accepts can't both create users, and released again if user creation fails.
 */
export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  const { name, password } = (req.body ?? {}) as { name?: unknown; password?: unknown };
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (name.trim().length > 100) {
    res.status(400).json({ error: "name must be at most 100 characters" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }

  const invitation = await findUsableInvitation(req, res);
  if (!invitation) return;

  if (await User.exists({ email: invitation.email })) {
    res.status(409).json({ error: "An account with this email already exists — sign in instead" });
    return;
  }

  // Resolve the department now: a deleted department means joining without one,
  // and a head without a department joins as an employee.
  const department = invitation.department
    ? await Department.findById(invitation.department).select("name").lean()
    : null;
  let role: InviteRole = invitation.role;
  const notices: string[] = [];
  if (invitation.department && !department) {
    notices.push("The department you were invited to no longer exists, so you joined without one.");
  }
  if (role === "head" && !department) {
    role = "employee";
    notices.push("You joined as an employee because the department you would head no longer exists.");
  }

  // Claim the invite atomically (pending + same token + not expired).
  const now = new Date();
  const claimed = await Invitation.findOneAndUpdate(
    { _id: invitation._id, status: "pending", tokenHash: invitation.tokenHash, expiresAt: { $gte: now } },
    { $set: { status: "accepted", acceptedAt: now } },
    { new: true }
  );
  if (!claimed) {
    res.status(410).json({ error: GONE_MESSAGES.accepted, reason: "accepted" });
    return;
  }
  const release = () =>
    Invitation.updateOne(
      { _id: claimed._id, status: "accepted", acceptedUser: null },
      { $set: { status: "pending", acceptedAt: null } }
    ).catch(() => undefined);

  let user: mongoose.HydratedDocument<IUser>;
  try {
    user = await User.create({
      name: name.trim(),
      email: invitation.email,
      password,
      role,
      department: department ? department._id : null,
      hourlyRate: 0,
    });
  } catch (error) {
    await release();
    if (isDuplicateKeyError(error)) {
      res.status(409).json({ error: "An account with this email already exists — sign in instead" });
      return;
    }
    throw error;
  }

  claimed.acceptedUser = user._id as mongoose.Types.ObjectId;
  await claimed.save();

  // Join every invited project that still exists and isn't archived.
  const inviter = await User.findById(invitation.invitedBy);
  const projects = invitation.projects.length
    ? await Project.find({ _id: { $in: invitation.projects }, archivedAt: null })
    : [];
  const joined: string[] = [];
  for (const project of projects) {
    const result = await Project.updateOne(
      { _id: project._id, archivedAt: null, "members.user": { $ne: user._id } },
      { $push: { members: { user: user._id, hourlyRate: user.hourlyRate ?? 0, addedAt: new Date() } } }
    );
    if (result.modifiedCount === 0) continue;
    const projectId = project._id as mongoose.Types.ObjectId;
    joined.push(projectId.toString());
    recordProjectActivity(projectId, inviter, "member_added", { users: [user._id.toString()], via: "invitation" });
    notifyMembersAdded(project, [user._id as mongoose.Types.ObjectId], inviter);
    pushProjectUpdate(project, "members-changed", { added: [user._id.toString()] });
  }

  issueSessionCookie(res, user);

  if (inviter) {
    notifyUsers({
      recipients: [inviter._id as mongoose.Types.ObjectId],
      actor: user,
      type: "user_joined",
      title: "Invitation accepted",
      message: `${user.name} (${user.email}) accepted your invitation and joined ${companyName()}.`,
      link: "/admin/users?tab=invitations",
      email: {
        subject: `👋 ${user.name} joined ${companyName()}`,
        heading: "Invitation Accepted",
        intro: `${user.name} accepted your invitation and now has an account.`,
        cardTitle: user.name,
        rows: [
          ["Email", user.email],
          ["Role", role === "head" ? "Head of Department" : role],
          ["Department", department?.name ?? "Not assigned"],
          ["Projects joined", String(joined.length)],
        ],
        buttonLabel: "View invitations",
      },
    });
  }

  logActivity({
    action: "invitation_accepted",
    actor: user,
    targetType: "invitation",
    targetId: claimed._id as mongoose.Types.ObjectId,
    targetName: user.email,
    details: {
      email: user.email,
      role,
      invitedRole: invitation.role,
      department: department?.name ?? null,
      projects: joined.length,
    },
    ip: req.ip,
  });

  res.status(201).json({ user: user.toJSON(), notices });
}
