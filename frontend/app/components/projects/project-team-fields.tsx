import { LuSparkles } from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useManpowerMonths, useManpowerTeamSuggestion } from "@/hooks/use-manpower";
import { MANPOWER_ROLE_FALLBACK, TEAM_OTHERS } from "@/lib/manpower";
import { namingMonthLabel } from "@/lib/projects";

export type TeamValue = Record<string, string[]>;

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
}: {
  value: TeamValue;
  onChange: (value: TeamValue) => void;
  options: MultiSelectOption[];
  loading: boolean;
  naming: { brand: string; month: string; type: string; title: string };
  enabled: boolean;
}) {
  const months = useManpowerMonths(enabled);
  const roles = [...(months.data?.roles ?? MANPOWER_ROLE_FALLBACK), TEAM_OTHERS];
  const suggestion = useManpowerTeamSuggestion(naming, enabled);
  const row = suggestion.data?.row ?? null;
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
      {row && (
        <p className="text-xs text-muted-foreground">
          Matches “{row.name}” in the {namingMonthLabel(row.month)} plan (version {row.version}).
        </p>
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
