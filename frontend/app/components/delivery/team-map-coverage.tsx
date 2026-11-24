import { Fragment, useState } from "react";
import { Link } from "react-router";
import { LuChevronDown, LuChevronRight, LuX } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import { userName } from "@/components/delivery/delivery-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryTeamMapResponse, DeliveryTeamMapRow, DeliveryTeamMapWeek, DeliveryUserRef } from "@/types";

// ---------------------------------------------------------------------------
// Team map coverage: per brand, the tasks allocated in the period, each checked against the
// manpower plan version live on the day it was allocated. A brand opens day by day or
// week by week, and a plan version opens its team (with roles) and its tasks.
// ---------------------------------------------------------------------------

const MAX_MAPPED = 8;

const monthShort = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const monthLong = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
/** "2026-10 v4" → "Oct v4"; null → "Team map". */
const versionShort = (v: string | null) => (v ? `${monthShort(v.slice(0, 7))} ${v.split(" ")[1]}` : "Team map");
const versionLong = (v: string | null) =>
  v ? `${monthLong(v.slice(0, 7))} · version ${v.split(" ")[1]!.slice(1)}` : "Brand team map (no plan for these tasks)";
const dayShort = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekLabel = (start: string) => {
  const end = new Date(new Date(`${start}T00:00:00Z`).getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  return `${dayShort(start)} – ${dayShort(end)}`;
};

type Counts = { on: number; off: number };
/** A week of a brand: its plan-version groups and per-person task counts. */
type Week = { start: string; groups: Array<{ group: DeliveryTeamMapWeek; index: number }>; tasks: number; inst: number; offInst: number | null; people: Map<string, Counts & { ref: DeliveryUserRef }>; planned: Map<string, DeliveryUserRef> };

/** A person's key (former users have no id). */
const keyOf = (person: DeliveryUserRef) => person.id ?? `former:${person.name}`;

function weeksOf(row: DeliveryTeamMapRow): Week[] {
  const weeks = new Map<string, Week>();
  row.weeks.forEach((group, index) => {
    const week: Week = weeks.get(group.weekStart) ?? { start: group.weekStart, groups: [], tasks: 0, inst: 0, offInst: null, people: new Map(), planned: new Map() };
    week.groups.push({ group, index });
    week.tasks += group.tasks;
    week.inst += group.instances;
    if (group.offMapInstances != null) week.offInst = (week.offInst ?? 0) + group.offMapInstances;
    for (const task of group.taskList) {
      for (const doer of task.doers) {
        const counts = week.people.get(keyOf(doer.person)) ?? { on: 0, off: 0, ref: doer.person };
        if (doer.onMap === false) counts.off++;
        else counts.on++;
        week.people.set(keyOf(doer.person), counts);
      }
    }
    for (const member of group.team) week.planned.set(keyOf(member.person), member.person);
    weeks.set(group.weekStart, week);
  });
  return [...weeks.values()];
}

const byCount = (a: [string, number, DeliveryUserRef], b: [string, number, DeliveryUserRef]) =>
  b[1] - a[1] || userName(a[2]).localeCompare(userName(b[2]));

function Chips({ items, tone }: { items: Array<{ person: DeliveryUserRef; count?: number }>; tone: "on" | "off" | "idle" }) {
  if (items.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map(({ person, count }) => (
        <span
          key={keyOf(person)}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap",
            tone === "on" && "bg-good/10 text-good",
            tone === "off" && "bg-critical/10 text-critical",
            tone === "idle" && "bg-muted text-muted-foreground",
          )}
        >
          {userName(person)}
          {count !== undefined && <b className="ml-1 tabular-nums">{count}</b>}
        </span>
      ))}
    </span>
  );
}

function VersionChip({ group, selected, onPick }: { group: DeliveryTeamMapWeek; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title="See who was on this plan version and the tasks counted against it"
      aria-pressed={selected}
      className={cn(
        "mt-1 mr-1 inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors",
        selected ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground",
      )}
    >
      {versionShort(group.version)}
      <span className={cn("ml-1 tabular-nums", selected ? "opacity-70" : "text-muted-foreground")}>· {group.tasks}</span>
      {/* Off-map % of this version in the week: off-plan people × tasks out of all people × tasks. */}
      {group.offMapInstances != null && group.instances > 0 && (
        <span
          className={cn(
            "ml-1 rounded px-1 tabular-nums",
            group.offMapInstances === 0 ? (selected ? "opacity-70" : "text-muted-foreground") : selected ? "bg-critical text-white" : "bg-critical/10 font-medium text-critical",
          )}
          title={`${group.offMapInstances} of ${group.instances} people × tasks done by someone not on this plan version`}
        >
          {offPct(group)}% off
        </span>
      )}
    </button>
  );
}

