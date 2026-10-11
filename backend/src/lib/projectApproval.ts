import crypto from "node:crypto";
import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { Project, type IProject, type ProjectApprovalStatus } from "../models/Project.js";
import { getProjectSettings } from "../models/ProjectSettings.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { genericEmailTemplate, sendBatchEmails } from "./email.js";
import { firstNameOf, notifyUsers } from "./notifications.js";
import { formatNamingMonth } from "./projectNaming.js";

// ---------------------------------------------------------------------------
// Project approval: a new project waits for an approver (Aasim by default)
// before anyone can add tasks to it. Approvers get an email with a link to a
// page where they approve or reject (a button press — opening the link alone
// never decides, so mail scanners can't approve). Approvers can also decide on
// the project page. Projects created before approval existed count as approved.
// ---------------------------------------------------------------------------

/** Used when no approver is configured in Settings → Projects. */
const DEFAULT_APPROVER_EMAILS = (process.env.PROJECT_APPROVER_EMAILS ?? "aasim@lps-me.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const TOKEN_DAYS = 30;

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** Legacy projects (no approval record) and approved ones accept tasks. */
export function isProjectApproved(project: { approval?: { status?: string } | null }): boolean {
  return !project.approval?.status || project.approval.status === "approved";
}

/** Approver user ids: Settings → Projects, else PROJECT_APPROVER_EMAILS (default Aasim). */
export async function projectApproverIds(): Promise<mongoose.Types.ObjectId[]> {
  const settings = await getProjectSettings();
  if (settings.projectApprovers?.length) return settings.projectApprovers;
  const users = await User.find({ email: { $in: DEFAULT_APPROVER_EMAILS.map((e) => new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")) } })
    .select("_id")
    .lean();
  return users.map((u) => u._id);
}

export async function isProjectApprover(userId: mongoose.Types.ObjectId | string): Promise<boolean> {
  return (await projectApproverIds()).some((id) => id.toString() === userId.toString());
}

/** Names of the approvers, for messages ("Aasim"). */
export async function approverNames(): Promise<string> {
  const ids = await projectApproverIds();
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("name").lean() : [];
  return users.map((u) => u.name).join(" or ") || "an approver";
}

/** Message shown when a task is added to a project still awaiting approval. */
export async function notApprovedMessage(project: { approval?: { status?: string } | null }): Promise<string> {
  if (project.approval?.status === "rejected") {
    return "This project was rejected. Edit it and request approval again before adding tasks.";
  }
  return `This project is waiting for approval from ${await approverNames()}. Tasks can be added once it's approved.`;
}

async function projectRows(project: IProject): Promise<Array<[string, string]>> {
  const brandId = project.naming?.brand ?? project.brand ?? null;
  const [brand, manager] = await Promise.all([
    brandId ? Brand.findById(brandId).select("name").lean() : null,
    project.manager ? User.findById(project.manager).select("name").lean() : null,
  ]);
  const team = new Set((project.team ?? []).flatMap((t) => t.users.map(String))).size;
  return [
    ["Project", project.name],
    ["Code", project.code],
    ["Brand", brand?.name ?? "—"],
    ["Type", project.naming?.type ?? "—"],
    ["Month", project.naming?.month ? formatNamingMonth(project.naming.month) : "—"],
    ["Manager", manager?.name ?? "—"],
    ["Team", team ? `${team} people` : "—"],
  ];
}

/**
 * Puts a project into "awaiting approval" and emails each approver a personal
 * link. When the requester is an approver (or nobody can approve), the project
 * is approved straight away.
 */
export async function requestProjectApproval(
  projectId: mongoose.Types.ObjectId,
  actor: IUser,
  options: { sendEmail?: boolean; resubmit?: boolean } = {}
): Promise<ProjectApprovalStatus> {
  const settings = await getProjectSettings();
  const approvers = await projectApproverIds();
  const now = new Date();
  const selfApproved = approvers.some((id) => id.equals(actor._id as mongoose.Types.ObjectId));
  if (!settings.projectApprovalRequired || approvers.length === 0 || selfApproved) {
    await Project.updateOne(
      { _id: projectId },
      {
        $set: {
          approval: {
            status: "approved",
            requestedAt: now,
            requestedBy: actor._id,
            decidedAt: now,
            decidedBy: selfApproved ? actor._id : null,
            reason: selfApproved ? "Created by an approver" : approvers.length === 0 ? "No approver configured" : "Approval not required",
            tokens: [],
          },
        },
      }
    );
    return "approved";
  }

  const tokens = approvers.map((user) => {
    const token = crypto.randomBytes(32).toString("base64url");
    return { user, token, hash: hashToken(token), expiresAt: new Date(now.getTime() + TOKEN_DAYS * 86_400_000) };
  });
  await Project.updateOne(
    { _id: projectId },
    {
      $set: {
        approval: {
          status: "pending",
          requestedAt: now,
          requestedBy: actor._id,
          decidedAt: null,
          decidedBy: null,
          reason: "",
          tokens: tokens.map(({ user, hash, expiresAt }) => ({ user, hash, expiresAt })),
        },
      },
    }
  );
  const project = await Project.findById(projectId);
  if (!project) return "pending";

  const verb = options.resubmit ? "sent again for approval" : "created";
  notifyUsers({
    recipients: approvers,
    actor,
    type: "project_approval_requested",
    title: "Project awaiting your approval",
    message: `${actor.name} ${verb} ${project.name}. Approve it so the team can add tasks.`,
    link: `/projects/${project._id.toString()}`,
    project: project._id as mongoose.Types.ObjectId,
    skipEmail: true,
    email: { subject: "", heading: "", intro: "" },
  });

  if (options.sendEmail !== false) {
    const users = await User.find({ _id: { $in: approvers } }).select("name email").lean();
    const byId = new Map(users.map((u) => [u._id.toString(), u]));
    const rows = await projectRows(project);
    await sendBatchEmails(
      tokens.flatMap(({ user, token }) => {
        const u = byId.get(user.toString());
        if (!u?.email) return [];
        return [
          {
            to: u.email,
            subject: `Approval needed: ${project.name}`,
            html: genericEmailTemplate({
              firstName: firstNameOf(u.name),
              heading: "Project awaiting your approval",
              intro: `${actor.name} ${verb} this project. Nobody can add tasks to it until you approve it.`,
              cardTitle: project.name,
              rows: [...rows, ["Requested by", actor.name]],
              quote: project.summary || null,
              path: `/project-approval/${token}`,
              buttonLabel: "Review and approve",
            }),
          },
        ];
      })
    );
  }
  return "pending";
}

/** Approve or reject a pending project. Returns an error message, or null on success. */
export async function decideProjectApproval(
  project: IProject,
  approver: Pick<IUser, "_id" | "name" | "email" | "role">,
  decision: "approve" | "reject",
  reason: string,
  via: "email" | "app",
  ip?: string
): Promise<string | null> {
  if (project.approval?.status !== "pending") {
    return project.approval?.status === "approved" ? "This project is already approved." : "This project isn't awaiting approval.";
  }
  const status: ProjectApprovalStatus = decision === "approve" ? "approved" : "rejected";
  const updated = await Project.findOneAndUpdate(
    { _id: project._id, "approval.status": "pending" },
    {
      $set: {
        "approval.status": status,
        "approval.decidedAt": new Date(),
        "approval.decidedBy": approver._id,
        "approval.reason": reason,
        "approval.tokens": [],
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) return "Someone already decided on this project.";

  logActivity({
    action: "project_updated",
    actor: approver as IUser,
    targetType: "project",
    targetId: project._id as mongoose.Types.ObjectId,
    targetName: `${project.code} · ${project.name}`,
    details: { approval: status, via, reason: reason || undefined },
    ip,
  });
  const recipients = [project.approval.requestedBy, project.createdBy, project.manager].filter(Boolean) as mongoose.Types.ObjectId[];
  const approved = status === "approved";
  notifyUsers({
    recipients,
    actor: approver as IUser,
    type: approved ? "project_approved" : "project_rejected",
    title: approved ? "Project approved" : "Project rejected",
    message: approved
      ? `${approver.name} approved ${project.name}. You can add tasks now.`
      : `${approver.name} rejected ${project.name}${reason ? `: ${reason}` : ""}.`,
    link: `/projects/${project._id.toString()}`,
    project: project._id as mongoose.Types.ObjectId,
    email: {
      subject: approved ? `Approved: ${project.name}` : `Rejected: ${project.name}`,
      heading: approved ? "Project approved" : "Project rejected",
      intro: approved
        ? `${approver.name} approved this project. You can add tasks to it now.`
        : `${approver.name} rejected this project. Edit it and request approval again.`,
      cardTitle: project.name,
      quote: reason || null,
      quoteAuthor: reason ? approver.name : null,
      buttonLabel: "Open project",
    },
  });
  return null;
}

/** Approval as the API returns it (never the tokens). */
export async function approvalView(project: Pick<IProject, "approval">) {
  const a = project.approval;
  if (!a?.status) return null;
  const ids = [a.requestedBy, a.decidedBy].filter(Boolean) as mongoose.Types.ObjectId[];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("name").lean() : [];
  const name = (id?: mongoose.Types.ObjectId | null) => (id ? (users.find((u) => u._id.equals(id))?.name ?? "Former user") : null);
  return {
    status: a.status,
    requestedAt: a.requestedAt,
    requestedBy: a.requestedBy ? { _id: a.requestedBy.toString(), name: name(a.requestedBy) } : null,
    decidedAt: a.decidedAt ?? null,
    decidedBy: a.decidedBy ? { _id: a.decidedBy.toString(), name: name(a.decidedBy) } : null,
    reason: a.reason ?? "",
  };
}
