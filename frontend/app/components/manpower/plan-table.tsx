import { useEffect, useRef, useState, type ReactNode } from "react";
import { LuChevronDown, LuChevronLeft, LuChevronRight, LuFilter, LuFolderKanban, LuPencil, LuPlus } from "react-icons/lu";
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
  changedCells,
  newRows,
  unclearName,
  scope,
  editing = false,
  onEditCell,
  onEditRow,
  onAddRow,
  activeCell,
  renderCellEditor,
}: {
  rows: TableRow[];
  roles: ManpowerRoleDef[];
  links?: Record<string, Array<{ _id: string; code: string; name: string }>>;
  /** Person id to highlight (their cells get a ring). */
  highlight?: string | null;
  /** Row keys to mark as changed (approval review). */
  changedRows?: ReadonlySet<string>;
  /** Cells that differ from the version compared with: row key → role → what it was. */
  changedCells?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Lines that aren't in the version compared with. */
  newRows?: ReadonlySet<string>;
  /** The people a written (unmatched) name could be: 2+ marks it red to be picked. */
  unclearName?: (name: string) => string[];
  /** Each line's scope (its linked projects' scope rows added up). */
  scope?: Record<string, Array<{ unit: string; total: number }>>;
  editing?: boolean;
  onEditCell?: (rowKey: string, role: string) => void;
  onEditRow?: (rowKey: string) => void;
  onAddRow?: (section: ManpowerSection) => void;
  /** The cell being edited in place (no pop-up) and its editor. */
  activeCell?: { rowKey: string; role: string } | null;
  renderCellEditor?: (row: TableRow, role: ManpowerRoleDef) => ReactNode;
}) {
  const sections: ManpowerSection[] = ["active", "pitch"];
  // Excel-style column filters: column ("brand" or a role key) → the values ticked.
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const valuesOf = (row: TableRow, col: string): string[] => {
    if (col === "brand") return [row.brand?.name ?? "(no brand)"];
    const cell = row.cells.find((c) => c.role === col);
    if (!cell || (!cell.notNeeded && cell.users.length === 0 && cell.placeholders.length === 0)) return ["(empty)"];
    if (cell.notNeeded) return ["— not needed"];
    return [...cell.users.map((u) => u.name), ...cell.placeholders];
  };
  const passes = (row: TableRow) =>
    Object.entries(filters).every(([col, picked]) => picked.length === 0 || valuesOf(row, col).some((v) => picked.includes(v)));
  const columnValues = (col: string) => [...new Set(rows.flatMap((r) => valuesOf(r, col)))].sort((a, b) => a.localeCompare(b));
  const filterButton = (col: string, label: string) => {
    const picked = filters[col] ?? [];
    const values = columnValues(col);
    return (
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`Filter ${label}`}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded border bg-background text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                picked.length > 0 && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            />
          }
        >
          {picked.length > 0 ? <LuFilter aria-hidden className="size-3" /> : <LuChevronDown aria-hidden className="size-3" />}
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2">
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-medium">{label}</span>
            {picked.length > 0 && (
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setFilters(({ [col]: _gone, ...rest }) => rest)}>
                Clear
              </button>
            )}
          </div>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto text-sm">
            {values.map((v) => (
              <li key={v}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-accent">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    checked={picked.includes(v)}
                    onChange={(e) =>
                      setFilters((f) => {
                        const next = e.target.checked ? [...(f[col] ?? []), v] : (f[col] ?? []).filter((x) => x !== v);
                        const { [col]: _old, ...rest } = f;
                        return next.length ? { ...rest, [col]: next } : rest;
                      })
                    }
                  />
                  <span className="truncate">{v}</span>
                </label>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    );
  };
  // True duplicates (same brand, same line name): flagged so they can be removed by hand.
  const lineId = (r: TableRow) => `${r.brand?._id ?? ""}|${r.name.replace(/\s+/g, " ").trim().toLowerCase()}`;
  const sameLines = new Map<string, number>();
  for (const r of rows) if (r.brand) sameLines.set(lineId(r), (sameLines.get(lineId(r)) ?? 0) + 1);
  // Sideways scrolling is always visible: ‹ › buttons and a bar above the table
  // (kept in step with the table's own scrollbars).
  const box = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.scrollWidth);
      setOverflow(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [rows.length, roles.length]);
  const syncing = useRef(false);
  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => (syncing.current = false));
  };
  const nudge = (direction: 1 | -1) => box.current?.scrollBy({ left: direction * 480, behavior: "smooth" });
  // The app hides scrollbars by default; this table shows them (app.css .table-scrollbar).
  const bar = "table-scrollbar";
  return (
    <div className="space-y-1.5">
      {overflow && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon-sm" onClick={() => nudge(-1)} aria-label="Scroll the plan left">
            <LuChevronLeft aria-hidden />
          </Button>
          <div
            ref={top}
            className={cn("h-[18px] flex-1 overflow-x-auto overflow-y-hidden rounded", bar)}
            onScroll={() => follow(top.current, box.current)}
            aria-hidden
          >
            <div style={{ width, height: 1 }} />
          </div>
          <Button type="button" variant="outline" size="icon-sm" onClick={() => nudge(1)} aria-label="Scroll the plan right">
            <LuChevronRight aria-hidden />
          </Button>
        </div>
      )}
    {/* Its own scroll area (both directions); the header row and the brand column stay put. */}
    <div
      ref={box}
      onScroll={() => follow(box.current, top.current)}
      className={cn("max-h-[calc(100dvh-13rem)] min-h-64 overflow-x-auto overflow-y-scroll rounded-xl border bg-card", bar)}
      tabIndex={0}
      aria-label="Manpower plan table (scroll sideways and down)"
    >
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {/* Spreadsheet-style headers: bold, wrapped, a filter at the bottom right of each column. */}
            <th className="sticky top-0 left-0 z-30 min-w-56 border-r border-b-2 border-b-foreground/30 bg-muted px-3 py-2 text-left align-bottom">
              <div className="flex items-end justify-between gap-2">
                <span className="text-sm leading-tight font-semibold text-foreground">Brands / Projects</span>
                {filterButton("brand", "Brands / Projects")}
              </div>
            </th>
            {roles.map((role) => (
              <th
                key={role.key}
                scope="col"
                className="sticky top-0 z-20 w-28 min-w-28 border-r border-b-2 border-b-foreground/30 bg-muted px-2 py-2 text-left align-bottom"
              >
                <div className="flex h-full items-end justify-between gap-1">
                  <span className="text-[13px] leading-tight font-semibold whitespace-normal text-foreground">{role.label}</span>
                  {filterButton(role.key, role.label)}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        {sections.map((section) => {
          const list = rows.filter((r) => r.section === section && passes(r));
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
                    <RowHeader row={row} links={links?.[row.key]} duplicate={(sameLines.get(lineId(row)) ?? 0) > 1} editing={editing} onEdit={() => onEditRow?.(row.key)} />
                    {newRows?.has(row.key) && (
                      <span className="mt-1 inline-block rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                        New line
                      </span>
                    )}
                    {scope?.[row.key]?.length ? (
                      <p className="mt-0.5 text-xs text-muted-foreground" title="Scope of the linked projects">
                        Scope: {scope[row.key]!.map((t) => `${t.total} ${t.unit}`).join(" · ")}
                      </p>
                    ) : null}
                  </th>
                  {roles.map((role) => {
                    const cell = row.cells.find((c) => c.role === role.key);
                    const hit = Boolean(highlight && cell?.users.some((u) => u._id === highlight));
                    const was = changedCells?.get(row.key)?.get(role.key);
                    const content = <CellContent cell={cell} highlight={highlight} unclear={unclearName} />;
                    return (
                      <td
                        key={role.key}
                        className={cn(
                          "border-b border-l px-2 py-1.5 align-top group-hover:bg-muted/40",
                          hit && "bg-primary/10 group-hover:bg-primary/15",
                          was !== undefined && "bg-amber-100 ring-1 ring-inset ring-amber-400 dark:bg-amber-900/40",
                        )}
                        title={was !== undefined ? `Changed — was: ${was || "empty"}` : undefined}
                      >
                        {editing && activeCell?.rowKey === row.key && activeCell.role === role.key && renderCellEditor ? (
                          renderCellEditor(row, role)
                        ) : editing ? (
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
    </div>
  );
}

function RowHeader({
  row,
  links,
  duplicate = false,
  editing,
  onEdit,
}: {
  row: TableRow;
  links?: Array<{ _id: string; code: string; name: string }>;
  /** Another line has the same brand and name (a duplicate to remove by hand). */
  duplicate?: boolean;
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
          {duplicate && (
            <span className="rounded bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" title="Another line has the same brand and name — keep one and remove the other (Edit plan → line → Remove line)">
              duplicate line
            </span>
          )}
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

function CellContent({
  cell,
  highlight,
  unclear,
}: {
  cell?: TableRow["cells"][number];
  highlight?: string | null;
  /** The people a written name could be ("Nabil" → Omar Nabil, Mohamed Nabil); 2+ = needs picking. */
  unclear?: (name: string) => string[];
}) {
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
      {cell.placeholders.map((p) => {
        const could = unclear?.(p) ?? [];
        return could.length > 1 ? (
          <Badge
            key={p}
            variant="outline"
            className="border-red-500 bg-red-100 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-300"
            title={`Who is this? Could be ${could.join(" or ")} — edit the cell to pick the right person`}
          >
            {p} ?
          </Badge>
        ) : (
          <Badge key={p} variant="outline" className="border-dashed border-chart-4/60 bg-chart-4/10 text-xs font-normal" title="Open slot or a name not in the app">
            {p}
          </Badge>
        );
      })}
      {cell.note && <span className="w-full text-[11px] text-muted-foreground italic">{cell.note}</span>}
    </div>
  );
}