/** Off-map %: off-plan people × task instances out of all instances (whole %). */
function offPct(group: Pick<DeliveryTeamMapWeek, "instances" | "offMapInstances">): number {
  return group.instances > 0 ? Math.round(((group.offMapInstances ?? 0) / group.instances) * 100) : 0;
}

/** The picked plan version: who was on it for the brand (roles, used or not) and its tasks. */
function VersionDetail({ brand, group, onClose }: { brand: string; group: DeliveryTeamMapWeek; onClose: () => void }) {
  const used = group.team.filter((m) => m.worked).length;
  return (
    <div className="my-2 rounded-lg border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {brand} · {versionLong(group.version)}
          </p>
          <p className="text-xs text-muted-foreground">
            Live for {group.tasks} task{group.tasks === 1 ? "" : "s"} allocated {weekLabel(group.weekStart)} ·{" "}
            <span className={cn((group.offMapInstances ?? 0) > 0 && "font-medium text-critical")}>
              off-map {offPct(group)}% ({group.offMapInstances ?? 0} of {group.instances} people × tasks)
            </span>
            {group.lines.length > 0 && ` · plan line${group.lines.length > 1 ? "s" : ""}: ${group.lines.join(", ")}`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <LuX aria-hidden />
        </Button>
      </div>
      {group.version && group.team.length === 0 && (
        <p className="mt-2 rounded-md bg-critical/10 px-2 py-1 text-xs text-critical">
          {brand} had no line in this plan version, so nobody was planned on it and everyone who worked on these tasks counts as off plan.
        </p>
      )}
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(260px,1fr)_2fr]">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 font-medium">On the plan ({group.team.length})</th>
              <th className="py-1 pr-2 font-medium">Role</th>
              <th className="py-1 text-right font-medium">Used · {used}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {group.team.map((m) => (
              <tr key={keyOf(m.person)}>
                <td className="py-1 pr-2">{userName(m.person)}</td>
                <td className="py-1 pr-2 text-xs text-muted-foreground">{m.roles.join(" / ") || "—"}</td>
                <td className="py-1 text-right text-xs whitespace-nowrap">{m.worked ? <span className="font-semibold text-good">✓</span> : <span className="text-muted-foreground">not used</span>}</td>
              </tr>
            ))}
          </tbody>
          {/* Who worked on these tasks without being on this version of the plan. */}
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Off plan but working ({group.offMapWorking.length}) · tasks each did this week
                </p>
                <div className="mt-1">
                  {group.offMapWorking.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Nobody — every task was done by people on this version.</span>
                  ) : (
                    <Chips items={group.offMapWorking} tone="off" />
                  )}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Task</th>
                <th className="py-1 pr-2 font-medium">Allocated</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 font-medium">Done by</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {group.taskList.map((task) => (
                <tr key={task.id} className="align-top">
                  <td className="py-1 pr-2">
                    <Link to={`/tasks?task=${task.id}`} className="hover:underline">
                      {task.code && <span className="mr-1.5 rounded border px-1 font-mono text-[11px] text-muted-foreground">{task.code}</span>}
                      {task.title}
                    </Link>
                  </td>
                  <td className="py-1 pr-2 text-xs whitespace-nowrap text-muted-foreground">{dayShort(task.allocated)}</td>
                  <td className="py-1 pr-2 text-xs whitespace-nowrap text-muted-foreground">
                    {task.status === "completed" ? "Done" : task.status === "todo" ? "To do" : task.status.replace(/_/g, " ")}
                  </td>
                  <td className="py-1">
                    {/* One list: green = on the plan for this task, red = not. */}
                    {task.doers.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {task.doers.map((d) => (
                          <span
                            key={keyOf(d.person)}
                            title={d.onMap === false ? "Not on the plan line for this task" : undefined}
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap",
                              d.onMap === false ? "bg-critical/10 text-critical" : "bg-good/10 text-good",
                            )}
                          >
                            {userName(d.person)}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ByWeek({ row, weeks, picked, onPick }: { row: DeliveryTeamMapRow; weeks: Week[]; picked: number | null; onPick: (index: number | null) => void }) {
  return (
    <table className="w-full min-w-[1000px] text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-2 py-1.5">
            Week (allocated)
            <span className="block text-[11px] font-normal tracking-normal normal-case">click a plan version for its team and tasks</span>
          </th>
          <th className="px-2 py-1.5 text-right">Tasks</th>
          <th className="px-2 py-1.5" title="Off-plan people × tasks out of all people × tasks in the week">Off-map %</th>
          <th className="px-2 py-1.5">On plan &amp; working</th>
          <th className="px-2 py-1.5">Off plan but working</th>
          <th className="px-2 py-1.5">Planned but not used</th>
        </tr>
      </thead>
      <tbody className="divide-y align-top">
        {weeks.map((week) => {
          const people = [...week.people].map(([id, c]) => [id, c, c.ref] as const);
          const on = people.filter(([, c]) => c.on > 0).map(([id, c, ref]) => [id, c.on, ref] as [string, number, DeliveryUserRef]).sort(byCount);
          const off = people.filter(([, c]) => c.off > 0).map(([id, c, ref]) => [id, c.off, ref] as [string, number, DeliveryUserRef]).sort(byCount);
          const idle = [...week.planned].filter(([id]) => !week.people.has(id)).map(([, ref]) => ref).sort((a, b) => userName(a).localeCompare(userName(b)));
          const pickedHere = week.groups.find((g) => g.index === picked);
          return (
            <Fragment key={week.start}>
              <tr>
                <td className="min-w-56 px-2 py-2">
                  <span className="font-medium">{weekLabel(week.start)}</span>
                  <div>
                    {week.groups.map(({ group, index }) => (
                      <VersionChip key={index} group={group} selected={picked === index} onPick={() => onPick(picked === index ? null : index)} />
                    ))}
                  </div>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{week.tasks}</td>
                <td className="px-2 py-2">
                  <OffMapPill off={week.offInst} all={week.inst} />
                </td>
                <td className="px-2 py-2">
                  <Chips items={on.map(([, count, person]) => ({ person, count }))} tone="on" />
                </td>
                <td className="px-2 py-2">
                  <Chips items={off.map(([, count, person]) => ({ person, count }))} tone="off" />
                </td>
                <td className="px-2 py-2">
                  <Chips items={idle.map((person) => ({ person }))} tone="idle" />
                </td>
              </tr>
              {pickedHere && (
                <tr>
                  <td colSpan={6} className="px-2">
                    <VersionDetail brand={row.brand.name} group={pickedHere.group} onClose={() => onPick(null)} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Day by day: every day of the period that had tasks allocated, per plan version live that day —
 * its off-map % (off-plan people × tasks out of all people × tasks) and who was on / off the plan.
 */
function ByDay({ row, picked, onPick }: { row: DeliveryTeamMapRow; picked: number | null; onPick: (index: number | null) => void }) {
  type DayGroup = { day: string; index: number; group: DeliveryTeamMapWeek; tasks: number; inst: number; off: number | null; people: Map<string, Counts & { ref: DeliveryUserRef }> };
  const groups = new Map<string, DayGroup>();
  row.weeks.forEach((group, index) => {
    for (const task of group.taskList) {
      const key = `${task.allocated}|${index}`;
      const g = groups.get(key) ?? { day: task.allocated, index, group, tasks: 0, inst: 0, off: null, people: new Map() };
      g.tasks++;
      for (const doer of task.doers) {
        const counts = g.people.get(keyOf(doer.person)) ?? { on: 0, off: 0, ref: doer.person };
        if (doer.onMap === false) counts.off++;
        else counts.on++;
        g.people.set(keyOf(doer.person), counts);
        // Tasks without a map (onMap null) don't count in the %.
        if (doer.onMap !== null) {
          g.inst++;
          g.off = (g.off ?? 0) + (doer.onMap ? 0 : 1);
        }
      }
      groups.set(key, g);
    }
  });
  const list = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
  // The day's own % (all its versions together), for the average of the daily figures.
  const days = new Map<string, { inst: number; off: number }>();
  for (const g of list) {
    if (g.off === null) continue;
    const d = days.get(g.day) ?? { inst: 0, off: 0 };
    d.inst += g.inst;
    d.off += g.off;
    days.set(g.day, d);
  }
  const daily = [...days.values()].filter((d) => d.inst > 0).map((d) => (d.off / d.inst) * 100);
  const average = daily.length ? Math.round(daily.reduce((n, p) => n + p, 0) / daily.length) : null;
  const dayLabel = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const pickedGroup = picked !== null ? row.weeks[picked] : undefined;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {new Set(list.map((g) => g.day)).size} days with tasks allocated in the period (days without tasks aren&apos;t listed) · off-map over the period{" "}
        <span className="font-medium text-foreground">{row.offMapPct ?? 0}%</span> ({row.offMapInstances ?? 0} of {row.instances ?? 0} people × tasks)
        {average !== null && (
          <>
            {" "}· average of the daily off-map % <span className="font-medium text-foreground">{average}%</span> ({daily.length} days)
          </>
        )}
      </p>
      <table className="w-full min-w-[900px] text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5">Day (allocated)</th>
            <th className="px-2 py-1.5">Plan version that day</th>
            <th className="px-2 py-1.5 text-right">Tasks</th>
            <th className="px-2 py-1.5" title="Off-plan people × tasks out of all people × tasks that day, on that plan version">Off-map %</th>
            <th className="px-2 py-1.5">On plan &amp; working</th>
            <th className="px-2 py-1.5">Off plan but working</th>
          </tr>
        </thead>
        <tbody className="divide-y align-top">
          {list.map((g, i) => {
            const people = [...g.people.values()];
            const on = people.filter((c) => c.on > 0).map((c) => ({ person: c.ref, count: c.on })).sort((a, b) => b.count - a.count);
            const off = people.filter((c) => c.off > 0).map((c) => ({ person: c.ref, count: c.off })).sort((a, b) => b.count - a.count);
            const firstOfDay = i === 0 || list[i - 1]!.day !== g.day;
            const selected = picked === g.index;
            return (
              <tr key={`${g.day}|${g.index}`}>
                <td className="px-2 py-2 font-medium whitespace-nowrap">{firstOfDay ? dayLabel(g.day) : ""}</td>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onPick(selected ? null : g.index)}
                    aria-pressed={selected}
                    title="See who was on this plan version and the tasks counted against it"
                    className={cn(
                      "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors",
                      selected ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground",
                    )}
                  >
                    {versionShort(g.group.version)}
                  </button>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{g.tasks}</td>
                <td className="px-2 py-2">
                  <OffMapPill off={g.off} all={g.inst} />
                </td>
                <td className="px-2 py-2">
                  <Chips items={on} tone="on" />
                </td>
                <td className="px-2 py-2">
                  <Chips items={off} tone="off" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pickedGroup && <VersionDetail brand={row.brand.name} group={pickedGroup} onClose={() => onPick(null)} />}
    </div>
  );
}

/** The off-map %: off-plan people × tasks out of all people × tasks ("25% · 8 of 32"). */
function OffMapPill({ off, all }: { off: number | null; all: number }) {
  if (off === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums", off === 0 ? "bg-muted text-muted-foreground" : "bg-critical/10 text-critical")}
      title={`${off} of ${all} people × tasks were done by someone not on the plan version live when the task was allocated`}
    >
      {all > 0 ? Math.round((off / all) * 100) : 0}% <span className="ml-1 font-normal opacity-80">· {off} of {all}</span>
    </span>
  );
}

function BrandWeeks({ row }: { row: DeliveryTeamMapRow }) {
  const [view, setView] = useState<"day" | "week">("day");
  const [picked, setPicked] = useState<number | null>(null);
  const weeks = weeksOf(row);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="View">
          {(
            [
              ["day", "By day"],
              ["week", "By week"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={cn("px-3 py-1 text-xs", view === value ? "bg-foreground text-background" : "bg-background hover:bg-muted")}
            >
              {label}
            </button>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">Click a plan version (e.g. {versionShort(row.weeks[0]?.version ?? null)}) to see who was on it and the tasks counted against it.</span>
      </div>
      <div className="overflow-x-auto">
        {view === "day" ? (
          <ByDay row={row} picked={picked} onPick={setPicked} />
        ) : (
          <ByWeek row={row} weeks={weeks} picked={picked} onPick={setPicked} />
        )}
      </div>
    </div>
  );
}

export function TeamMapCoverage({ data }: { data: DeliveryTeamMapResponse }) {
  const [search, setSearch] = useState("");
  const [offMapOnly, setOffMapOnly] = useState(false);
  const [source, setSource] = useState<"all" | "plan" | "map">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = search.trim().toLowerCase();
  const rows = data.rows.filter(
    (r) =>
      (!q || r.brand.name.toLowerCase().includes(q)) &&
      (!offMapOnly || (r.offMapInstances ?? 0) > 0) &&
      (source === "all" || (source === "plan" ? r.planVersions.length > 0 : r.planVersions.length === 0)),
  );
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search brands…" aria-label="Search brands" className="h-8 w-56" />
        <div className="flex items-center gap-2">
          <Switch id="team-map-offmap" checked={offMapOnly} onCheckedChange={setOffMapOnly} />
          <Label htmlFor="team-map-offmap" className="text-sm">
            Only brands with off-map tasks
          </Label>
        </div>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Map source">
          {(
            [
              ["all", "All"],
              ["plan", "Manpower plan"],
              ["map", "Team map only"],
            ] as const
          ).map(([value, label]) => (
            <Button key={value} size="sm" variant={source === value ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setSource(value)}>
              {label}
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} of {data.rows.length} brands · {data.totals.tasks} tasks · off-map {data.totals.offMapPct ?? 0}% ({data.totals.offMapInstances} of {data.totals.instances} people × tasks) ·{" "}
          {formatDateOnly(data.range.start)} – {formatDateOnly(data.range.end)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {data.rows.length === 0 ? "No brand with an active project had tasks allocated in this period." : "No brands match the filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2 text-right">Tasks in period</th>
                <th className="px-3 py-2" title="Off-plan people × tasks out of all people × tasks in the period">Off-map %</th>
                <th className="px-3 py-2">On plan and working it</th>
                <th className="px-3 py-2">Off plan but working it</th>
                <th className="px-3 py-2">Planned but unused</th>
              </tr>
            </thead>
            <tbody className="divide-y align-top">
              {rows.map((row) => {
                const isOpen = open.has(row.brand.id);
                const versions = row.planVersions.length;
                return (
                  <Fragment key={row.brand.id}>
                    <tr className="cursor-pointer hover:bg-muted/30" onClick={() => toggle(row.brand.id)} aria-expanded={isOpen}>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1">
                          {isOpen ? <LuChevronDown aria-hidden className="size-4 text-muted-foreground" /> : <LuChevronRight aria-hidden className="size-4 text-muted-foreground" />}
                          <BrandName name={row.brand.name} color={row.brand.color} noBrand={row.brand.noBrand} className="font-medium" />
                        </span>
                        <p className="mt-0.5 ml-5 max-w-60 text-xs text-muted-foreground" title={row.mapped.map(userName).join(", ")}>
                          {row.mapped.length === 0
                            ? "No team map"
                            : `${row.mapped.slice(0, MAX_MAPPED).map(userName).join(", ")}${row.mapped.length > MAX_MAPPED ? ` +${row.mapped.length - MAX_MAPPED} more` : ""}`}
                          {row.derived && row.mapped.length > 0 && " · from projects"}
                        </p>
                        <p className="mt-0.5 ml-5 text-xs text-muted-foreground">
                          {versions > 0 ? `${versions} plan version${versions === 1 ? "" : "s"} · ` : "Team map · "}
                          {isOpen ? "hide weeks" : "show week by week"}
                        </p>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.tasks}</td>
                      <td className="px-3 py-2">
                        <OffMapPill off={row.offMapInstances} all={row.instances ?? 0} />
                      </td>
                      <td className="px-3 py-2">
                        <Chips items={row.onMapWorking} tone="on" />
                      </td>
                      <td className="px-3 py-2">
                        <Chips items={row.offMapWorking} tone="off" />
                      </td>
                      <td className="px-3 py-2">
                        <Chips items={row.mappedUnused.map((person) => ({ person }))} tone="idle" />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} className="bg-muted/20 px-3 py-3 pl-8">
                          <BrandWeeks row={row} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
