import { LuFolderKanban, LuPencil, LuPlus } from "react-icons/lu";
import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { firstName } from "@/lib/manpower";
import { LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ManpowerRoleDef, ManpowerSection } from "@/types";

/** A row as the table draws it (read or edit mode): names resolved for display. */
export interface TableRow {
  key: string;
  section: ManpowerSection;
  brand: { _id: string; name: string; color?: string } | null;
  type: string | null;
  name: string;
  cells: Array<{
    role: string;
    users: Array<{ _id: string; name: string }>;
    placeholders: string[];
    notNeeded: boolean;
    note: string;
  }>;
}

const SECTION_LABEL: Record<ManpowerSection, string> = {
  active: "Brands / projects",
  pitch: "Pitches / proactive projects",
};

/**
 * The plan as a table: one line per brand/project, one column per role. In
 * edit mode cells and row headers are buttons (the caller opens the editors).
 */
export function PlanTable({
  rows,
  roles,
  links,
  highlight,
  changedRows,
  editing = false,
  onEditCell,
  onEditRow,
  onAddRow,
}: {
  rows: TableRow[];
  roles: ManpowerRoleDef[];
  links?: Record<string, Array<{ _id: string; code: string; name: string }>>;
  /** Person id to highlight (their cells get a ring). */
  highlight?: string | null;
  /** Row keys to mark as changed (approval review). */
  changedRows?: ReadonlySet<string>;
  editing?: boolean;
  onEditCell?: (rowKey: string, role: string) => void;
  onEditRow?: (rowKey: string) => void;
  onAddRow?: (section: ManpowerSection) => void;
}) {
  const sections: ManpowerSection[] = ["active", "pitch"];
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 min-w-56 border-b bg-muted px-3 py-2 text-left text-xs font-medium text-muted-foreground">
              Brand / project
            </th>
            {roles.map((role) => (
              <th
                key={role.key}
                scope="col"
                className="min-w-28 border-b border-l bg-muted px-2 py-2 text-left align-bottom text-xs font-medium text-muted-foreground"
              >
                {role.label}
              </th>
            ))}
          </tr>
        </thead>
        {sections.map((section) => {
          const list = rows.filter((r) => r.section === section);
          if (list.length === 0 && !editing) return null;
          return (
            <tbody key={section}>
              <tr>
                <th
                  colSpan={roles.length + 1}
                  className="sticky left-0 border-b bg-muted/50 px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                  <span className="sticky left-3">
                    {SECTION_LABEL[section]} · {list.length}
                  </span>
                </th>
              </tr>
              {list.map((row) => (
                <tr key={row.key} className={changedRows?.has(row.key) ? "group bg-amber-500/10" : "group"}>
                  <th
                    scope="row"
                    className={cn(
                      "sticky left-0 z-10 border-b px-3 py-2 text-left align-top font-normal group-hover:bg-muted/40",
                      changedRows?.has(row.key) ? "border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-950" : "bg-card",
                    )}
                  >
                    <RowHeader row={row} links={links?.[row.key]} editing={editing} onEdit={() => onEditRow?.(row.key)} />
                  </th>
                  {roles.map((role) => {
                    const cell = row.cells.find((c) => c.role === role.key);
                    const hit = Boolean(highlight && cell?.users.some((u) => u._id === highlight));
                    const content = <CellContent cell={cell} highlight={highlight} />;
                    return (
                      <td
                        key={role.key}
                        className={cn(
                          "border-b border-l px-2 py-1.5 align-top group-hover:bg-muted/40",
                          hit && "bg-primary/10 group-hover:bg-primary/15",
                        )}
                      >
                        {editing ? (
                          <button
                            type="button"
                            onClick={() => onEditCell?.(row.key, role.key)}
                            className="block min-h-7 w-full rounded-md px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            aria-label={`${row.name}: ${role.label}`}
                          >
                            {content}
                          </button>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {editing && (
                <tr>
                  <td colSpan={roles.length + 1} className="border-b px-3 py-1.5">
                    <Button type="button" variant="ghost" size="sm" className="sticky left-3" onClick={() => onAddRow?.(section)}>
                      <LuPlus aria-hidden />
                      Add {section === "pitch" ? "pitch" : "brand / project"}
                    </Button>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function RowHeader({
  row,
  links,
  editing,
  onEdit,
}: {
  row: TableRow;
  links?: Array<{ _id: string; code: string; name: string }>;
  editing: boolean;
  onEdit: () => void;
}) {
  const dot = row.brand ? (LABEL_COLOR_META[row.brand.color as keyof typeof LABEL_COLOR_META] ?? LABEL_COLOR_META.muted).dot : null;
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium break-words text-foreground">{row.name}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {row.brand ? (
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className={cn("size-2 rounded-full", dot)} />
              {row.brand.name}
            </span>
          ) : (
            <span className="text-destructive">No brand</span>
          )}
          {row.type && <span>· {row.type}</span>}
          {links && links.length > 0 && (
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 rounded px-1 text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  />
                }
              >
                <LuFolderKanban aria-hidden className="size-3" />
                {links.length} project{links.length === 1 ? "" : "s"}
              </PopoverTrigger>
              <PopoverContent className="w-80 p-2">
                <ul className="space-y-1 text-sm">
                  {links.map((p) => (
                    <li key={p._id}>
                      <Link to={`/projects/${p._id}`} className="block rounded px-2 py-1 hover:bg-accent">
                        <span className="font-mono text-xs text-muted-foreground">{p.code}</span> {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </p>
      </div>
      {editing && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${row.name}`}>
          <LuPencil aria-hidden />
        </Button>
      )}
    </div>
  );
}

function CellContent({ cell, highlight }: { cell?: TableRow["cells"][number]; highlight?: string | null }) {
  if (!cell) return <span className="text-muted-foreground/40">·</span>;
  if (cell.notNeeded) return <span className="text-muted-foreground" title="Not needed">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {cell.users.map((u) => (
        <span
          key={u._id}
          title={u.name}
          className={cn(
            "rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground",
            highlight === u._id && "bg-primary text-primary-foreground",
          )}
        >
          {firstName(u.name)}
        </span>
      ))}
      {cell.placeholders.map((p) => (
        <Badge key={p} variant="outline" className="border-dashed border-chart-4/60 bg-chart-4/10 text-xs font-normal" title="Open slot or a name not in the app">
          {p}
        </Badge>
      ))}
      {cell.note && <span className="w-full text-[11px] text-muted-foreground italic">{cell.note}</span>}
    </div>
  );
}
