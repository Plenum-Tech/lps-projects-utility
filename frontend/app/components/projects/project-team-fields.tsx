import { LuSparkles } from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { OptionSelect } from "@/components/projects/project-fields";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useManpowerMonths, useManpowerRows, useManpowerTeamSuggestion } from "@/hooks/use-manpower";
import { MANPOWER_ROLE_FALLBACK, TEAM_OTHERS } from "@/lib/manpower";
import { namingMonthLabel } from "@/lib/projects";

export type TeamValue = Record<string, string[]>;

/** "Manpower plan line" picker value for "use the automatic match". */
export const AUTO_ROW = "auto";

/** Project team ↔ the API shape ([{ role, users }], empty roles dropped). */
export function teamToInput(team: TeamValue): Array<{ role: string; users: string[] }> {
  return Object.entries(team)
    .filter(([, users]) => users.length > 0)
    .map(([role, users]) => ({ role, users }));
}

export function teamFromProject(team: Array<{ role: string; users: Array<{ _id: string }> }> | undefined): TeamValue {
  const out: TeamValue = {};
  for (const entry of team ?? []) out[entry.role] = entry.users.map((u) => u._id);
  return out;
}

export function sameTeam(a: TeamValue, b: TeamValue): boolean {
  const norm = (t: TeamValue) =>
    JSON.stringify(
      Object.entries(t)
        .filter(([, u]) => u.length)
        .map(([r, u]) => [r, [...u].sort()])
        .sort(),
    );
  return norm(a) === norm(b);
}

/**
 * The project's team step: the manpower plan's roles plus "Others". When the
 * project's brand + month (+ type + name) match a line of that month's plan,
 * "Fill from manpower plan" copies its people in.
 */
export function ProjectTeamFields({
  value,
  onChange,
  options,
  loading,
  naming,
  enabled,
  planRow,
  onPlanRowChange,
}: {
  value: TeamValue;
  onChange: (value: TeamValue) => void;
  options: MultiSelectOption[];
  loading: boolean;
  naming: { brand: string; month: string; type: string; title: string };
  enabled: boolean;
  /** Manpower plan line chosen for the project (AUTO_ROW = automatic match). */
  planRow: string;
  onPlanRowChange: (key: string) => void;
}) {
  const months = useManpowerMonths(enabled);
  const roles = [...(months.data?.roles ?? MANPOWER_ROLE_FALLBACK), TEAM_OTHERS];
  const planRows = useManpowerRows(naming.month, enabled);
  const rows = planRows.data?.rows ?? [];
  const chosen = planRow !== AUTO_ROW && rows.some((r) => r.key === planRow) ? planRow : "";
  const auto = useManpowerTeamSuggestion(naming, enabled);
  const picked = useManpowerTeamSuggestion({ ...naming, row: chosen }, enabled && Boolean(chosen));
  const suggestion = chosen ? picked : auto;
  const row = suggestion.data?.row ?? null;
  // The project's brand first, then the rest of the month's plan.
  const rowOptions = [
    {
      value: AUTO_ROW,
      label: auto.data?.row ? `Automatic: ${auto.data.row.name}` : "Automatic (no matching line)",
    },
    ...[...rows]
      .sort((a, b) => Number(b.brand?._id === naming.brand) - Number(a.brand?._id === naming.brand))
      .map((r) => ({
        value: r.key,
        label: r.name,
        description: [r.brand?.name ?? "No brand", r.type].filter(Boolean).join(" · "),
      })),
  ];
  const known = new Set(options.map((o) => o.value));

  function fillFromPlan() {
    const next: TeamValue = { ...value };
    for (const entry of suggestion.data?.team ?? []) {
      const ids = entry.users.map((u) => u._id).filter((id) => known.has(id));
      next[entry.role] = [...new Set([...(next[entry.role] ?? []), ...ids])];
    }
    onChange(next);
  }

  return (
    <fieldset className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <legend className="text-sm font-medium text-foreground">Team</legend>
          <p className="text-xs text-muted-foreground">
            Same roles as the manpower plan. Everyone on the team is added as a project member.
          </p>
        </div>
        {row && (
          <Button type="button" variant="outline" size="sm" onClick={fillFromPlan} title={`Plan line: ${row.name}`}>
            <LuSparkles aria-hidden />
            Fill from manpower plan
          </Button>
        )}
      </div>
      {rows.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="project-plan-row" className="text-xs">
            Manpower plan line ({namingMonthLabel(naming.month)})
          </Label>
          <OptionSelect id="project-plan-row" value={chosen || AUTO_ROW} onChange={onPlanRowChange} options={rowOptions} />
          <p className="text-xs text-muted-foreground">
            Links this project to its brand line in the plan (used by Delivery Pulse on-map / off-map).
          </p>
          {!row && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              No line matched automatically: pick this brand&apos;s line above to fill the team from the plan, or add people
              to each role below.
            </p>
          )}
          {row && (suggestion.data?.team.length ?? 0) === 0 && (
            <p className="text-xs text-muted-foreground">“{row.name}” has nobody planned yet: add people to each role below.</p>
          )}
        </div>
      ) : (
        naming.month && (
          <p className="text-xs text-muted-foreground">No manpower plan for {namingMonthLabel(naming.month)} yet.</p>
        )
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {roles.map((role) => (
          <div key={role.key} className={role.key === TEAM_OTHERS.key ? "space-y-1 sm:col-span-2" : "space-y-1"}>
            <Label htmlFor={`team-${role.key}`} className="text-xs">
              {role.label}
            </Label>
            <MultiSelect
              id={`team-${role.key}`}
              options={options}
              value={value[role.key] ?? []}
              onValueChange={(ids) => onChange({ ...value, [role.key]: ids })}
              placeholder={loading ? "Loading people…" : "Add people…"}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}
