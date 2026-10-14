import mongoose from "mongoose";
import { ChangeRequest, type ChangeKind, type IChangeLine, type IChangeRequest } from "../models/ChangeRequest.js";
import type { IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { isLeadershipUser } from "./leadership.js";
import { notifyUsers } from "./notifications.js";
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
  campaign_new: "New campaign",
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
}): Promise<IChangeRequest> {
  const target: Record<string, unknown> =
    params.kind === "project_change"
      ? { project: params.project }
      : params.kind === "brand_edit"
        ? { brand: params.brand }
        : { month: params.month };
  // Each new campaign is its own request; other kinds replace the pending one for their target.
  const previous = params.kind === "campaign_new" ? null : await ChangeRequest.findOne({ kind: params.kind, status: "pending", ...target });
  let payload = params.payload;
  let changes = params.changes;
  if (previous && params.kind !== "manpower_plan") {
    payload = { ...(previous.payload ?? {}), ...params.payload };
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
