import { useEffect, useMemo, useState } from "react";
import { LuArrowDown, LuArrowUp, LuPlus, LuTrash2 } from "react-icons/lu";

import { MultiSelect } from "@/components/globals/multi-select";
import { QueryError } from "@/components/globals/query-states";
import { SettingsFormCard, SettingsFormSkeleton } from "@/components/settings/settings-form-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useScopeUnitSettings, useUpdateScopeUnits } from "@/hooks/use-scope-units";

const NAME_MAX = 30;

type Draft = { key?: string; name: string; roles: string[]; countsTowardTotal: boolean; hidden: boolean; rowCount: number; aliases: string[] };

/**
 * Settings → Scope units: the units offered in brand / project scope rows, the manpower
 * role(s) that deliver each (scope → who delivers it), and whether a unit counts toward the
 * agreement total. A unit used by scope rows can't be removed — hide it (its rows keep it).
 */
export function ScopeUnitsSection() {
  const query = useScopeUnitSettings();
  const update = useUpdateScopeUnits();
  const source = useMemo<Draft[] | undefined>(
    () => query.data?.units.map((u) => ({ key: u.key, name: u.name, roles: u.roles, countsTowardTotal: u.countsTowardTotal, hidden: u.hidden, rowCount: u.rowCount, aliases: u.aliases })),
    [query.data],
  );
  const [draft, setDraft] = useState<Draft[]>([]);
  useEffect(() => setDraft(source ?? []), [source]);

  if (query.isPending) return <SettingsFormSkeleton rows={6} />;
  if (query.isError) return <QueryError title="Couldn't load scope units" error={query.error} onRetry={() => void query.refetch()} />;

  const strip = (list: Draft[]) => JSON.stringify(list.map(({ key, name, roles, countsTowardTotal, hidden }) => ({ key, name: name.trim(), roles, countsTowardTotal, hidden })));
  const dirty = strip(draft) !== strip(source ?? []);
  const roleOptions = query.data.roles.map((r) => ({ value: r.key, label: r.label }));

  const names = draft.map((u) => u.name.trim().toLowerCase());
  const errorOf = (u: Draft, i: number) =>
    !u.name.trim() ? "Enter a name" : names.indexOf(u.name.trim().toLowerCase()) !== i ? "Listed twice" : null;
  const invalid = draft.some((u, i) => errorOf(u, i)) || draft.every((u) => u.hidden);

  const set = (i: number, patch: Partial<Draft>) => setDraft((list) => list.map((u, j) => (j === i ? { ...u, ...patch } : u)));
  const move = (i: number, delta: number) =>
    setDraft((list) => {
      const next = [...list];
      const [item] = next.splice(i, 1);
      next.splice(i + delta, 0, item!);
      return next;
    });

  return (
    <SettingsFormCard
      title="Scope units"
      description="The units offered in brand and project scope rows, in this order. The delivering role maps a scope row to the manpower plan; hidden units aren't offered for new rows but existing rows keep them."
      dirty={dirty}
      pending={update.isPending}
      onReset={() => setDraft(source ?? [])}
      onSubmit={() => {
        if (invalid) return;
        update.mutate(draft.map(({ key, name, roles, countsTowardTotal, hidden }) => ({ ...(key ? { key } : {}), name: name.trim(), roles, countsTowardTotal, hidden })));
      }}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-1.5 pr-2 font-medium">Order</th>
              <th className="py-1.5 pr-2 font-medium">Unit</th>
              <th className="py-1.5 pr-2 font-medium">Delivering role</th>
              <th className="py-1.5 pr-2 text-center font-medium">Counts toward total</th>
              <th className="py-1.5 pr-2 text-center font-medium">Visible</th>
              <th className="py-1.5 pr-2 font-medium">In use</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((u, i) => {
              const error = errorOf(u, i);
              const label = u.name.trim() || `unit ${i + 1}`;
              return (
                <tr key={u.key ?? `new-${i}`} className="border-b align-top last:border-0">
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    <Button type="button" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label} up`}>
                      <LuArrowUp aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon-sm" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label} down`}>
                      <LuArrowDown aria-hidden />
                    </Button>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      value={u.name}
                      maxLength={NAME_MAX}
                      onChange={(e) => set(i, { name: e.target.value })}
                      aria-label={`Unit ${i + 1} name`}
                      aria-invalid={Boolean(error) || undefined}
                      className="w-40"
                    />
                    {error && <p className="mt-0.5 text-xs text-destructive">{error}</p>}
                    {u.aliases.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">Was: {u.aliases.join(", ")}</p>}
                  </td>
                  <td className="w-64 py-1.5 pr-2">
                    <MultiSelect options={roleOptions} value={u.roles} onValueChange={(roles) => set(i, { roles: roles.slice(0, 4) })} placeholder="No role" max={4} />
                  </td>
                  <td className="py-1.5 pr-2 text-center">
                    <input
                      type="checkbox"
                      className="mt-2 size-4 accent-primary"
                      checked={u.countsTowardTotal}
                      onChange={(e) => set(i, { countsTowardTotal: e.target.checked })}
                      aria-label={`${label} counts toward the agreement total`}
                    />
                  </td>
                  <td className="py-1.5 pr-2 text-center">
                    <Switch className="mt-2" checked={!u.hidden} onCheckedChange={(on) => set(i, { hidden: !on })} aria-label={`${label} visible`} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge variant="outline" className="mt-1.5 tabular-nums">
                      {u.rowCount} row{u.rowCount === 1 ? "" : "s"}
                    </Badge>
                  </td>
                  <td className="py-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={u.rowCount > 0}
                      title={u.rowCount > 0 ? "Used by scope rows — hide it instead" : undefined}
                      onClick={() => setDraft((list) => list.filter((_, j) => j !== i))}
                      aria-label={`Remove ${label}`}
                    >
                      <LuTrash2 aria-hidden />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={draft.length >= 40}
          onClick={() => setDraft((list) => [...list, { name: "", roles: [], countsTowardTotal: true, hidden: false, rowCount: 0, aliases: [] }])}
        >
          <LuPlus aria-hidden /> Add unit
        </Button>
        {draft.length > 0 && draft.every((u) => u.hidden) && <p className="text-xs text-destructive">Keep at least one unit visible.</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        Renaming a unit renames it in brand and project scope rows, task names and pending scope requests (history keeps the old name). The scope reader (uploads and pasted text) recognises the visible units by name, e.g. “4 animations”.
      </p>
    </SettingsFormCard>
  );
}
