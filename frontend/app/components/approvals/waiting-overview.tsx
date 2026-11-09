import { useState } from "react";
import { Link } from "react-router";
import { LuCircleCheck, LuClipboardCheck, LuEye, LuLoaderCircle } from "react-icons/lu";

import { KIND_LABEL } from "@/components/approvals/change-approvals";
import { useDecideOverScope, useOverScopeTasks } from "@/components/tasks/over-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDecideBrand, useDecideChange, useDecideProjectApproval } from "@/hooks/use-project-approval";
import { formatDateTime } from "@/lib/format";
import { brandWithOrg } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ProjectApprovalQueue } from "@/types";

type Category = "overScope" | "project_change" | "brand_edit" | "project_move" | "manpower_plan" | "newBrand" | "newProject";

const CATEGORY_LABEL: Record<Category, string> = {
  overScope: "Tasks over scope",
  project_change: "Scope / team",
  brand_edit: "Brand changes",
  project_move: "Brand moves",
  manpower_plan: "Manpower plans",
  newBrand: "New brands",
  newProject: "New projects",
};

/** Where each category's full block sits on the page (reject with a reason there). */
export const APPROVAL_SECTION: Record<Category, string> = {
  overScope: "approvals-over-scope",
  project_change: "approvals-changes",
  brand_edit: "approvals-changes",
  project_move: "approvals-changes",
  manpower_plan: "approvals-changes",
  newBrand: "approvals-brands",
  newProject: "approvals-projects",
};

interface Row {
  key: string;
  id: string;
  category: Category;
  badge: string;
  title: string;
  by: string;
  at: string | null;
  /** Review page, when the item has one; else the block below. */
  review: string | null;
}

/**
 * Everything waiting for leadership in one list, oldest first: a count per
 * category (click to filter), Approve straight from the row, and Review for
 * the details (reject with a reason there or in the block below).
 */
export function WaitingOverview({ queue }: { queue: ProjectApprovalQueue }) {
  const { data: user } = useCurrentUser();
  const overScope = useOverScopeTasks(user?.role === "admin");
  const decideChange = useDecideChange();
  const decideBrand = useDecideBrand();
  const decideProject = useDecideProjectApproval();
  const decideOverScope = useDecideOverScope();
  const [filter, setFilter] = useState<Category | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows: Row[] = [
    ...(overScope.data ?? []).map((t) => ({
      key: `task:${t._id}`,
      id: t._id,
      category: "overScope" as const,
      badge: "Over scope",
      title: `${t.shortCode ? `${t.shortCode} · ` : ""}${t.title}`,
      by: t.assignedBy?.name ?? "Someone",
      at: t.createdAt,
      review: `/tasks?task=${t._id}`,
    })),
    ...(queue.changes?.pending ?? []).map((c) => ({
      key: `change:${c._id}`,
      id: c._id,
      category: c.kind,
      badge: KIND_LABEL[c.kind],
      title: c.title,
      by: c.requestedBy?.name ?? "Someone",
      at: c.createdAt,
      review: `/approvals/${c._id}`,
    })),
    ...(queue.brands?.pending ?? []).map((b) => ({
      key: `brand:${b._id}`,
      id: b._id,
      category: "newBrand" as const,
      badge: "New brand",
      title: brandWithOrg(b),
      by: b.requestedBy?.name ?? "Someone",
      at: b.createdAt,
      review: null,
    })),
    ...queue.pending.map((p) => ({
      key: `project:${p._id}`,
      id: p._id,
      category: "newProject" as const,
      badge: "New project",
      title: p.name,
      by: p.requestedBy ?? "Someone",
      at: p.approval?.requestedAt ?? null,
      review: `/approvals/project/${p._id}`,
    })),
  ].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

  const counts = new Map<Category, number>();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  const shown = filter ? rows.filter((r) => r.category === filter) : rows;
  const deciding =
    decideChange.isPending || decideBrand.isPending || decideProject.isPending || decideOverScope.isPending;

  function approve(row: Row) {
    setBusy(row.key);
    const done = { onSettled: () => setBusy(null) };
    if (row.category === "overScope") decideOverScope.mutate({ id: row.id, decision: "approve" }, done);
    else if (row.category === "newBrand") decideBrand.mutate({ id: row.id, decision: "approve" }, done);
    else if (row.category === "newProject") decideProject.mutate({ id: row.id, decision: "approve" }, done);
    else decideChange.mutate({ id: row.id, decision: "approve" }, done);
  }

  function showBlock(category: Category) {
    document.getElementById(APPROVAL_SECTION[category])?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Waiting for approval ({rows.length})</h2>
        {rows.length > 0 && <p className="text-xs text-muted-foreground">Oldest first</p>}
      </div>

      {rows.length === 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
          <LuClipboardCheck aria-hidden className="size-4" />
          Nothing waiting — you&apos;re all caught up.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
            <FilterChip active={filter === null} onClick={() => setFilter(null)}>
              All {rows.length}
            </FilterChip>
            {(Object.keys(CATEGORY_LABEL) as Category[])
              .filter((c) => counts.has(c))
              .map((c) => (
                <FilterChip key={c} active={filter === c} onClick={() => setFilter(filter === c ? null : c)}>
                  {CATEGORY_LABEL[c]} {counts.get(c)}
                </FilterChip>
              ))}
          </div>

          <ul className="divide-y rounded-xl border bg-card text-sm">
            {shown.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{row.badge}</Badge>
                    <span className="font-medium break-words text-foreground">{row.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.by}
                    {row.at ? ` · ${formatDateTime(row.at)}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {row.review ? (
                    <Button size="sm" variant="outline" render={<Link to={row.review} />}>
                      <LuEye aria-hidden />
                      Review
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => showBlock(row.category)}>
                      <LuEye aria-hidden />
                      Details
                    </Button>
                  )}
                  <Button size="sm" onClick={() => approve(row)} disabled={deciding}>
                    {busy === row.key ? (
                      <LuLoaderCircle aria-hidden className="animate-spin" />
                    ) : (
                      <LuCircleCheck aria-hidden />
                    )}
                    Approve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            To reject, open Review (or Details) — a reason is asked there.
          </p>
        </>
      )}
    </section>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
