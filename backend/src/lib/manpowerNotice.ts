import mongoose from "mongoose";
import { Brand } from "../models/Brand.js";
import { APPROVED_PLAN, ManpowerPlan, type IManpowerRow } from "../models/ManpowerPlan.js";
import { ManpowerPlanNotice } from "../models/ManpowerPlanNotice.js";
import { Project } from "../models/Project.js";
import { User, type IUser } from "../models/User.js";
import { logActivity } from "./activityLog.js";
import { clip } from "./changeRequests.js";
import { linkProjectsToRows } from "./manpower/match.js";
import { applyPlanDelta, planDelta } from "./manpowerMerge.js";
import { MANPOWER_ROLES } from "./manpowerRoles.js";
import { notifyUsersAsync } from "./notifications.js";
import { projectApproverIds } from "./projectApproval.js";

// ---------------------------------------------------------------------------
// Leadership's plan saves go live without telling anyone. "Send email" on the
// plan (POST /api/manpower/:month/notify) then sends ONE message about every
// change since the last email: the approvers get the full list (FYI), each
// person added to / taken off a line gets their own changes (with the linked
// projects). Tracked per month in ManpowerPlanNotice.baseVersion.
// ---------------------------------------------------------------------------

/**
 * Plan saves stopped notifying on this date. A month with no notice record yet counts its
 * changes from the latest approved version saved before it (earlier saves were notified then).
 */
const QUIET_SINCE = new Date("2026-10-23T00:00:00.000Z");

const ROLE_LABEL = new Map<string, string>(MANPOWER_ROLES.map((r) => [r.key as string, r.label as string]));

/** The approved version a month's un-emailed changes start from (record, else the last one before QUIET_SINCE). */
async function baseVersionOf(month: string): Promise<number | null> {
  const notice = await ManpowerPlanNotice.findOne({ month }).select("baseVersion").lean();
  if (notice) return notice.baseVersion ?? null;
  const before = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN, createdAt: { $lt: QUIET_SINCE } }).sort({ version: -1 }).select("version").lean();
  return before?.version ?? null;
}

/** Before leadership writes a new approved version: records where the un-emailed changes start (once). */
export async function markPlanNoticeBase(month: string): Promise<void> {
  try {
    if (await ManpowerPlanNotice.exists({ month })) return;
    const baseVersion = await baseVersionOf(month);
    await ManpowerPlanNotice.updateOne({ month }, { $setOnInsert: { month, baseVersion } }, { upsert: true });
  } catch (err) {
    console.error("[manpower] notice base failed", month, err);
  }
}

/** An approved change request made `version` live: its changes stay out of the next "Send email". */
export async function markPlanApprovedVersion(month: string, version: number): Promise<void> {
  try {
    await markPlanNoticeBase(month);
    await ManpowerPlanNotice.updateOne({ month }, { $addToSet: { approvedVersions: version } });
  } catch (err) {
    console.error("[manpower] notice approval mark failed", month, err);
  }
}

/**
 * The rows "not emailed yet" are counted from: the last emailed version, with every approved
 * request's own step (previous approved version → the version it made live) laid on top, as if
 * already known. A later leadership edit of the same line / cell still differs, so it counts.
 */
async function knownRows(month: string, baseVersion: number | null, latestVersion: number, approvedVersions: number[]): Promise<IManpowerRow[]> {
  const versions = await ManpowerPlan.find({ month, ...APPROVED_PLAN, version: { $gte: baseVersion ?? 0, $lte: latestVersion } })
    .sort({ version: 1 })
    .select("version rows")
    .lean();
  const start = baseVersion != null ? versions.find((v) => v.version === baseVersion) : undefined;
  let previous = (start?.rows ?? []) as IManpowerRow[];
  let known = previous;
  const approvals = new Set(approvedVersions);
  for (const v of versions) {
    if (baseVersion != null && v.version <= baseVersion) continue;
    const rows = v.rows as IManpowerRow[];
    if (approvals.has(v.version)) known = applyPlanDelta(known, planDelta(previous, rows));
    previous = rows;
  }
  return known;
}

