import mongoose from "mongoose";
import { Task } from "../../models/Task.js";
import { TaskComment } from "../../models/TaskComment.js";
import { TaskFile } from "../../models/TaskFile.js";
import { TaskNote } from "../../models/TaskNote.js";
import { weekdayOf } from "./days.js";
import type { TaskFact } from "./facts.js";
import type { DeliverySettingsSnapshot } from "./settings.js";

// ---------------------------------------------------------------------------
// Brief score: 7 rules per task (prompts/delivery-pulse.md, "Brief score").
// A rule is "pass", "fail" or "na"; score = passed ÷ applicable.
// ---------------------------------------------------------------------------

export const BRIEF_RULES = [
  { id: 1, key: "attached", label: "Brief attached (deck, doc or link)" },
  { id: 2, key: "written", label: "Written brief" },
  { id: 3, key: "weekday", label: "Briefed on the briefing weekday" },
  { id: 4, key: "leadTime", label: "Minimum lead time" },
  { id: 5, key: "noSameDay", label: "No same-day delivery" },
  { id: 6, key: "teamMap", label: "Doer on the brand team map" },
  { id: 7, key: "finalAsset", label: "Final asset attached" },
] as const;

export type RuleResult = "pass" | "fail" | "na";

/** http(s):// or www. links in free text. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;
const DAY_MS = 86_400_000;

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
  /** Bodies of comments and non-private notes (only those containing a link are needed). */
  linkTexts: string[];
  /** Stored AI verdict on the description (null = not checked). */
  ai: { verdict: "ok" | "weak" | "flagged"; reason: string } | null;
}

export interface BriefScore {
  results: RuleResult[];
  passed: number;
  applicable: number;
  /** passed ÷ applicable (0–1), null when no rule applies. */
  score: number | null;
  failed: number[];
}

export function scoreBrief(input: BriefInput, settings: DeliverySettingsSnapshot): BriefScore {
  const f = input.fact;
  const urls = findUrls(input.description);
  const mapEntry = f.brand ? settings.brandTeamMap.find((e) => e.brand === f.brand && e.users.length > 0) : undefined;

  const results: RuleResult[] = [
    // 1 — a file within 24 h of creation, or a link in the description.
    (input.firstFileAt !== null && input.firstFileAt.getTime() <= f.createdAt.getTime() + DAY_MS) || urls.length > 0
      ? "pass"
      : "fail",
    // 2 — written description (minus links) of at least the minimum length.
    writtenText(input.description).length >= settings.briefMinLength ? "pass" : "fail",
    // 3 — created on the briefing weekday (app timezone).
    weekdayOf(f.createdDay) === settings.briefingWeekday ? "pass" : "fail",
    // 4 — due − created ≥ minimum lead days.
    f.dueDay === null ? "na" : f.dueDay - f.createdDay >= settings.minLeadDays ? "pass" : "fail",
    // 5 — not due on the creation date, unless the brand allows same-day delivery.
    f.dueDay === null
      ? "na"
      : f.dueDay !== f.createdDay || (f.brand !== null && settings.sameDayBrands.includes(f.brand))
        ? "pass"
        : "fail",
    // 6 — every doer on the brand's team map (n/a without a map).
    !mapEntry ? "na" : f.doers.every((d) => mapEntry.users.includes(d)) ? "pass" : "fail",
    // 7 — completed tasks: a file, or an allowed-domain link in the description / comments / notes.
    f.status !== "completed"
      ? "na"
      : input.fileCount > 0 || hasAllowedLink([input.description, ...input.linkTexts], settings.finalAssetDomains)
        ? "pass"
        : "fail",
  ];

  const passed = results.filter((r) => r === "pass").length;
  const applicable = results.filter((r) => r !== "na").length;
  return {
    results,
    passed,
    applicable,
    score: applicable > 0 ? passed / applicable : null,
    failed: results.flatMap((r, i) => (r === "fail" ? [i + 1] : [])),
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
    Task.find({ createdAt: { $gte: since } }).select("description briefCheck").lean(),
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
    descriptions.flatMap((d) => (wanted.has(String(d._id)) ? [[String(d._id), d.description ?? ""] as const] : []))
  );
  const verdicts = new Map(
    descriptions.flatMap((d) =>
      wanted.has(String(d._id)) && d.briefCheck
        ? [[String(d._id), { verdict: d.briefCheck.verdict, reason: d.briefCheck.reason ?? "" }] as const]
        : []
    )
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
      linkTexts: linkTexts.get(fact.id) ?? [],
      ai: verdicts.get(fact.id) ?? null,
    };
  });
}
