import { richTextToPlain } from "../richText.js";
import mongoose from "mongoose";
import { Task } from "../../models/Task.js";
import { TaskComment } from "../../models/TaskComment.js";
import { TaskFile } from "../../models/TaskFile.js";
import { TaskNote } from "../../models/TaskNote.js";
import { weekdayOf } from "./days.js";
import type { TaskFact } from "./facts.js";
import type { DeliverySettingsSnapshot } from "./settings.js";

// ---------------------------------------------------------------------------
// Brief score: the 7 LPS brief rules per task (tasks created in the period).
// A rule is "pass", "fail" or "na"; score = passed ÷ applicable (0–100).
// ---------------------------------------------------------------------------

export const BRIEF_RULE_KEYS = [
  "brief_attached",
  "written_brief",
  "monday",
  "lead_time",
  "not_same_day",
  "on_map",
  "final_asset",
] as const;
export type BriefRuleKey = (typeof BRIEF_RULE_KEYS)[number];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Minimum words (links excluded) for a written brief. */
export const WRITTEN_BRIEF_MIN_WORDS = 15;
/** Brands allowed same-day delivery by name (plus the brands picked in Settings → Delivery). */
const SAME_DAY_BRAND_NAMES = /\b(?:ajmal|wasl|emarat)\b/i;

/** Rule labels (weekday / lead days follow the delivery settings). */
export function briefRules(settings: DeliverySettingsSnapshot): Array<{ key: BriefRuleKey; label: string }> {
  return [
    { key: "brief_attached", label: "Brief attached (deck, doc or link)" },
    { key: "written_brief", label: `Written brief, ${WRITTEN_BRIEF_MIN_WORDS}+ words` },
    { key: "monday", label: `Briefed on a ${WEEKDAY_NAMES[settings.briefingWeekday] ?? "Monday"}` },
    { key: "lead_time", label: `≥${settings.minLeadDays} days lead time` },
    { key: "not_same_day", label: "No same-day delivery (unless Ajmal/Wasl/Emarat)" },
    { key: "on_map", label: "Doer is on the brand team map" },
    { key: "final_asset", label: "Final asset attached or frame.io/OneDrive link" },
  ];
}

export type RuleResult = "pass" | "fail" | "na";

