import mongoose from "mongoose";
import { Notification } from "../models/Notification.js";
import { ChangeRequest, type ChangeKind, type IChangeLine, type IChangeRequest } from "../models/ChangeRequest.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { isLeadershipUser } from "./leadership.js";
import { notifyUsers, notifyUsersAsync } from "./notifications.js";
import { departmentHeads } from "./projectAccess.js";
import { isProjectApprover, projectApproverIds } from "./projectApproval.js";

// ---------------------------------------------------------------------------
// Changes that need leadership approval (models/ChangeRequest.ts). Each request
// emails leadership when it is made: project and brand changes one per
// project / brand. Manpower plan saves are kept as a draft request (no email)
// until someone sends them (sendForApproval): one consolidated list then.
// ---------------------------------------------------------------------------

/** Leadership changes apply directly (marked by requireAuth, or an approver). */
export async function isLeadershipActor(user: IUser): Promise<boolean> {
  return isLeadershipUser(user) || (await isProjectApprover(user._id as mongoose.Types.ObjectId));
}

/**
 * Who decides a change besides leadership: project scope / team and brand changes go to the
 * requester's department approvers (Settings → Departments). Empty (other kinds, no approver,
 * or the requester is the approver) = leadership.
 */
export async function changeApproversFor(kind: ChangeKind, requester: IUser): Promise<mongoose.Types.ObjectId[]> {
  if (kind !== "project_change" && kind !== "brand_edit") return [];
  return (await departmentHeads(requester.department ?? null)).filter((id) => !id.equals(requester._id as mongoose.Types.ObjectId));
}

/** Leadership, or one of the request's department approvers. */
export async function canDecideChange(user: IUser, request: Pick<IChangeRequest, "approvers">): Promise<boolean> {
  const id = String(user._id);
  if ((request.approvers ?? []).some((a) => String((a as { _id?: unknown })._id ?? a) === id)) return true;
  return isProjectApprover(user._id as mongoose.Types.ObjectId);
}

const KIND_LABEL: Record<ChangeKind, string> = {
  project_change: "Project scope / team change",
  brand_edit: "Brand change",
  manpower_plan: "Manpower plan change",
  project_move: "Projects moving to another brand",
};

/** Short text for list / email cells. */
export function clip(text: string | null | undefined, max = 400): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Records a change for approval and emails leadership. A pending request for
 * the same target is replaced (its payload merged under the new one).
 * `send: false` (manpower plan saves): recorded without telling anyone — a new
 * request is a draft until sendForApproval; one replacing a sent request stays
 * sent (in the queue) and its new lines show as "not sent yet".
 */
