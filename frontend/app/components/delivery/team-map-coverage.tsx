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
// manpower plan version live on the day it was allocated. A brand opens week by week — by week
// or as a people × weeks grid — and a plan version opens its team (with roles) and its tasks.
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
type Week = { start: string; groups: Array<{ group: DeliveryTeamMapWeek; index: number }>; tasks: number; offMap: number; people: Map<string, Counts & { ref: DeliveryUserRef }>; planned: Map<string, DeliveryUserRef> };

/** A person's key (former users have no id). */
const keyOf = (person: DeliveryUserRef) => person.id ?? `former:${person.name}`;

function weeksOf(row: DeliveryTeamMapRow): Week[] {
  const weeks = new Map<string, Week>();
  row.weeks.forEach((group, index) => {
    const week: Week = weeks.get(group.weekStart) ?? { start: group.weekStart, groups: [], tasks: 0, offMap: 0, people: new Map(), planned: new Map() };
    week.groups.push({ group, index });
    week.tasks += group.tasks;
    week.offMap += group.offMapTasks ?? 0;
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
    </button>
  );
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
            Live for {group.tasks} task{group.tasks === 1 ? "" : "s"} allocated {weekLabel(group.weekStart)} · {group.offMapTasks ?? 0} off-map
            {group.lines.length > 0 && ` · plan line${group.lines.length > 1 ? "s" : ""}: ${group.lines.join(", ")}`}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <LuX aria-hidden />
        </Button>
      </div>
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
                <td className="py-1 text-right text-xs">{m.worked ? <span className="font-semibold text-good">✓</span> : <span className="text-muted-foreground">not used</span>}</td>
              </tr>
            ))}
          </tbody>
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
                    <Chips items={task.doers.filter((d) => d.onMap !== false).map((d) => ({ person: d.person }))} tone="on" />
                    {task.doers.some((d) => d.onMap === false) && (
                      <Chips items={task.doers.filter((d) => d.onMap === false).map((d) => ({ person: d.person }))} tone="off" />
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
          <th className="px-2 py-1.5">Off-map</th>
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
                  <OffMapPill offMap={week.offMap} tasks={week.tasks} />
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

function PeopleGrid({ row, weeks, picked, onPick }: { row: DeliveryTeamMapRow; weeks: Week[]; picked: number | null; onPick: (index: number | null) => void }) {
  const people = new Map<string, { ref: DeliveryUserRef; cells: Array<(Counts & { planned?: boolean }) | null> }>();
  weeks.forEach((week, i) => {
    for (const [id, c] of week.people) {
      const p = people.get(id) ?? { ref: c.ref, cells: weeks.map(() => null) };
      p.cells[i] = { on: c.on, off: c.off };
      people.set(id, p);
    }
    for (const [id, ref] of week.planned) {
      const p = people.get(id) ?? { ref, cells: weeks.map(() => null) };
      p.cells[i] ??= { on: 0, off: 0, planned: true };
      people.set(id, p);
    }
  });
  const total = (cells: Array<Counts | null>) => cells.reduce((n, c) => n + (c ? c.on + c.off : 0), 0);
  const order = [...people.values()].sort((a, b) => total(b.cells) - total(a.cells) || userName(a.ref).localeCompare(userName(b.ref)));
  const pickedGroup = row.weeks[picked ?? -1];
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="align-bottom">
              <th className="px-2 py-1.5 uppercase tracking-wide">Team member</th>
              {weeks.map((week) => (
                <th key={week.start} className="min-w-40 px-2 py-1.5 text-center font-normal">
                  <span className="font-medium text-foreground">{weekLabel(week.start)}</span>
                  <span className="block text-[11px]">
                    {week.tasks} tasks · {week.offMap} off-map
                  </span>
                  <div>
                    {week.groups.map(({ group, index }) => (
                      <VersionChip key={index} group={group} selected={picked === index} onPick={() => onPick(picked === index ? null : index)} />
                    ))}
                  </div>
                </th>
              ))}
              <th className="px-2 py-1.5 text-right uppercase tracking-wide">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {order.map(({ ref, cells }) => (
              <tr key={keyOf(ref)}>
                <td className="px-2 py-1.5 font-medium whitespace-nowrap">{userName(ref)}</td>
                {cells.map((c, i) => (
                  <td key={i} className="px-2 py-1.5 text-center">
                    {!c ? (
                      <span className="text-muted-foreground">·</span>
                    ) : c.on + c.off === 0 ? (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">planned · 0</span>
                    ) : (
                      <span className="inline-flex gap-1">
                        {c.on > 0 && <span title="Tasks on the plan" className="min-w-6 rounded-md bg-good/15 px-1.5 py-0.5 text-xs font-semibold text-good tabular-nums">{c.on}</span>}
                        {c.off > 0 && <span title="Tasks not on the plan for them" className="min-w-6 rounded-md bg-critical/15 px-1.5 py-0.5 text-xs font-semibold text-critical tabular-nums">{c.off}</span>}
                      </span>
                    )}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{total(cells)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pickedGroup && <VersionDetail brand={row.brand.name} group={pickedGroup} onClose={() => onPick(null)} />}
    </>
  );
}

function OffMapPill({ offMap, tasks }: { offMap: number | null; tasks: number }) {
  if (offMap === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums", offMap === 0 ? "bg-muted text-muted-foreground" : "bg-critical/10 text-critical")}>
      {offMap} · {tasks > 0 ? Math.round((offMap / tasks) * 100) : 0}%
    </span>
  );
}

function BrandWeeks({ row }: { row: DeliveryTeamMapRow }) {
  const [view, setView] = useState<"week" | "grid">("week");
  const [picked, setPicked] = useState<number | null>(null);
  const weeks = weeksOf(row);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="View">
          {(
            [
              ["week", "By week"],
              ["grid", "People × weeks"],
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
        {view === "week" ? <ByWeek row={row} weeks={weeks} picked={picked} onPick={setPicked} /> : <PeopleGrid row={row} weeks={weeks} picked={picked} onPick={setPicked} />}
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
      (!offMapOnly || (r.offMapTasks ?? 0) > 0) &&
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
          {rows.length} of {data.rows.length} brands · {data.totals.tasks} tasks · {data.totals.offMapTasks} off map ·{" "}
          {formatDateOnly(data.range.start)} – {formatDateOnly(data.range.end)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {data.rows.length === 0 ? "No brand had tasks allocated in this period." : "No brands match the filters."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2 text-right">Tasks in period</th>
                <th className="px-3 py-2">Off-map tasks</th>
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
                        <OffMapPill offMap={row.offMapTasks} tasks={row.tasks} />
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
