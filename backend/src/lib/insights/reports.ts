import crypto from "node:crypto";
import mongoose from "mongoose";
import { InsightBoard, type IInsightBoard, type InsightSchedule } from "../../models/InsightBoard.js";
import { InsightReportRun } from "../../models/InsightReportRun.js";
import { User } from "../../models/User.js";
import { appTimeZone, zonedParts, zonedToUtc } from "../appTime.js";
import { insightReportTemplate, type InsightReportSection } from "../email.js";
import { applyLeadership } from "../leadership.js";
import { notifyUsersAsync } from "../notifications.js";
import { projectApproverIds } from "../projectApproval.js";
import { runBlock, type BlockSpec } from "./board.js";
import type { Dataset } from "./datasets.js";

// ---------------------------------------------------------------------------
// Scheduled board reports (leadership only): the board's blocks are re-run
// server-side (no AI call) and sent as ONE email + in-app notification to the
// recipients — skipped when nothing changed since the last report unless the
// board asks to send anyway. Ticked by the job scheduler (lib/scheduler.ts /
// Inngest "insight-reports"); POST /api/insights/reports/tick runs it by hand.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const REPORT_ROWS = 10;
const MAX_REPORTS_PER_TICK = 50;

/** Next run after `from` for a schedule (wall-clock schedules in the app timezone); null = off. */
export function nextRunAt(schedule: InsightSchedule, from: Date = new Date()): Date | null {
  switch (schedule) {
    case "1h":
    case "2h":
    case "4h": {
      const hours = Number(schedule.slice(0, -1));
      return new Date(Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + hours * HOUR_MS);
    }
    case "daily9":
    case "weeklyMon9": {
      const p = zonedParts(from);
      for (let add = 0; add <= 8; add++) {
        const day = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
        const weekday = day.getUTCDay();
        if (schedule === "weeklyMon9" && weekday !== 1) continue;
        const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 0);
        if (at.getTime() > from.getTime()) return at;
      }
      return null;
    }
    default:
      return null;
  }
}

export const SCHEDULE_LABELS: Record<InsightSchedule, string> = {
  off: "Off",
  "1h": "Every hour",
  "2h": "Every 2 hours",
  "4h": "Every 4 hours",
  daily9: "Daily at 9:00",
  weeklyMon9: "Mondays at 9:00",
};

const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : v == null ? "—" : String(v));