export async function requestChange(params: {
  kind: ChangeKind;
  actor: IUser;
  title: string;
  changes: IChangeLine[];
  payload: Record<string, unknown>;
  brand?: mongoose.Types.ObjectId | null;
  project?: mongoose.Types.ObjectId | null;
  month?: string | null;
  version?: number | null;
  ip?: string;
  /** Also notify the actor when they are an approver (system jobs acting as leadership). */
  notifyActor?: boolean;
  /**
   * Payload keys (and their change lines) the new request puts back to the current value: dropped
   * from the pending request it replaces (a resent scope whose "Other scope" is unchanged again).
   */
  dropKeys?: Array<{ key: string; label: string }>;
  /** false: save quietly (no in-app notification / email) — see above. Default true. */
  send?: boolean;
}): Promise<IChangeRequest> {
  const send = params.send !== false;
  const target: Record<string, unknown> =
    params.kind === "project_change"
      ? { project: params.project }
      : params.kind === "brand_edit"
        ? { brand: params.brand }
        : { month: params.month };
  // Moves are separate requests (each its own projects); the others replace the pending one.
  const previous = params.kind === "project_move" ? null : await ChangeRequest.findOne({ kind: params.kind, status: "pending", ...target });
  let payload = params.payload;
  let changes = params.changes;
  if (previous && params.kind !== "manpower_plan") {
    payload = { ...(previous.payload ?? {}), ...params.payload };
    // Member adds / removals add up across requests (a later add cancels an earlier removal and back).
    const prev = (previous.payload ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    if (prev.addMembers || prev.removeMembers || params.payload.addMembers || params.payload.removeMembers) {
      const addNow = list(params.payload.addMembers);
      const removeNow = list(params.payload.removeMembers);
      const add = [...new Set([...list(prev.addMembers).filter((id) => !removeNow.includes(id)), ...addNow])];
      const remove = [...new Set([...list(prev.removeMembers).filter((id) => !addNow.includes(id)), ...removeNow])];
      payload.addMembers = add;
      payload.removeMembers = remove;
    }
    const labels = new Set(params.changes.map((c) => c.label));
    for (const d of params.dropKeys ?? []) {
      delete payload[d.key];
      labels.add(d.label);
    }
    changes = [...previous.changes.filter((c) => !labels.has(c.label)), ...params.changes];
  }
  if (previous) {
    previous.status = "superseded";
    previous.decidedAt = new Date();
    await previous.save();
  }
  const request = await ChangeRequest.create({
    kind: params.kind,
    title: params.title,
    brand: params.brand ?? null,
    project: params.project ?? null,
    month: params.month ?? null,
    version: params.version ?? null,
    changes: changes.slice(0, 300),
    payload,
    requestedBy: params.actor._id,
    approvers: await changeApproversFor(params.kind, params.actor),
    // Sent now, or (a quiet save) as sent as the request it replaces.
    draft: send ? false : previous ? previous.draft : true,
    ...(send ? { sentAt: new Date(), sentBy: params.actor._id, sentChanges: changes.slice(0, 300) } : sentState(previous)),
  });
  logActivity({
    action: "settings_updated",
    actor: params.actor,
    targetType: "change_request",
    targetId: request._id as mongoose.Types.ObjectId,
    targetName: params.title,
    details: {
      change: send ? (previous ? "resent" : "requested") : "saved_not_sent",
      kind: params.kind,
      lines: changes.length,
      ...(previous ? { replaces: String(previous._id) } : {}),
    },
    ip: params.ip,
  });
  if (send) await notifyApprovalRequested(request, params.actor, { updated: Boolean(previous), notifyActor: params.notifyActor });
  return request;
}

/** What a quiet save carries over from the request it replaces (one sent before drafts existed: as sent when made). */
function sentState(previous: IChangeRequest | null): Pick<IChangeRequest, "sentAt" | "sentBy" | "sentChanges"> {
  if (!previous || previous.draft) return { sentAt: null, sentBy: null, sentChanges: [] };
  if (previous.sentAt) return { sentAt: previous.sentAt, sentBy: previous.sentBy, sentChanges: previous.sentChanges };
  return { sentAt: previous.createdAt, sentBy: previous.requestedBy, sentChanges: previous.changes };
}

/** Lines of a sent request changed since it was last sent (new / different ones, and sent ones now gone). */
export function changesSinceSent(request: Pick<IChangeRequest, "changes" | "sentChanges" | "sentAt" | "draft">): number {
  if (request.draft) return request.changes.length;
  // Sent before drafts existed (no record of when): nothing new.
  if (!request.sentAt) return 0;
  const key = (c: IChangeLine) => `${c.label}\u0000${c.after}`;
  const sent = new Set((request.sentChanges ?? []).map(key));
  const labels = new Set(request.changes.map((c) => c.label));
  return request.changes.filter((c) => !sent.has(key(c))).length + (request.sentChanges ?? []).filter((c) => !labels.has(c.label)).length;
}

/**
 * Sends a (draft or since-updated) request to leadership: one in-app notification
 * and email with every change line. It then shows in the approvals queue.
 */
export async function sendForApproval(request: IChangeRequest, actor: IUser, note: string, ip?: string): Promise<IChangeRequest> {
  const updated = Boolean(request.sentAt);
  const fresh = changesSinceSent(request);
  request.draft = false;
  request.sentAt = new Date();
  request.sentBy = actor._id as mongoose.Types.ObjectId;
  request.sentChanges = request.changes.slice(0, 300);
  await request.save();
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "change_request",
    targetId: request._id as mongoose.Types.ObjectId,
    targetName: request.title,
    details: { change: updated ? "sent_update" : "sent", kind: request.kind, lines: request.changes.length, newLines: fresh, note: note || undefined },
    ip,
  });
  await notifyApprovalRequested(request, actor, { updated, note, newLines: updated ? fresh : undefined });
  return request;
}

