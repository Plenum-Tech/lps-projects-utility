import mongoose from "mongoose";
import { Brand, type IBrand } from "../models/Brand.js";
import { latestPlan, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { Project, type IProject } from "../models/Project.js";
import { User, type IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { brandLocksScope } from "./brandFlow.js";
import { requestChange } from "./changeRequests.js";
import { applyLeadership } from "./leadership.js";
import { notifyUsersAsync } from "./notifications.js";
import { projectApproverIds } from "./projectApproval.js";
import { composeProjectName } from "./projectNaming.js";

// ---------------------------------------------------------------------------
// Monthly retainers. On the 1st of each month (Asia/Dubai date):
//  1. the month gets its manpower plan — a copy of last month's latest approved
//     version, saved as a PENDING version for leadership to approve;
//  2. every active, approved brand flagged "Monthly retainer" gets this month's
//     project(s): last month's project name with only the month changed (same
//     brand, type and title), scope from the brand, team from the new month's
//     plan (else the brand's leads). Brands without a scope are skipped;
//  3. the brand leads and the approvers are told what was created.
// Idempotent: a month that has a plan isn't copied again; a project that exists
// (same brand / type / month / title) isn't created again.
// ---------------------------------------------------------------------------

const TZ = "Asia/Dubai";

/** "YYYY-MM-DD" in Dubai. */
function dubaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m! - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The job acts as leadership: the first projects approver (Aasim), else an admin. */
async function jobActor(): Promise<IUser | null> {
  const approvers = await projectApproverIds();
  let user: IUser | null = null;
  for (const id of approvers) {
    user = await User.findById(id);
    if (user) break;
  }
  user ??= await User.findOne({ role: "admin" }).sort({ createdAt: 1 });
  if (!user) return null;
  await applyLeadership(user);
  return user;
}

export interface RetainerRunResult {
  month: string;
  ran: boolean;
  plan: { copiedFrom: string; version: number; lines: number } | { skipped: string };
  created: Array<{ brand: string; projectId: string; name: string; teamFrom: "plan" | "leads" | "none" }>;
  skipped: Array<{ brand: string; reason: string }>;
}

/** Step 1: this month's plan as a pending copy of last month's latest approved version. */
async function copyPlan(month: string, actor: IUser): Promise<RetainerRunResult["plan"]> {
  if (await ManpowerPlan.exists({ month })) return { skipped: "The month already has a plan" };
  const from = previousMonth(month);
  const prev = await latestPlan(from);
  if (!prev) return { skipped: `No approved plan for ${from} to copy` };
  const rows = prev.toObject().rows as IManpowerRow[];
  let version = 1;
  try {
    await ManpowerPlan.create({
      month,
      version,
      rows,
      note: `Copied from ${monthLabel(from)} v${prev.version} for the new month — waiting for approval`,
      maxProjectsPerPerson: prev.maxProjectsPerPerson,
      source: "copy",
      status: "pending",
      createdBy: actor._id,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { skipped: "The month already has a plan" };
    throw err;
  }
  await requestChange({
    kind: "manpower_plan",
    actor,
    title: `Manpower plan ${month} — version ${version} (copied from ${from})`,
    changes: [{ label: "Plan", before: "—", after: `Copy of ${monthLabel(from)} v${prev.version} (${rows.length} lines), made automatically for the new month` }],
    payload: { month, version },
    month,
    version,
    notifyActor: true,
  });
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "manpower_plan",
    targetName: `Manpower plan ${month} v${version}`,
    details: { month, version, source: "copy", from: `${from} v${prev.version}`, via: "monthly_retainer", status: "pending" },
  });
  return { copiedFrom: `${from} v${prev.version}`, version, lines: rows.length };
}

/** Last month's structured, non-pitch projects of the brand; none → its most recent one. */
async function sourceProjects(brand: IBrand, from: string): Promise<IProject[]> {
  const brandId = brand._id as mongoose.Types.ObjectId;
  const base = {
    $or: [{ brand: brandId }, { "naming.brand": brandId }],
    naming: { $ne: null },
    "naming.type": { $not: /^pitch$/i },
  };
  const last = await Project.find({ ...base, "naming.month": from, archivedAt: null }).sort({ createdAt: 1 });
  if (last.length) return last;
  const recent = await Project.find(base).sort({ "naming.month": -1, createdAt: -1 }).limit(1);
  return recent;
}

/**
 * Runs the monthly retainer step. Scheduled daily; acts only on the 1st (Dubai date)
 * unless `month` is given (manual run: `bun src/scripts/runJobs.ts retainers 2026-11`).
 */
export async function runMonthlyRetainers(now: Date = new Date(), options: { month?: string } = {}): Promise<RetainerRunResult> {
  const today = dubaiDate(now);
  const month = options.month ?? today.slice(0, 7);
  const result: RetainerRunResult = { month, ran: false, plan: { skipped: "Not the 1st" }, created: [], skipped: [] };
  if (!options.month && !today.endsWith("-01")) return result;
  const actor = await jobActor();
  if (!actor) {
    result.plan = { skipped: "No approver or admin to act as" };
    return result;
  }
  result.ran = true;
  result.plan = await copyPlan(month, actor);

  const from = previousMonth(month);
  const brands = await Brand.find({
    monthlyRetainer: true,
    active: true,
    $or: [{ status: { $exists: false } }, { status: "approved" }],
  }).sort({ nameKey: 1 });
  const { createProjectCore } = await import("../controllers/projects.js");
  const leadsByBrand = new Map<string, { brand: IBrand; projects: string[] }>();

  for (const brand of brands) {
    if (!brandLocksScope(brand)) {
      result.skipped.push({ brand: brand.name, reason: "The brand has no scope — add its scope, then create the month's project" });
      continue;
    }
    const sources = await sourceProjects(brand, from);
    if (sources.length === 0) {
      result.skipped.push({ brand: brand.name, reason: "The brand has no project to roll over" });
      continue;
    }
    const seen = new Set<string>();
    for (const src of sources) {
      const n = src.naming!;
      const key = `${n.type.toLowerCase()}|${n.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const exists = await Project.exists({ "naming.brand": brand._id, "naming.type": n.type, "naming.month": month, "naming.title": n.title });
      if (exists) continue;
      const name = composeProjectName(brand.name, n.type, month, n.title);
      const created = await createProjectCore(
        actor,
        {
          naming: { brand: String(brand._id), type: n.type, month, title: n.title },
          // No scope / team: the scope comes from the brand, the team from the month's plan (else the brand's leads).
          departments: (src.departments ?? []).map(String),
          ...(src.category ? { category: String(src.category) } : {}),
          progressMode: src.progressMode,
          isPublic: src.isPublic,
          manualTimeLogs: src.manualTimeLogs,
          requireTaskApproval: src.requireTaskApproval,
        },
        undefined,
        { planIncludesPending: true, skipPlanSync: true, activityExtra: { via: "monthly_retainer", from: String(src._id) } }
      );
      if ("error" in created) {
        result.skipped.push({ brand: brand.name, reason: `${name}: ${created.error}` });
        continue;
      }
      const p = created.project;
      const teamFrom = (p.team ?? []).length ? "plan" : (brand.leads ?? []).length ? "leads" : "none";
      result.created.push({ brand: brand.name, projectId: String(p._id), name: p.name, teamFrom });
      const entry = leadsByBrand.get(String(brand._id)) ?? { brand, projects: [] };
      entry.projects.push(p.name);
      leadsByBrand.set(String(brand._id), entry);
    }
  }

  // Step 3: the brand leads (their brand's projects) and the approvers (everything).
  for (const { brand, projects } of leadsByBrand.values()) {
    if (!(brand.leads ?? []).length) continue;
    await notifyUsersAsync({
      recipients: brand.leads ?? [],
      actor,
      includeActor: true,
      type: "retainer_projects_created",
      title: `${brand.name}: ${monthLabel(month)} project${projects.length === 1 ? "" : "s"} created`,
      message: `Monthly retainer: ${projects.join(", ")}. Scope from the brand, team from the ${monthLabel(month)} plan.`,
      link: `/brands/${String(brand._id)}`,
      email: {
        subject: `${brand.name}: ${monthLabel(month)} retainer project${projects.length === 1 ? "" : "s"} created`,
        heading: "Monthly Retainer Projects Created",
        intro: `The new month's project${projects.length === 1 ? " was" : "s were"} created automatically. The scope comes from the brand; the team from the ${monthLabel(month)} manpower plan.`,
        cardTitle: brand.name,
        rows: projects.map((name): [string, string] => ["Project", name]),
        buttonLabel: "Open the brand",
      },
    }).catch((err) => console.error("[retainers] lead notification failed", err));
  }
  // Only a run that did something reports (the job runs more than once on the 1st).
  if (result.created.length || "copiedFrom" in result.plan) {
    await notifyUsersAsync({
      recipients: await projectApproverIds(),
      actor,
      includeActor: true,
      type: "retainer_projects_created",
      title: `Monthly retainers ${monthLabel(month)}: ${result.created.length} project${result.created.length === 1 ? "" : "s"} created${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`,
      message: [
        result.created.map((c) => c.name).join(", "),
        result.skipped.length ? `Skipped: ${result.skipped.map((s) => `${s.brand} (${s.reason})`).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join(". "),
      link: "/brands",
      email: {
        subject: `Monthly retainers ${monthLabel(month)}: ${result.created.length} created${result.skipped.length ? `, ${result.skipped.length} skipped` : ""}`,
        heading: "Monthly Retainer Projects",
        intro:
          "copiedFrom" in result.plan
            ? `The ${monthLabel(month)} manpower plan was copied from last month and is waiting for your approval. These are the month's retainer projects.`
            : `These are the ${monthLabel(month)} retainer projects.`,
        cardTitle: `Retainers · ${monthLabel(month)}`,
        rows: [
          ...result.created.map((c): [string, string] => [c.brand, c.name]),
          ...result.skipped.map((s): [string, string] => [`Skipped · ${s.brand}`, s.reason]),
        ],
        buttonLabel: "Open Brands",
      },
    }).catch((err) => console.error("[retainers] approver notification failed", err));
  }
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "brand",
    targetName: `Monthly retainers ${month}`,
    details: { via: "monthly_retainer", month, created: result.created.length, skipped: result.skipped.length },
  });
  return result;
}

/** "2026-11" → "November 2026". */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