function section(block: BlockSpec, dataset: Dataset | null, error: string | undefined, before: Record<string, string | number | null> | undefined): InsightReportSection {
  if (!dataset) return { title: block.title, subtitle: "", kpis: [], changes: [], columns: [], rows: [], barColumn: null, more: 0, error: error ?? "No data" };
  const changes: string[] = [];
  for (const k of dataset.kpis) {
    const prev = before?.[k.label];
    if (prev !== undefined && prev !== k.value) changes.push(`${k.label}: ${fmt(prev)} → ${fmt(k.value)}`);
  }
  const columns = dataset.columns.slice(0, 6);
  const firstSeries = dataset.series[0];
  const bar = firstSeries ? columns.findIndex((c) => c.key === firstSeries) : -1;
  return {
    title: block.title,
    subtitle: [dataset.subtitle, ...Object.entries(dataset.applied).map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join(" · "),
    kpis: dataset.kpis.map((k) => [k.label, fmt(k.value)]),
    changes,
    columns: columns.map((c) => c.label),
    rows: dataset.rows.slice(0, REPORT_ROWS).map((r) => columns.map((c) => `${fmt(r[c.key])}${c.unit && typeof r[c.key] === "number" ? c.unit : ""}`)),
    barColumn: bar >= 0 ? bar : null,
    more: Math.max(0, dataset.rows.length - REPORT_ROWS),
  };
}

/** Leadership recipients of a board's report (non-leadership ids are dropped; the owner by default). */
export async function reportRecipients(board: Pick<IInsightBoard, "user" | "report">): Promise<mongoose.Types.ObjectId[]> {
  const leaders = new Set((await projectApproverIds()).map(String));
  const wanted = board.report.recipients?.length ? board.report.recipients : [board.user];
  return wanted.filter((id) => leaders.has(String(id)));
}

export interface ReportOutcome {
  sent: boolean;
  reason: string;
  recipients: number;
  rows: number;
}

/** Runs one board's report now. `force` sends even when nothing changed. */
export async function runBoardReport(board: IInsightBoard, trigger: "schedule" | "manual", force = false): Promise<ReportOutcome> {
  const started = Date.now();
  const finish = async (outcome: ReportOutcome, recipients: mongoose.Types.ObjectId[] = []) => {
    await InsightReportRun.create({
      board: board._id,
      owner: board.user,
      trigger,
      recipients,
      sent: outcome.sent,
      reason: outcome.reason,
      blocks: board.blocks.length,
      rows: outcome.rows,
      ms: Date.now() - started,
    });
    return outcome;
  };
  // The schedule moves on whatever happens (no retry storm on a broken board).
  board.report.nextRunAt = nextRunAt(board.report.schedule);
  const owner = await User.findById(board.user);
  if (!owner || !(await applyLeadership(owner))) {
    await board.save();
    return finish({ sent: false, reason: "owner is not leadership", recipients: 0, rows: 0 });
  }
  const recipients = await reportRecipients(board);
  if (recipients.length === 0 || board.blocks.length === 0) {
    await board.save();
    return finish({ sent: false, reason: recipients.length === 0 ? "no leadership recipients" : "empty board", recipients: 0, rows: 0 });
  }

  const results = await Promise.all(board.blocks.map((b) => runBlock(b as BlockSpec, { user: owner })));
  const rows = results.reduce((s, r) => s + (r.dataset?.rows.length ?? 0), 0);
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(results.map((r) => (r.dataset ? [r.dataset.kpis, r.dataset.rows] : r.error))))
    .digest("hex");
  if (!force && !board.report.sendUnchanged && hash === board.report.lastHash) {
    await board.save();
    return finish({ sent: false, reason: "unchanged since the last report", recipients: 0, rows }, recipients);
  }

  const previous = (board.report.lastKpis ?? {}) as Record<string, Record<string, string | number | null>>;
  const sections = board.blocks.map((b, i) => section(b as BlockSpec, results[i]!.dataset, results[i]!.error, previous[b.id]));
  const asOf = new Date().toLocaleString("en-GB", { timeZone: appTimeZone(), dateStyle: "medium", timeStyle: "short" });
  const link = `/insights?board=${board._id}`;
  await notifyUsersAsync({
    recipients,
    actor: owner,
    includeActor: true,
    type: "insight_report",
    title: `Insights report: ${board.title}`,
    message: `${board.blocks.length} block${board.blocks.length === 1 ? "" : "s"} as of ${asOf}${sections.some((s) => s.changes.length) ? " — numbers changed since the last report" : ""}`,
    link,
    email: {
      subject: `Insights: ${board.title} (as of ${asOf})`,
      heading: board.title,
      intro: "",
      render: (firstName) =>
        insightReportTemplate({ firstName, heading: board.title, intro: `Your board as of ${asOf} (${SCHEDULE_LABELS[board.report.schedule].toLowerCase()} report).`, sections, path: link }),
    },
  });
  board.report.lastHash = hash;
  board.report.lastSentAt = new Date();
  board.report.lastKpis = Object.fromEntries(
    board.blocks.map((b, i) => [b.id, Object.fromEntries((results[i]!.dataset?.kpis ?? []).map((k) => [k.label, typeof k.value === "boolean" ? String(k.value) : k.value]))])
  );
  board.markModified("report.lastKpis");
  await board.save();
  return finish({ sent: true, reason: force ? "sent (forced)" : "sent", recipients: recipients.length, rows }, recipients);
}

/** Scheduler tick: every board whose report is due. */
export async function runDueInsightReports(now: Date = new Date()): Promise<{ due: number; sent: number; skipped: number }> {
  const boards = await InsightBoard.find({ "report.schedule": { $ne: "off" }, "report.nextRunAt": { $lte: now } })
    .sort({ "report.nextRunAt": 1 })
    .limit(MAX_REPORTS_PER_TICK);
  let sent = 0;
  for (const board of boards) {
    try {
      if ((await runBoardReport(board, "schedule")).sent) sent++;
    } catch (err) {
      console.error(`[insights] report for board ${board._id} failed`, err);
    }
  }
  return { due: boards.length, sent, skipped: boards.length - sent };
}