/** "Approval needed" to the approvers (in-app + email), listing the request's change lines. */
async function notifyApprovalRequested(
  request: IChangeRequest,
  actor: IUser,
  opts: { updated: boolean; notifyActor?: boolean; note?: string; newLines?: number }
): Promise<void> {
  const { changes, title, kind } = request;
  const shown = changes.slice(0, 40);
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  notifyUsers({
    // The department approvers when set, else leadership.
    recipients: request.approvers?.length ? request.approvers : await projectApproverIds(),
    actor,
    includeActor: Boolean(opts.notifyActor),
    type: "change_approval_requested",
    title: `${KIND_LABEL[kind]} to approve${opts.updated ? " (updated)" : ""}`,
    message: `${actor.name}: ${title} (${n(changes.length, "change")}${opts.newLines ? `, ${opts.newLines} new` : ""}).`,
    link: `/approvals/${String(request._id)}`,
    email: {
      subject: `Approval needed: ${title}${opts.updated ? " (updated)" : ""}`,
      heading: `${KIND_LABEL[kind]} Awaiting Approval`,
      intro: opts.updated
        ? `${actor.name} updated a change waiting for your approval${opts.newLines ? ` (${n(opts.newLines, "new change")} since it was sent)` : " (it replaces the earlier request)"}. Nothing changes until it's approved.`
        : `${actor.name} made ${changes.length === 1 ? "a change" : `${changes.length} changes`} that need your approval. Nothing changes until it's approved.`,
      cardTitle: title,
      rows: [
        ...(opts.note ? [["Note", clip(opts.note, 500)] as [string, string]] : []),
        ...shown.map((c): [string, string] => [c.label, c.before === "—" && c.after ? c.after : `${c.before} → ${c.after}`]),
        ...(changes.length > shown.length ? [["…", `${changes.length - shown.length} more in the app`] as [string, string]] : []),
      ],
      buttonLabel: "Review in Approvals",
    },
  });
}

/** A brand_edit request that changes the brand scope (rows, "Other scope" or the agreement total). */
export function isScopeChange(request: Pick<IChangeRequest, "payload">): boolean {
  const p = (request.payload ?? {}) as Record<string, unknown>;
  return Array.isArray(p.scopeItems) || typeof p.scopeText === "string" || "scopeTotal" in p;
}

/** Tells the requester the outcome. */
export function notifyDecision(request: IChangeRequest, decider: IUser, approved: boolean): void {
  const reason = request.reason;
  notifyUsers({
    recipients: [request.requestedBy],
    actor: decider,
    type: "change_decided",
    title: approved ? "Change approved" : "Change not approved",
    message: approved
      ? `${decider.name} approved: ${request.title}.`
      : `${decider.name} didn't approve: ${request.title}${reason ? ` — ${reason}` : "."}`,
    // A rejected brand scope change: the brand page opens its scope editor with the proposal, to fix and resend.
    link: request.project
      ? `/projects/${request.project.toString()}`
      : request.kind === "manpower_plan"
        ? "/manpower"
        : request.kind === "brand_edit" && request.brand && !approved && isScopeChange(request)
          ? `/brands/${request.brand.toString()}?editScope=1#scope`
          : request.kind === "brand_edit" && request.brand
            ? `/brands/${request.brand.toString()}#scope`
            : "/approvals",
    email: {
      subject: approved ? `Approved: ${request.title}` : `Not approved: ${request.title}`,
      heading: approved ? "Change Approved" : "Change Not Approved",
      intro: approved ? `${decider.name} approved your change. It's live now.` : `${decider.name} didn't approve your change.`,
      cardTitle: request.title,
      rows: reason ? [["Reason", reason]] : [],
      buttonLabel: "Open",
    },
  });
}

