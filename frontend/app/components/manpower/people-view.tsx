import { useMemo, useState } from "react";
import { LuCalendarOff, LuLoaderCircle, LuPencil, LuPlus, LuTriangleAlert, LuX } from "react-icons/lu";

import { OptionSelect } from "@/components/projects/project-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ManpowerPlanResponse, ManpowerRoleDef } from "@/types";

import type { TableRow } from "./plan-table";

type Assignment = { rowKey: string; role: string };

/** The plan rows with `person` on exactly `assignments` (every other person unchanged). */
function withAssignments(rows: TableRow[], person: { _id: string; name: string }, assignments: Assignment[]): TableRow[] {
  return rows.map((row) => {
    const mine = assignments.filter((a) => a.rowKey === row.key).map((a) => a.role);
    const cells = row.cells.map((cell) => ({
      ...cell,
      users: cell.users.filter((u) => u._id !== person._id),
    }));
    for (const role of mine) {
      const cell = cells.find((c) => c.role === role);
      if (cell) {
        cell.users = [...cell.users, { _id: person._id, name: person.name }];
        cell.notNeeded = false;
      } else {
        cells.push({ role, users: [{ _id: person._id, name: person.name }], placeholders: [], notNeeded: false, note: "" });
      }
    }
    return { ...row, cells };
  });
}

/** Edit one person's lines and roles for the month (saved as a new plan version). */
function PersonDialog({
  person,
  rows,
  roles,
  onClose,
  onSave,
  saving,
}: {
  person: { _id: string; name: string } | null;
  rows: TableRow[];
  roles: ManpowerRoleDef[];
  onClose: () => void;
  onSave: (rows: TableRow[], note: string) => void;
  saving: boolean;
}) {
  const initial = useMemo<Assignment[]>(
    () =>
      person
        ? rows.flatMap((row) => row.cells.filter((c) => c.users.some((u) => u._id === person._id)).map((c) => ({ rowKey: row.key, role: c.role })))
        : [],
    [person, rows],
  );
  const [list, setList] = useState<Assignment[] | null>(null);
  const assignments = list ?? initial;
  const [addRow, setAddRow] = useState("");
  const [addRole, setAddRole] = useState("");
  const rowName = new Map(rows.map((r) => [r.key, r.brand ? `${r.name} (${r.brand.name})` : r.name]));
  const roleName = new Map(roles.map((r) => [r.key, r.label]));
  const changed = JSON.stringify(assignments) !== JSON.stringify(initial);

  return (
    <Dialog open={Boolean(person)} onOpenChange={(open) => !open && !saving && (setList(null), onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{person?.name}: lines this month</DialogTitle>
          <DialogDescription>
            Add or remove this person on any brand line. Saving creates a new version of the month (the old one is kept) and
            updates the teams of the linked projects.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y rounded-lg border text-sm">
          {assignments.map((a, index) => (
            <li key={`${a.rowKey}-${a.role}`} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{rowName.get(a.rowKey) ?? a.rowKey}</span>
                <span className="text-muted-foreground"> — {roleName.get(a.role) ?? a.role}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove"
                onClick={() => setList(assignments.filter((_, i) => i !== index))}
              >
                <LuX aria-hidden />
              </Button>
            </li>
          ))}
          {assignments.length === 0 && <li className="px-3 py-3 text-muted-foreground">Not on any line this month.</li>}
        </ul>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
          <OptionSelect
            value={addRow}
            onChange={setAddRow}
            placeholder="Line…"
            aria-label="Line"
            options={rows.map((r) => ({ value: r.key, label: rowName.get(r.key) ?? r.name }))}
          />
          <OptionSelect
            value={addRole}
            onChange={setAddRole}
            placeholder="Role…"
            aria-label="Role"
            options={roles.map((r) => ({ value: r.key, label: r.label }))}
          />
          <Button
            type="button"
            variant="outline"
            disabled={!addRow || !addRole || assignments.some((a) => a.rowKey === addRow && a.role === addRole)}
            onClick={() => {
              setList([...assignments, { rowKey: addRow, role: addRole }]);
              setAddRole("");
            }}
          >
            <LuPlus aria-hidden />
            Add
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => (setList(null), onClose())} disabled={saving}>
            Cancel
          </Button>
          <Button
            disabled={!changed || saving}
            onClick={() => person && onSave(withAssignments(rows, person, assignments), `Allocation of ${person.name} changed`)}
          >
            {saving && <LuLoaderCircle aria-hidden className="animate-spin" />}
            Save as new version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Each person's allocation in the month: lines and roles, over-allocation
 * (more lines than the plan's limit), approved leave in the month, and the
 * people with nothing planned (available).
 */
export function PeopleView({
  data,
  roles,
  onHighlight,
  rows,
  canEdit = false,
  onSave,
  saving = false,
}: {
  data: ManpowerPlanResponse;
  roles: ManpowerRoleDef[];
  onHighlight: (userId: string) => void;
  /** The plan as table rows (for per-person editing). */
  rows?: TableRow[];
  /** Plan editors on the latest version: edit a person's lines. */
  canEdit?: boolean;
  /** Saves a new version; `done` runs once it's saved. */
  onSave?: (rows: TableRow[], note: string, done: () => void) => void;
  saving?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ _id: string; name: string } | null>(null);
  const editable = canEdit && Boolean(rows && onSave);
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
                  {editable && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="mt-1 -ml-2"
                      onClick={() => setEditing({ _id: p.user._id, name: p.user.name })}
                    >
                      <LuPencil aria-hidden />
                      Edit lines
                    </Button>
                  )}
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
          {available.map((p) =>
            editable ? (
              <button key={p._id} type="button" onClick={() => setEditing({ _id: p._id, name: p.name })} title="Add to a line">
                <Badge variant="secondary" className="cursor-pointer font-normal hover:bg-primary/15">
                  <LuPlus aria-hidden className="size-3" />
                  {p.name}
                  {p.leaveDays > 0 && ` · leave ${p.leaveDays}d`}
                </Badge>
              </button>
            ) : (
              <Badge key={p._id} variant="secondary" className="font-normal" title={p.designation || undefined}>
                {p.name}
                {p.leaveDays > 0 && ` · leave ${p.leaveDays}d`}
              </Badge>
            ),
          )}
        </div>
      </section>
      {editable && (
        <PersonDialog
          key={editing?._id ?? "none"}
          person={editing}
          rows={rows!}
          roles={roles}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={(next, note) => onSave!(next, note, () => setEditing(null))}
        />
      )}
    </div>
  );
}