/** http(s):// or www. links in free text. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;

export function findUrls(text: string | null | undefined): string[] {
  return text ? [...text.matchAll(URL_PATTERN)].map((m) => m[0]) : [];
}

/** Description without links, whitespace collapsed. */
export function writtenText(description: string | null | undefined): string {
  return (description ?? "").replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/** Lower-cased host of a link ("www.x" gets an implicit http://); null when unparsable. */
export function urlHost(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True when the link's host is one of `domains` or a subdomain of one. */
export function isAllowedDomainLink(url: string, domains: readonly string[]): boolean {
  const host = urlHost(url);
  if (!host) return false;
  return domains.some((d) => {
    const domain = d.trim().toLowerCase().replace(/^\*?\./, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

export function hasAllowedLink(texts: readonly (string | null | undefined)[], domains: readonly string[]): boolean {
  return texts.some((t) => findUrls(t).some((u) => isAllowedDomainLink(u, domains)));
}

export interface BriefInput {
  fact: TaskFact;
  description: string;
  /** Earliest task file upload (any file on the task or its subtasks). */
  firstFileAt: Date | null;
  fileCount: number;
  /** Final deliverable recorded at completion (a file or a link). */
  finalAsset: boolean;
  /** Bodies of comments and non-private notes (only those containing a link are needed). */
  linkTexts: string[];
  /** Stored AI verdict on the description (null = not checked). */
  ai: { verdict: "ok" | "weak" | "flagged"; score: number | null; reason: string } | null;
}

export interface BriefScore {
  results: Record<BriefRuleKey, RuleResult>;
  passed: number;
  applicable: number;
  /** passed ÷ applicable as 0–100 (rounded), null when no rule applies. */
  score: number | null;
  failed: BriefRuleKey[];
}

export const wordCount = (text: string) => (text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);

/**
 * Scores one task on the LPS brief rules. `onMap` = the people on the brand's
 * team map for the task (manpower-plan line of its creation month, else the
 * brand map; null = no map → n/a).
 */
export function scoreBrief(
  input: BriefInput,
  settings: DeliverySettingsSnapshot,
  brandName: string | null,
  onMap: Set<string> | null
): BriefScore {
  const f = input.fact;
  const urls = findUrls(input.description);
  const sameDayOk =
    f.brand !== null && (settings.sameDayBrands.includes(f.brand) || (brandName !== null && SAME_DAY_BRAND_NAMES.test(brandName)));

  const results: Record<BriefRuleKey, RuleResult> = {
    // Any file on the task, or a link in the description.
    brief_attached: input.fileCount > 0 || urls.length > 0 ? "pass" : "fail",
    // Written description (links removed) of at least 15 words.
    written_brief: wordCount(writtenText(input.description)) >= WRITTEN_BRIEF_MIN_WORDS ? "pass" : "fail",
    // Created on the briefing weekday (Monday by default; app timezone).
    monday: weekdayOf(f.createdDay) === settings.briefingWeekday ? "pass" : "fail",
    // due − created ≥ minimum lead days (n/a without a due date).
    lead_time: f.dueDay === null ? "na" : f.dueDay - f.createdDay >= settings.minLeadDays ? "pass" : "fail",
    // Not due on the creation day, unless the brand allows same-day delivery.
    not_same_day: f.dueDay === null ? "na" : f.dueDay !== f.createdDay || sameDayOk ? "pass" : "fail",
    // Any doer on the brand's team map (n/a without a map or without doers).
    on_map: !onMap || f.doers.length === 0 ? "na" : f.doers.some((d) => onMap.has(d)) ? "pass" : "fail",
    // Completed tasks: the final file / link given at completion, or a frame.io / OneDrive-type
    // link in the comments. The brief's own files and links don't count as the final asset.
    final_asset:
      f.status !== "completed"
        ? "na"
        : input.finalAsset || hasAllowedLink(input.linkTexts, settings.finalAssetDomains)
          ? "pass"
          : "fail",
  };

  const values = BRIEF_RULE_KEYS.map((k) => results[k]);
  const passed = values.filter((r) => r === "pass").length;
  const applicable = values.filter((r) => r !== "na").length;
  return {
    results,
    passed,
    applicable,
    score: applicable > 0 ? Math.round((passed / applicable) * 100) : null,
    failed: BRIEF_RULE_KEYS.filter((k) => results[k] === "fail"),
  };
}

/** Loads descriptions, file stats and link-bearing comments / notes for the given tasks. */
export async function loadBriefInputs(facts: TaskFact[]): Promise<BriefInput[]> {
  if (facts.length === 0) return [];
  const ids = facts.map((f) => new mongoose.Types.ObjectId(f.id));
  const wanted = new Set(facts.map((f) => f.id));
  // Descriptions by the createdAt index (cheaper than a 5,000-id $in).
  const since = new Date(Math.min(...facts.map((f) => f.createdAt.getTime())));
  const completedIds = facts.filter((f) => f.status === "completed").map((f) => new mongoose.Types.ObjectId(f.id));
  const linkFilter = { $regex: /https?:\/\/|www\./i };

  const [descriptions, files, comments, notes] = await Promise.all([
    Task.find({ createdAt: { $gte: since } }).select("description briefCheck finalFile").lean(),
    TaskFile.aggregate<{ _id: mongoose.Types.ObjectId; first: Date; count: number }>([
      { $match: { task: { $in: ids } } },
      { $group: { _id: "$task", first: { $min: "$createdAt" }, count: { $sum: 1 } } },
    ]),
    completedIds.length
      ? TaskComment.find({ task: { $in: completedIds }, body: linkFilter }).select("task body").lean()
      : Promise.resolve([]),
    completedIds.length
      ? TaskNote.find({ task: { $in: completedIds }, visibility: { $ne: "private" }, body: linkFilter })
          .select("task body")
          .lean()
      : Promise.resolve([]),
  ]);

  const description = new Map(
    descriptions.flatMap((d) => (wanted.has(String(d._id)) ? [[String(d._id), richTextToPlain(d.description)] as const] : []))
  );
  const verdicts = new Map(
    descriptions.flatMap((d) =>
      wanted.has(String(d._id)) && d.briefCheck
        ? [
            [
              String(d._id),
              { verdict: d.briefCheck.verdict, score: d.briefCheck.score ?? null, reason: d.briefCheck.reason ?? "" },
            ] as const,
          ]
        : []
    )
  );
  const finals = new Set(
    descriptions.flatMap((d) => (wanted.has(String(d._id)) && (d.finalFile?.url || d.finalFile?.fileId) ? [String(d._id)] : []))
  );
  const fileStats = new Map(files.map((f) => [String(f._id), f]));
  const linkTexts = new Map<string, string[]>();
  for (const row of [...comments, ...notes] as Array<{ task: mongoose.Types.ObjectId; body: string }>) {
    const key = String(row.task);
    const list = linkTexts.get(key);
    if (list) list.push(row.body);
    else linkTexts.set(key, [row.body]);
  }

  return facts.map((fact) => {
    const fs = fileStats.get(fact.id);
    return {
      fact,
      description: description.get(fact.id) ?? "",
      firstFileAt: fs?.first ?? null,
      fileCount: fs?.count ?? 0,
      finalAsset: finals.has(fact.id),
      linkTexts: linkTexts.get(fact.id) ?? [],
      ai: verdicts.get(fact.id) ?? null,
    };
  });
}