// ---------------------------------------------------------------------------
// Exceptions: scope / team / summary changes that skipped approval (leadership
// editing directly, imports, plan → project sync) and tasks outside the rules
// (over scope, on a project without scope). The approvers (Aasim) are told —
// in-app and by email — never the person who made the change.
// ---------------------------------------------------------------------------

export type ExceptionKind = "direct_edit" | "import_update" | "plan_sync" | "over_scope_task" | "no_scope_task" | "brand_change";

const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  direct_edit: "Changed without approval",
  import_update: "Changed by an Excel import",
  plan_sync: "Changed from the manpower plan",
  over_scope_task: "Task over the approved scope",
  no_scope_task: "Task on a project without scope",
  brand_change: "Moved to another brand without approval",
};

export interface ExceptionProject {
  _id: unknown;
  name: string;
  code?: string;
}

/** One project's exception lines (label → text). */
export interface ExceptionEntry {
  project: ExceptionProject;
  details: Array<[string, string]>;
}

/**
 * Tells the projects approvers about changes made outside the approval flow:
 * one in-app notification + email (all entries listed). The actor is never told.
 */
export async function notifyException(kind: ExceptionKind, actor: IUser | null, entries: ExceptionEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const recipients = await projectApproverIds();
    if (recipients.length === 0) return;
    const by = actor?.name ?? "The system";
    const one = entries.length === 1 ? entries[0]! : null;
    const title = one ? `${EXCEPTION_LABEL[kind]}: ${one.project.name}` : `${EXCEPTION_LABEL[kind]}: ${entries.length} projects`;
    const rows: Array<[string, string]> = [];
    for (const e of entries.slice(0, 30)) {
      if (!one) rows.push(["Project", e.project.code ? `${e.project.code} · ${e.project.name}` : e.project.name]);
      for (const [label, text] of e.details.slice(0, 12)) rows.push([label, clip(text, 300)]);
    }
    if (entries.length > 30) rows.push(["…", `${entries.length - 30} more projects`]);
    await notifyUsersAsync({
      recipients,
      actor,
      type: "change_exception",
      title,
      message: `${by}: ${one ? one.details.map(([l, t]) => `${l}: ${clip(t, 80)}`).join("; ") : `${entries.length} projects changed`}.`,
      link: one ? `/projects/${String(one.project._id)}` : "/approvals",
      project: one ? (one.project._id as mongoose.Types.ObjectId) : null,
      email: {
        subject: `For your information: ${title}`,
        heading: EXCEPTION_LABEL[kind],
        intro: `${by} made ${entries.length === 1 ? "a change" : "changes"} outside the approval flow. Nothing to approve — this is so you know.`,
        cardTitle: one ? one.project.name : `${entries.length} projects`,
        rows,
        buttonLabel: "Open",
      },
    });
  } catch (err) {
    console.error("[exceptions] notify failed", kind, err);
  }
}

/** Collects exceptions of one run (an import, a plan sync) and sends them as one message. */
export class ExceptionBatch {
  private entries: ExceptionEntry[] = [];
  constructor(
    readonly kind: ExceptionKind,
    readonly actor: IUser | null
  ) {}
  add(project: ExceptionProject, details: Array<[string, string]>): void {
    if (details.length) this.entries.push({ project, details });
  }
  get size(): number {
    return this.entries.length;
  }
  async flush(): Promise<void> {
    const entries = this.entries;
    this.entries = [];
    await notifyException(this.kind, this.actor, entries);
  }
}

/** A task added to an older project that has no scope (flagged, not blocked): approvers told once per project per day. */
export async function notifyNoScopeTask(project: ExceptionProject, actor: IUser, taskTitle: string): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const already = await Notification.exists({
      type: "change_exception",
      project: project._id as mongoose.Types.ObjectId,
      title: { $regex: `^${EXCEPTION_LABEL.no_scope_task}` },
      createdAt: { $gte: since },
    });
    if (already) return;
    await notifyException("no_scope_task", actor, [
      { project, details: [["Task", taskTitle], ["Note", "This project has no scope — add its scope (or the brand's) on the project"]] },
    ]);
  } catch (err) {
    console.error("[exceptions] no-scope task notify failed", err);
  }
}