/** The latest approved version vs what people already know: what "Send email" would send. */
async function pendingNotice(month: string) {
  const latest = await ManpowerPlan.findOne({ month, ...APPROVED_PLAN }).sort({ version: -1 }).select("version rows createdAt createdBy").populate("createdBy", "name").lean();
  if (!latest) return null;
  const notice = await ManpowerPlanNotice.findOne({ month }).select("approvedVersions").lean();
  const baseVersion = await baseVersionOf(month);
  const { planChanges } = await import("../controllers/manpower.js");
  const after = latest.rows as IManpowerRow[];
  const before = baseVersion === latest.version ? after : await knownRows(month, baseVersion, latest.version, notice?.approvedVersions ?? []);
  const changes = baseVersion === latest.version ? [] : await planChanges(before, after);
  return { latest, baseVersion, before, changes };
}

/** For the plan pages' "Version N saved — changes not emailed yet" banner (leadership). */
export async function planNoticeInfo(month: string) {
  const [pending, notice] = await Promise.all([pendingNotice(month), ManpowerPlanNotice.findOne({ month }).populate("emailedBy", "name").lean()]);
  if (!pending) return null;
  const savedBy = pending.latest.createdBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  const emailedBy = notice?.emailedBy as unknown as { _id: mongoose.Types.ObjectId; name?: string } | null;
  return {
    version: pending.latest.version,
    baseVersion: pending.baseVersion,
    changes: pending.changes.length,
    savedAt: pending.latest.createdAt,
    savedBy: savedBy?._id ? { _id: String(savedBy._id), name: savedBy.name ?? "" } : null,
    emailedAt: notice?.emailedAt ?? null,
    emailedBy: emailedBy?._id ? { _id: String(emailedBy._id), name: emailedBy.name ?? "" } : null,
    emailedVersion: notice?.emailedVersion ?? null,
  };
}

/** Each person's line / role changes between two plan versions ("Added" / "Taken off"), with the lines' keys. */
function peopleChanges(before: IManpowerRow[], after: IManpowerRow[]) {
  const slots = (rows: IManpowerRow[]) => {
    const out = new Map<string, Map<string, string>>();
    for (const r of rows)
      for (const c of r.cells)
        for (const u of c.users ?? []) {
          const id = String(u);
          const mine = out.get(id) ?? new Map<string, string>();
          mine.set(`${r.key}|${c.role}`, `${r.name} · ${ROLE_LABEL.get(c.role) ?? c.role}`);
          out.set(id, mine);
        }
    return out;
  };
  const was = slots(before);
  const now = slots(after);
  const people = new Map<string, { added: string[]; removed: string[]; lines: Set<string> }>();
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const a = was.get(id) ?? new Map<string, string>();
    const b = now.get(id) ?? new Map<string, string>();
    const added = [...b].filter(([k]) => !a.has(k));
    const removed = [...a].filter(([k]) => !b.has(k));
    if (!added.length && !removed.length) continue;
    people.set(id, {
      added: added.map(([, label]) => label),
      removed: removed.map(([, label]) => label),
      lines: new Set([...added, ...removed].map(([k]) => k.split("|")[0]!)),
    });
  }
  return people;
}

/** Line key → the names of the projects linked to it (this month). */
async function projectsByLine(month: string, rows: IManpowerRow[]): Promise<Map<string, string[]>> {
  const [projects, brands] = await Promise.all([
    Project.find({ archivedAt: null }).select("name code brand naming deadline manpowerRow").lean(),
    Brand.find({}).select("name").lean(),
  ]);
  const links = linkProjectsToRows(
    month,
    rows.map((r) => ({ key: r.key, brand: r.brand ? String(r.brand) : null, type: r.type, name: r.name })),
    projects.map((p) => ({
      _id: String(p._id),
      name: p.name,
      brand: p.brand ? String(p.brand) : p.naming?.brand ? String(p.naming.brand) : null,
      naming: p.naming ? { type: p.naming.type, month: p.naming.month, title: p.naming.title } : null,
      deadline: p.deadline ?? null,
      manpowerRow: p.manpowerRow ?? null,
    })),
    new Map(brands.map((b) => [String(b._id), b.name]))
  );
  const name = new Map(projects.map((p) => [String(p._id), p.code ? `${p.code} · ${p.name}` : p.name]));
  const out = new Map<string, string[]>();
  for (const [projectId, key] of links) out.set(key, [...(out.get(key) ?? []), name.get(projectId) ?? ""]);
  return out;
}

