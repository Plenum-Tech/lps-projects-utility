import { useMemo, useState } from "react";
import { LuCalendarOff, LuTriangleAlert } from "react-icons/lu";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ManpowerPlanResponse, ManpowerRoleDef } from "@/types";

/**
 * Each person's allocation in the month: lines and roles, over-allocation
 * (more lines than the plan's limit), approved leave in the month, and the
 * people with nothing planned (available).
 */
export function PeopleView({
  data,
  roles,
  onHighlight,
}: {
  data: ManpowerPlanResponse;
  roles: ManpowerRoleDef[];
  onHighlight: (userId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const roleLabel = useMemo(() => new Map(roles.map((r) => [r.key, r.label])), [roles]);
  const q = search.trim().toLowerCase();
  const people = data.people.filter((p) => !q || p.user.name.toLowerCase().includes(q));
  const available = data.available.filter((p) => !q || p.name.toLowerCase().includes(q));
  const over = data.people.filter((p) => p.overAllocated).length;
  const onLeave = data.people.filter((p) => p.leaveDays > 0).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {data.people.length} people planned · {over} over the limit of {data.plan.maxProjectsPerPerson} lines · {onLeave} with leave
          this month · {data.available.length} not on the plan
        </p>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people…"
          className="h-8 w-56"
          aria-label="Search people"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Person</th>
              <th className="px-3 py-2 text-right font-medium">Lines</th>
              <th className="px-3 py-2 text-right font-medium">Pitches</th>
              <th className="px-3 py-2 font-medium">Allocation</th>
              <th className="px-3 py-2 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.user._id} className="border-t align-top">
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onHighlight(p.user._id)}
                    className="text-left font-medium text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    title="Highlight on the plan"
                  >
                    {p.user.name}
                  </button>
                  {p.user.designation && <p className="text-xs text-muted-foreground">{p.user.designation}</p>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.activeRows}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{p.pitchRows}</td>
                <td className="px-3 py-2">
                  <ul className="space-y-0.5">
                    {p.rows.map((r) => (
                      <li key={r.key} className="text-xs">
                        <span className={r.section === "pitch" ? "text-muted-foreground" : "text-foreground"}>
                          {r.name}
                          {r.section === "pitch" && " (pitch)"}
                        </span>{" "}
                        <span className="text-muted-foreground">— {r.roles.map((k) => roleLabel.get(k) ?? k).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {p.overAllocated && (
                      <Badge variant="destructive" className="gap-1">
                        <LuTriangleAlert aria-hidden className="size-3" />
                        Over-allocated
                      </Badge>
                    )}
                    {p.leaveDays > 0 && (
                      <Badge variant="outline" className="gap-1">
                        <LuCalendarOff aria-hidden className="size-3" />
                        Leave {p.leaveDays} day{p.leaveDays === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {people.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  No one matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Not on the plan ({available.length})</h3>
        <p className="text-xs text-muted-foreground">Available this month. Admins aren&apos;t listed.</p>
        <div className="flex flex-wrap gap-1.5">
          {available.map((p) => (
            <Badge key={p._id} variant="secondary" className="font-normal" title={p.designation || undefined}>
              {p.name}
              {p.leaveDays > 0 && ` · leave ${p.leaveDays}d`}
            </Badge>
          ))}
        </div>
      </section>
    </div>
  );
}
