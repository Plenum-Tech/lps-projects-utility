import { useEffect, useId, useMemo, useState } from "react";
import {
  LuArchive,
  LuArchiveRestore,
  LuCalendarDays,
  LuCircleDot,
  LuDownload,
  LuFolderKanban,
  LuLayoutList,
  LuLoaderCircle,
  LuPin,
  LuPlus,
  LuTrash2,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { BulkBar, BulkMenu } from "@/components/globals/data-table/bulk-bar";
import { DateRangeFilter, FilterChip, FiltersBar, MultiFilter } from "@/components/globals/data-table/filters-bar";
import { FiltersSheet, SheetSelect, SheetSwitch } from "@/components/globals/data-table/filters-sheet";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { DataTableToolbar, ViewToggle, type ViewOption } from "@/components/globals/data-table/toolbar";
import { FilterSelect } from "@/components/globals/filter-select";
import { ImportButton } from "@/components/imports/import-button";
import { EmptyState, PageHeader } from "@/components/globals/query-states";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import {
  ArchiveDialog,
  DeleteProjectDialog,
  DuplicateProjectDialog,
} from "@/components/projects/project-header";
import { ProjectsCalendar } from "@/components/projects/projects-calendar";
import { ProjectsTable, type ProjectDialogKind } from "@/components/projects/projects-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/hooks/use-auth";
import { useBrands } from "@/hooks/use-brands";
import { useDepartments } from "@/hooks/use-departments";
import { useProjectCategories, useProjectStatuses, useProjectTypes } from "@/hooks/use-project-meta";
import {
  projectQueryParams,
  useBulkProjects,
  useExportProjects,
  useProjectRealtime,
  useProjects,
  type ProjectFilters,
  type ProjectSortField,
  type ProjectTab,
} from "@/hooks/use-projects";
import { useRowSelection, useTableState } from "@/hooks/use-table-state";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { formatDateOnly } from "@/lib/format";
import { canManageProjectClient, namingMonthLabel, PROGRESS_BUCKETS, statusColor } from "@/lib/projects";
import type { Project, Role } from "@/types";

type ProjectView = "list" | "archive" | "calendar" | "pinned";

const VIEWS: ViewOption<ProjectView>[] = [
  { value: "list", label: "List", icon: LuLayoutList },
  { value: "archive", label: "Archive", icon: LuArchive },
  { value: "calendar", label: "Calendar", icon: LuCalendarDays },
  { value: "pinned", label: "Pinned", icon: LuPin },
];

const DEFAULTS = {
  view: "list",
  search: "",
  status: "",
  from: "",
  to: "",
  progress: "",
  category: "",
  brand: "",
  /** Structured-name Type ("none" = legacy names) and Month ("YYYY-MM"). */
  type: "",
  month: "",
  department: "",
  manager: "",
  member: "",
  deadline: "",
  /** "1" = completed status only (My dashboard → Projects → Completed). */
  completed: "",
  completedFrom: "",
  completedTo: "",
  /** My dashboard links (Worksuite definitions): team member only, progress < 100 %, deadline / active ranges. */
  memberOnly: "",
  active: "",
  deadlineFrom: "",
  deadlineTo: "",
  activeFrom: "",
  activeTo: "",
};

type FilterKey = keyof typeof DEFAULTS;
const SHEET_KEYS: FilterKey[] = ["category", "brand", "type", "month", "department", "manager", "member", "deadline", "completed"];
const INLINE_KEYS: FilterKey[] = ["search", "status", "from", "to", "progress"];
/** Only shown as removable chips (no control of their own). */
const CHIP_KEYS: FilterKey[] = [
  "completedFrom",
  "completedTo",
  "memberOnly",
  "active",
  "deadlineFrom",
  "deadlineTo",
  "activeFrom",
  "activeTo",
];
const CLEARABLE_KEYS: FilterKey[] = [...INLINE_KEYS, ...SHEET_KEYS, ...CHIP_KEYS];
const NO_COMPLETED = { completed: "", completedFrom: "", completedTo: "" };

/** "8 Sep – 8 Oct 2026" / "from …" / "until …". */
function rangeText(from: string, to: string): string {
  if (from && to) return `${formatDateOnly(from)} – ${formatDateOnly(to)}`;
  return from ? `from ${formatDateOnly(from)}` : `until ${formatDateOnly(to)}`;
}

const SORT_FIELDS: ProjectSortField[] = ["code", "name", "startDate", "deadline", "progress", "status"];

function isView(value: string): value is ProjectView {
  return VIEWS.some((view) => view.value === value);
}

/** The /projects page: toolbar, filters (in the URL), table / calendar, bulk actions. */
export function ProjectWorkspace() {
  const { data: user } = useCurrentUser();
  const role: Role = user?.role ?? "employee";
  const isAdmin = role === "admin";
  const isHeadOrAdmin = isAdmin || role === "head";
  // Heads import into their own department, so they need one.
  const canImport = isAdmin || (role === "head" && Boolean(user?.department));
  const me = useMemo(() => ({ _id: user?._id ?? "", role }), [user?._id, role]);

  useProjectRealtime();

  const table = useTableState({ storageKey: "projects", defaults: DEFAULTS });
  const { filters } = table;
  const view: ProjectView = isView(filters.view) ? filters.view : "list";
  const tab: ProjectTab = view === "archive" ? "archived" : view === "pinned" ? "pinned" : "active";
  const sort = (SORT_FIELDS as string[]).includes(table.sort) ? (table.sort as ProjectSortField) : "";

  const listFilters: Omit<ProjectFilters, "tab"> = {
    search: filters.search,
    status: filters.status,
    category: filters.category,
    brand: filters.brand,
    type: filters.type,
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month) ? filters.month : "",
    department: filters.department,
    manager: filters.manager,
    member: filters.member,
    deadline: filters.deadline === "overdue" ? "overdue" : "",
    from: filters.from,
    to: filters.to,
    progress: filters.progress,
    // Dates imply completed (the API treats them so too).
    completed: filters.completed || filters.completedFrom || filters.completedTo ? "true" : "",
    completedFrom: filters.completedFrom,
    completedTo: filters.completedTo,
    memberOnly: filters.memberOnly,
    active: filters.active === "1" ? "1" : "",
    deadlineFrom: filters.deadlineFrom,
    deadlineTo: filters.deadlineTo,
    activeFrom: filters.activeFrom && filters.activeTo ? filters.activeFrom : "",
    activeTo: filters.activeFrom && filters.activeTo ? filters.activeTo : "",
  };
  const completedOn = listFilters.completed === "true";
  // Employees have no Member select; show "my projects" (dashboard links) as a chip.
  const memberChip = !isHeadOrAdmin && Boolean(filters.member);

  const projects = useProjects(
    { ...listFilters, tab, sort, dir: table.dir, limit: table.pageSize, offset: table.offset },
    Boolean(user) && view !== "calendar"
  );
  const { clampPage } = table;
  useEffect(() => {
    if (projects.data) clampPage(projects.data.total);
  }, [projects.data, clampPage]);

  const statuses = useProjectStatuses();
  const categories = useProjectCategories();
  const brands = useBrands(false, Boolean(user));
  const projectTypes = useProjectTypes(Boolean(user));
  const typeLabel = filters.type === "none" ? "Legacy names" : filters.type;
  const people = useAssignableUsers(Boolean(user));

  const selection = useRowSelection();
  const { clear: clearSelection } = selection;
  const selectionKey = JSON.stringify({ ...filters, sort: table.sort, dir: table.dir });
  useEffect(() => {
    clearSelection();
  }, [selectionKey, clearSelection]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [brandFlowOpen, setBrandFlowOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: ProjectDialogKind; project: Project } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<"archive" | "restore" | "delete" | null>(null);

  const bulk = useBulkProjects();
  const exporter = useExportProjects();

  const statusOptions = useMemo(
    () => (statuses.data ?? []).map((status) => ({ value: status._id, label: status.name })),
    [statuses.data]
  );
  const activeStatusOptions = useMemo(
    () =>
      (statuses.data ?? [])
        .filter((status) => status.active)
        .map((status) => ({
          value: status._id,
          label: status.name,
          dot: statusColor(status.color).dot,
        })),
    [statuses.data]
  );
  const peopleOptions = useMemo(
    () => (people.data ?? []).map((person) => ({ value: person._id, label: person.name })),
    [people.data]
  );

  // Bulk status/archive/restore only when at least one selected project is
  // manageable (others are skipped server-side). Rows selected on another page
  // aren't loaded here — assume they might be.
  const pageRows = projects.data?.projects ?? [];
  const selectedOnPage = pageRows.filter((project) => selection.ids.includes(project._id));
  const canManageSelection =
    isAdmin ||
    selectedOnPage.length < selection.count ||
    selectedOnPage.some((project) => canManageProjectClient(project, me));

  const sheetCount = table.countActive(SHEET_KEYS);
  const filtered = table.countActive(CLEARABLE_KEYS) > 0;

  function runBulk(action: "status" | "archive" | "restore" | "delete", status?: string) {
    bulk.mutate(
      { ids: selection.ids, action, ...(status ? { status } : {}) },
      {
        onSuccess: (result) => {
          setBulkConfirm(null);
          if (action === "status") selection.setMany(result.updatedIds, false);
          else selection.clear();
        },
      }
    );
  }

  function exportCsv(ids?: string[]) {
    exporter.mutate(
      ids ? { ids: ids.join(",") } : projectQueryParams({ ...listFilters, tab, sort, dir: table.dir })
    );
  }

  const items = projects.data?.projects;
  const total = projects.data?.total ?? 0;
  const empty = filtered ? (
    <EmptyState
      icon={LuFolderKanban}
      title="No matching projects"
      description="Try a different search or clear the filters."
      className="border-0"
    >
      <Button variant="outline" onClick={() => table.clearFilters(CLEARABLE_KEYS)}>
        Clear filters
      </Button>
    </EmptyState>
  ) : view === "archive" ? (
    <EmptyState
      icon={LuArchive}
      title="No archived projects"
      description="Archived projects are read-only and appear here until they're restored."
      className="border-0"
    />
  ) : view === "pinned" ? (
    <EmptyState
      icon={LuPin}
      title="Nothing pinned yet"
      description="Pin a project from its ⋮ menu to keep it one click away."
      className="border-0"
    />
  ) : (
    <EmptyState
      icon={LuFolderKanban}
      title="No projects yet"
      description={
        "Create your first project, add the team and start tracking work and time."
      }
      className="border-0"
    >
      <Button onClick={() => setCreateOpen(true)}>
        <LuPlus aria-hidden />
        Add project
      </Button>
    </EmptyState>
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Projects"
        description="Plan work, track progress and time across your projects."
      />

      <div className="mt-6 space-y-4">
        <DataTableToolbar
          actions={
            <>
              <Button onClick={() => setCreateOpen(true)}>
                <LuPlus aria-hidden />
                Add project
              </Button>
              {isAdmin && (
                <Button variant="outline" onClick={() => setBrandFlowOpen(true)}>
                  <LuPlus aria-hidden />
                  New brand
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => exportCsv()}
                disabled={exporter.isPending || view === "calendar"}
              >
                {exporter.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuDownload aria-hidden />
                )}
                Export
              </Button>
              {canImport && <ImportButton type="projects" />}
            </>
          }
          end={
            <ViewToggle
              label="Projects view"
              value={view}
              onChange={(next) => table.setFilters({ view: next })}
              options={VIEWS}
            />
          }
        />

        <FiltersBar
          search={filters.search}
          onSearchChange={(search) => table.setFilters({ search })}
          searchPlaceholder="Search name, code or summary…"
          sheetCount={sheetCount}
          onOpenSheet={() => setSheetOpen(true)}
          canClear={filtered}
          onClearAll={() => table.clearFilters(CLEARABLE_KEYS)}
          chips={
            completedOn ||
            memberChip ||
            filters.type ||
            listFilters.month ||
            filters.memberOnly ||
            listFilters.active ||
            filters.deadlineFrom ||
            filters.deadlineTo ||
            listFilters.activeFrom ? (
              <>
                {filters.type && (
                  <FilterChip onRemove={() => table.setFilters({ type: "" })}>Type · {typeLabel}</FilterChip>
                )}
                {listFilters.month && (
                  <FilterChip onRemove={() => table.setFilters({ month: "" })}>
                    Month · {namingMonthLabel(listFilters.month)}
                  </FilterChip>
                )}
                {memberChip && (
                  <FilterChip onRemove={() => table.setFilters({ member: "" })}>
                    {filters.member === me._id ? "My projects" : "Member filter"}
                  </FilterChip>
                )}
                {filters.memberOnly && (
                  <FilterChip onRemove={() => table.setFilters({ memberOnly: "" })}>
                    {filters.memberOnly === me._id ? "I'm a member" : "Team member filter"}
                  </FilterChip>
                )}
                {listFilters.active && (
                  <FilterChip onRemove={() => table.setFilters({ active: "" })}>Progress &lt; 100%</FilterChip>
                )}
                {(filters.deadlineFrom || filters.deadlineTo) && (
                  <FilterChip onRemove={() => table.setFilters({ deadlineFrom: "", deadlineTo: "" })}>
                    Deadline {rangeText(filters.deadlineFrom, filters.deadlineTo)}
                  </FilterChip>
                )}
                {listFilters.activeFrom && (
                  <FilterChip onRemove={() => table.setFilters({ activeFrom: "", activeTo: "" })}>
                    Active {rangeText(filters.activeFrom, filters.activeTo)}
                  </FilterChip>
                )}
                {completedOn && (
                  <FilterChip onRemove={() => table.setFilters(NO_COMPLETED)}>
                    Completed
                    {(filters.completedFrom || filters.completedTo) &&
                      ` · ${rangeText(filters.completedFrom, filters.completedTo)}`}
                  </FilterChip>
                )}
              </>
            ) : undefined
          }
        >
          {view !== "calendar" && (
            <DateRangeFilter
              from={filters.from}
              to={filters.to}
              onChange={(range) => table.setFilters(range)}
              description="Projects whose start → deadline overlaps this range."
            />
          )}
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(status) => table.setFilters({ status })}
            options={statusOptions}
          />
          <MultiFilter
            label="Progress"
            value={filters.progress}
            onChange={(progress) => table.setFilters({ progress })}
            options={PROGRESS_BUCKETS.map((bucket) => ({ value: bucket, label: `${bucket.replace("-", "–")}%` }))}
          />
        </FiltersBar>

        {view !== "calendar" && (
          <BulkBar count={selection.count} onClear={selection.clear} pending={bulk.isPending}>
            {view !== "archive" && canManageSelection && activeStatusOptions.length > 0 && (
              <BulkMenu
                label="Change status"
                icon={<LuCircleDot aria-hidden />}
                heading="Set status to"
                options={activeStatusOptions}
                onSelect={(status) => runBulk("status", status)}
                disabled={bulk.isPending}
              />
            )}
            {view !== "archive" && canManageSelection && (
              <Button variant="outline" size="sm" onClick={() => setBulkConfirm("archive")} disabled={bulk.isPending}>
                <LuArchive aria-hidden />
                Archive
              </Button>
            )}
            {view === "archive" && canManageSelection && (
              <Button variant="outline" size="sm" onClick={() => setBulkConfirm("restore")} disabled={bulk.isPending}>
                <LuArchiveRestore aria-hidden />
                Restore
              </Button>
            )}
            {view === "archive" && isAdmin && (
              <Button variant="destructive" size="sm" onClick={() => setBulkConfirm("delete")} disabled={bulk.isPending}>
                <LuTrash2 aria-hidden />
                Delete
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportCsv(selection.ids)}
              disabled={exporter.isPending}
            >
              <LuDownload aria-hidden />
              Export selected
            </Button>
          </BulkBar>
        )}

        {view === "calendar" ? (
          <ProjectsCalendar filters={listFilters} />
        ) : (
          <ProjectsTable
            projects={items}
            total={total}
            loading={projects.isPending}
            error={projects.isError ? projects.error : null}
            onRetry={() => void projects.refetch()}
            retrying={projects.isRefetching}
            dimmed={projects.isPlaceholderData}
            selection={selection}
            sort={table.sort}
            dir={table.dir}
            onSort={table.toggleSort}
            statuses={statuses.data ?? []}
            me={me}
            onDialog={(kind, project) => setDialog({ kind, project })}
            empty={empty}
            footer={
              projects.data && total > 0 ? (
                <DataTablePager
                  page={table.page}
                  pageSize={table.pageSize}
                  total={total}
                  shown={items?.length ?? 0}
                  onPageChange={table.setPage}
                  onPageSizeChange={table.setPageSize}
                />
              ) : null
            }
          />
        )}
      </div>

      <FiltersSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        activeCount={sheetCount}
        onClear={() => table.clearFilters([...SHEET_KEYS, ...CHIP_KEYS])}
      >
        <SheetSelect
          label="Category"
          value={filters.category}
          onChange={(category) => table.setFilters({ category })}
          options={(categories.data ?? []).map((category) => ({ value: category._id, label: category.name }))}
        />
        <SheetSelect
          label="Brand"
          value={filters.brand}
          onChange={(brand) => table.setFilters({ brand })}
          options={[
            { value: "none", label: "No brand" },
            ...(brands.data ?? []).map((brand) => ({
              value: brand._id,
              label: brand.active ? brand.name : `${brand.name} (inactive)`,
            })),
          ]}
        />
        <SheetSelect
          label="Type"
          value={filters.type}
          onChange={(type) => table.setFilters({ type })}
          options={[
            ...(projectTypes.data ?? []).map((type) => ({ value: type.name, label: type.name })),
            { value: "none", label: "Legacy names (no type)" },
          ]}
        />
        <SheetMonth
          label="Month"
          value={listFilters.month ?? ""}
          onChange={(month) => table.setFilters({ month })}
        />
        {isAdmin && (
          <DepartmentSheetSelect
            value={filters.department}
            onChange={(department) => table.setFilters({ department })}
          />
        )}
        {isHeadOrAdmin && (
          <>
            <SheetSelect
              label="Manager"
              value={filters.manager}
              onChange={(manager) => table.setFilters({ manager })}
              options={peopleOptions}
            />
            <SheetSelect
              label="Member"
              value={filters.member}
              onChange={(member) => table.setFilters({ member })}
              options={peopleOptions}
            />
          </>
        )}
        <SheetSwitch
          label="Overdue only"
          description="Deadline before today and not completed."
          checked={filters.deadline === "overdue"}
          onCheckedChange={(checked) => table.setFilters({ deadline: checked ? "overdue" : "" })}
        />
        <SheetSwitch
          label="Completed only"
          description={
            filters.completedFrom || filters.completedTo
              ? `Completed ${rangeText(filters.completedFrom, filters.completedTo)}.`
              : "Projects in a completed status."
          }
          checked={completedOn}
          onCheckedChange={(checked) => table.setFilters(checked ? { completed: "1" } : NO_COMPLETED)}
        />
      </FiltersSheet>

      <ProjectFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {isAdmin && <BrandFlowDialog open={brandFlowOpen} onOpenChange={setBrandFlowOpen} />}

      {dialog && (
        <>
          <ProjectFormDialog
            open={dialog.kind === "edit"}
            onOpenChange={(open) => !open && setDialog(null)}
            project={dialog.project}
          />
          <DuplicateProjectDialog
            project={dialog.project}
            open={dialog.kind === "duplicate"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <ArchiveDialog
            project={dialog.project}
            archive={dialog.kind === "archive"}
            open={dialog.kind === "archive" || dialog.kind === "restore"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <DeleteProjectDialog
            project={dialog.project}
            open={dialog.kind === "delete"}
            onOpenChange={(open) => !open && setDialog(null)}
            onDeleted={() => setDialog(null)}
          />
        </>
      )}

      <ConfirmDialog
        open={bulkConfirm !== null}
        onOpenChange={(open) => !open && setBulkConfirm(null)}
        pending={bulk.isPending}
        destructive={bulkConfirm === "delete"}
        title={
          bulkConfirm === "archive"
            ? `Archive ${selection.count} project${selection.count === 1 ? "" : "s"}?`
            : bulkConfirm === "restore"
              ? `Restore ${selection.count} project${selection.count === 1 ? "" : "s"}?`
              : `Delete ${selection.count} project${selection.count === 1 ? "" : "s"} permanently?`
        }
        description={
          bulkConfirm === "archive"
            ? "Archived projects become read-only and running timers on them stop. Projects you can't manage are skipped."
            : bulkConfirm === "restore"
              ? "Restored projects become editable again. Projects you can't manage are skipped."
              : "Every task, time log, file, note and milestone of these projects is removed for everyone. This can't be undone."
        }
        confirmLabel={bulkConfirm === "archive" ? "Archive" : bulkConfirm === "restore" ? "Restore" : "Delete permanently"}
        icon={
          bulkConfirm === "archive" ? (
            <LuArchive aria-hidden />
          ) : bulkConfirm === "restore" ? (
            <LuArchiveRestore aria-hidden />
          ) : (
            <LuTrash2 aria-hidden />
          )
        }
        onConfirm={() => bulkConfirm && runBulk(bulkConfirm)}
      />
    </div>
  );
}

/** Admin-only — mounted only for admins so the endpoint never 403s. */
function DepartmentSheetSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const departments = useDepartments();
  return (
    <SheetSelect
      label="Department"
      value={value}
      onChange={onChange}
      options={(departments.data?.departments ?? []).map((department) => ({
        value: department._id,
        label: department.name,
      }))}
    />
  );
}

/** Month ("YYYY-MM") of the structured project name; empty = any. */
function SheetMonth({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} type="month" value={value} onChange={(event) => onChange(event.target.value)} />
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            Any
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">The month in the project name (e.g. Oct2026).</p>
    </div>
  );
}