/**
 * "Send email": one message about every plan change since the last email — the approvers
 * get the whole list, each affected person their own lines (and the projects on them).
 * Returns null when there is nothing new to send. Plan editors and leadership send it.
 */
export async function sendPlanNotice(month: string, actor: IUser, note: string, ip?: string): Promise<{ version: number; changes: number; people: number } | null> {
  const pending = await pendingNotice(month);
  if (!pending || pending.changes.length === 0) return null;
  const { latest, baseVersion, before, changes } = pending;
  const after = latest.rows as IManpowerRow[];
  const update = Boolean((await ManpowerPlanNotice.findOne({ month }).select("emailedAt").lean())?.emailedAt);
  const range = baseVersion != null ? `versions ${baseVersion} → ${latest.version}` : `version ${latest.version}`;
  const title = `Manpower plan ${month} — ${range}`;
  const link = `/manpower?month=${month}`;
  const noteRow: Array<[string, string]> = note ? [["Note", clip(note, 500)]] : [];
  const shown = changes.slice(0, 40);

  // The approvers / leadership: everything (FYI).
  await notifyUsersAsync({
    recipients: await projectApproverIds(),
    actor,
    type: "change_exception",
    title: `Manpower plan changed${update ? " (update)" : ""}: ${month}`,
    message: `${actor.name}: ${title} (${changes.length} change${changes.length === 1 ? "" : "s"}).`,
    link,
    email: {
      subject: `For your information: ${title}${update ? " (update)" : ""}`,
      heading: "Changed from the manpower plan",
      intro: `${actor.name} changed the manpower plan (${changes.length === 1 ? "1 change" : `${changes.length} changes`}${update ? " since the last email" : ""}). It's live already — nothing to approve.`,
      cardTitle: title,
      rows: [
        ...noteRow,
        ...shown.map((c): [string, string] => [c.label, c.before === "—" && c.after ? c.after : `${c.before} → ${c.after}`]),
        ...(changes.length > shown.length ? [["…", `${changes.length - shown.length} more in the app`] as [string, string]] : []),
      ],
      buttonLabel: "Open the plan",
    },
  });

  // The people affected: one message each with their own changes.
  const people = peopleChanges(before, after);
  const approvers = new Set((await projectApproverIds()).map(String));
  const lineProjects = await projectsByLine(month, after.length ? after : before);
  const names = new Map((await User.find({ _id: { $in: [...people.keys()] } }).select("name").lean()).map((u) => [String(u._id), u.name]));
  let told = 0;
  for (const [id, p] of people) {
    // Approvers already have the full list; the person saving knows.
    if (approvers.has(id) || id === String(actor._id) || !names.has(id)) continue;
    const projects = [...new Set([...p.lines].flatMap((k) => lineProjects.get(k) ?? []))].filter(Boolean);
    await notifyUsersAsync({
      recipients: [id],
      actor,
      type: "project_member_added",
      title: `Your manpower plan allocation changed: ${month}`,
      message: `${actor.name}: ${[p.added.length ? `added to ${p.added.join(", ")}` : "", p.removed.length ? `taken off ${p.removed.join(", ")}` : ""].filter(Boolean).join("; ")}.`,
      link,
      email: {
        subject: `Your manpower plan for ${month} changed`,
        heading: "Changed from the manpower plan",
        intro: `${actor.name} changed your allocation in the ${month} manpower plan.`,
        cardTitle: title,
        rows: [
          ...noteRow,
          ...p.added.map((l): [string, string] => ["Added to", l]),
          ...p.removed.map((l): [string, string] => ["Taken off", l]),
          ...(projects.length ? [["Projects", clip(projects.join(", "), 600)] as [string, string]] : []),
        ],
        buttonLabel: "Open the plan",
      },
    });
    told += 1;
  }

  await ManpowerPlanNotice.updateOne(
    { month },
    { $set: { baseVersion: latest.version, emailedAt: new Date(), emailedBy: actor._id, emailedVersion: latest.version }, $setOnInsert: { month } },
    { upsert: true }
  );
  logActivity({
    action: "settings_updated",
    actor,
    targetType: "manpower_plan",
    targetId: latest._id as mongoose.Types.ObjectId,
    targetName: `Manpower plan ${month} v${latest.version}`,
    details: { month, emailed: range, changes: changes.length, people: told, note: note || undefined },
    ip,
  });
  return { version: latest.version, changes: changes.length, people: told };
}
