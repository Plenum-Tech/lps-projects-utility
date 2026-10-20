import mongoose from "mongoose";
import { Notification } from "../models/Notification.js";
import { ChangeRequest, type ChangeKind, type IChangeLine, type IChangeRequest } from "../models/ChangeRequest.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { isLeadershipUser } from "./leadership.js";
import { notifyUsers, notifyUsersAsync } from "./notifications.js";
import { isProjectApprover, projectApproverIds } from "./projectApproval.js";

// ---------------------------------------------------------------------------
// Changes that need leadership approval (models/ChangeRequest.ts). Each request
// emails leadership when it is made: project and brand changes one per
// project / brand, a manpower plan version as one consolidated list.
// ---------------------------------------------------------------------------

/** Leadership changes apply directly (marked by requireAuth, or an approver). */
export async function isLeadershipActor(user: IUser): Promise<boolean> {
  return isLeadershipUser(user) || (await isProjectApprover(user._id as mongoose.Types.ObjectId));
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
}): Promise<IChangeRequest> {
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
  });
  logActivity({
    action: "settings_updated",
    actor: params.actor,
    targetType: "change_request",
    targetId: request._id as mongoose.Types.ObjectId,
    targetName: params.title,
    details: { change: "requested", kind: params.kind, lines: changes.length },
    ip: params.ip,
  });
  const shown = changes.slice(0, 40);
  notifyUsers({
    recipients: await projectApproverIds(),
    actor: params.actor,
    includeActor: Boolean(params.notifyActor),
    type: "change_approval_requested",
    title: `${KIND_LABEL[params.kind]} to approve`,
    message: `${params.actor.name}: ${params.title} (${changes.length} change${changes.length === 1 ? "" : "s"}).`,
    link: "/approvals",
    email: {
      subject: `Approval needed: ${params.title}`,
      heading: `${KIND_LABEL[params.kind]} Awaiting Approval`,
      intro: `${params.actor.name} made ${changes.length === 1 ? "a change" : `${changes.length} changes`} that need your approval. Nothing changes until it's approved.`,
      cardTitle: params.title,
      rows: [
        ...shown.map((c): [string, string] => [c.label, c.before === "—" && c.after ? c.after : `${c.before} → ${c.after}`]),
        ...(changes.length > shown.length ? [["…", `${changes.length - shown.length} more in the app`] as [string, string]] : []),
      ],
      buttonLabel: "Review in Approvals",
    },
  });
  return request;
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
    link: request.project ? `/projects/${request.project.toString()}` : request.kind === "manpower_plan" ? "/manpower" : "/approvals",
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
