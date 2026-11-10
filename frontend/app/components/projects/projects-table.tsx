import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  LuArchive,
  LuArchiveRestore,
  LuCopy,
  LuEye,
  LuPencil,
  LuPin,
  LuPinOff,
  LuTrash2,
} from "react-icons/lu";

import { AvatarStack } from "@/components/globals/data-table/avatar-stack";
import { InlineStatus, type StatusOption } from "@/components/globals/data-table/inline-status";
import { RowActions, type RowAction } from "@/components/globals/data-table/row-actions";
import {
  DataTable,
  MobileField,
  type DataTableColumn,
} from "@/components/globals/data-table/table";
import { LegacyNameBadge, ShortCode } from "@/components/projects/project-badges";
import { useChangeProjectStatus, useTogglePin } from "@/hooks/use-projects";
import type { RowSelection, SortDir } from "@/hooks/use-table-state";
import { canManageProjectClient, progressTone, statusColor } from "@/lib/projects";
import { brandWithOrg, formatDMY } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Project, ProjectStatus, Role } from "@/types";
import { ProjectApprovalBadge } from "@/components/projects/project-approval";

export type ProjectDialogKind = "edit" | "duplicate" | "archive" | "restore" | "delete";

/** Progress bar with the % inside its fill: red < 50, amber 50–79, green ≥ 80. */
export function ProjectProgressBar({ value, className }: { value: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const tone = progressTone(clamped);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-label={`Progress ${clamped}% (${tone.label.toLowerCase()})`}
      className={cn("relative h-5 w-full min-w-28 overflow-hidden rounded-md bg-muted", className)}
    >
      <div
        className={cn("absolute inset-y-0 left-0 transition-[width] duration-200 ease-out", tone.fill)}
        style={{ width: `${clamped}%` }}
      >
        <span aria-hidden className={cn("absolute inset-y-0 right-0 w-0.5", clamped > 0 && tone.edge)} />
      </div>
      <span className="relative flex h-full items-center px-2 text-[0.7rem] font-semibold text-foreground tabular-nums">
        {clamped}%
      </span>
    </div>
  );
}

function DeadlineCell({ project }: { project: Project }) {
  if (!project.deadline) return <span className="text-xs text-muted-foreground">No deadline</span>;
  const overdue = project.isOverdue && !project.status.isCompleted;
  return (
    <span className={cn("text-sm tabular-nums", overdue ? "font-medium text-destructive" : "text-foreground")}>
      {formatDMY(project.deadline)}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

export function ProjectsTable({
  projects,
  total,
  loading,
  error,
  onRetry,
  retrying,
  dimmed,
  selection,
  sort,
  dir,
  onSort,
  statuses,
  me,
  onDialog,
  empty,
  footer,
}: {
  projects: Project[] | undefined;
  total: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  dimmed: boolean;
  selection: RowSelection;
  sort: string;
  dir: SortDir;
  onSort: (field: string) => void;
  statuses: ProjectStatus[];
  me: { _id: string; role: Role };
  onDialog: (kind: ProjectDialogKind, project: Project) => void;
  empty: ReactNode;
  footer: ReactNode;
}) {
  const changeStatus = useChangeProjectStatus();
  const togglePin = useTogglePin();
  const navigate = useNavigate();

  const statusOptions: StatusOption[] = statuses.map((status) => ({
    value: status._id,
    label: status.name,
    dot: statusColor(status.color).dot,
  }));
  const activeIds = statuses.filter((status) => status.active).map((status) => status._id);

  function statusCell(project: Project) {
    const manage = canManageProjectClient(project, me) && !project.archivedAt;
    // The project's own status may be inactive — keep it renderable.
    const options = statusOptions.some((option) => option.value === project.status._id)
      ? statusOptions
      : [
          ...statusOptions,
          {
            value: project.status._id,
            label: project.status.name,
            dot: statusColor(project.status.color).dot,
          },
        ];
    return (
      <InlineStatus
        value={project.status._id}
        options={options}
        allowed={manage ? activeIds : []}
        onChange={(status) => changeStatus.mutateAsync({ id: project._id, status })}
        label={`Change status of ${project.code}`}
      />
    );
  }

  function actions(project: Project): RowAction[] {
    const manage = canManageProjectClient(project, me);
    const archived = Boolean(project.archivedAt);
    const list: RowAction[] = [
      { label: "View", icon: LuEye, onSelect: () => void navigate(`/projects/${project._id}`) },
    ];
    if (manage && !archived) {
      list.push({ label: "Edit", icon: LuPencil, onSelect: () => onDialog("edit", project) });
    }
    list.push({
      label: project.pinned ? "Unpin" : "Pin",
      icon: project.pinned ? LuPinOff : LuPin,
      onSelect: () => togglePin.mutate({ id: project._id, pinned: !project.pinned }),
    });
    // Mirrors permissions.canDuplicate: admins, or heads managing the project.
    if (manage && (me.role === "admin" || me.role === "head")) {
      list.push({ label: "Duplicate", icon: LuCopy, onSelect: () => onDialog("duplicate", project) });
    }
    if (manage && !archived) {
      list.push({ label: "Archive", icon: LuArchive, onSelect: () => onDialog("archive", project) });
    }
    if (manage && archived) {
      list.push({ label: "Restore", icon: LuArchiveRestore, onSelect: () => onDialog("restore", project) });
    }
    // Admins: archived projects, or empty ones (the server refuses projects with tasks / time).
    if (me.role === "admin") {
      list.push({
        label: "Delete",
        icon: LuTrash2,
        variant: "destructive",
        separated: true,
        onSelect: () => onDialog("delete", project),
      });
    }
    return list;
  }

  const columns: DataTableColumn<Project>[] = [
    {
      id: "code",
      header: "Code",
      sortKey: "code",
      className: "pt-3",
      cell: (project) => <ShortCode code={project.code} />,
    },
    {
      id: "name",
      header: "Project name",
      sortKey: "name",
      className: "min-w-56 max-w-80 whitespace-normal",
      cell: (project) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Link
              to={`/projects/${project._id}`}
              className="truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
            >
              {project.name}
            </Link>
            {project.pinned && (
              <LuPin aria-label="Pinned" className="size-3.5 shrink-0 text-primary" />
            )}
            {!project.naming && <LegacyNameBadge />}
            <ProjectApprovalBadge project={project} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {project.tag && <span className="font-mono">{project.tag} · </span>}
            {project.brand ? brandWithOrg(project.brand) : "No brand"} · {project.migratedFrom ? "Migrated" : "New"}
          </p>
        </div>
      ),
    },
    {
      id: "members",
      header: "Members",
      className: "pt-3",
      cell: (project) => (
        <AvatarStack users={project.members.map((member) => member.user)} label="Members" />
      ),
    },
    {
      id: "start",
      header: "Start date",
      sortKey: "startDate",
      className: "pt-3 tabular-nums",
      cell: (project) => formatDMY(project.startDate),
    },
    {
      id: "deadline",
      header: "Deadline",
      sortKey: "deadline",
      className: "pt-3",
      cell: (project) => <DeadlineCell project={project} />,
    },
    {
      id: "status",
      header: "Status",
      sortKeys: [
        { key: "progress", label: "Progress" },
        { key: "status", label: "Status" },
      ],
      className: "w-44 pt-2.5",
      cell: (project) => (
        <div className="space-y-1">
          <ProjectProgressBar value={project.progress} />
          {statusCell(project)}
        </div>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-12 pt-2 text-right",
      headClassName: "text-right",
      cell: (project) => (
        <RowActions label={`Actions for ${project.code}`} actions={actions(project)} />
      ),
    },
  ];

  return (
    <DataTable
      caption={`Projects, ${total} total`}
      columns={columns}
      rows={projects}
      getRowId={(project) => project._id}
      getRowLabel={(project) => `${project.code} ${project.name}`}
      selection={selection}
      sort={sort}
      dir={dir}
      onSort={onSort}
      loading={loading}
      error={error}
      onRetry={onRetry}
      retrying={retrying}
      errorTitle="Couldn't load projects"
      dimmed={dimmed}
      empty={empty}
      footer={footer}
      rowClassName={(project) => (project.archivedAt ? "bg-muted/20" : undefined)}
      mobileCard={(project) => (
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <ShortCode code={project.code} />
                {project.pinned && <LuPin aria-label="Pinned" className="size-3.5 text-primary" />}
                {!project.naming && <LegacyNameBadge />}
                <ProjectApprovalBadge project={project} />
              </div>
              <Link
                to={`/projects/${project._id}`}
                className="mt-1 block font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
              >
                {project.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                {project.brand ? brandWithOrg(project.brand) : "No brand"} · {project.migratedFrom ? "Migrated" : "New"}
              </p>
            </div>
            <RowActions label={`Actions for ${project.code}`} actions={actions(project)} />
          </div>
          <ProjectProgressBar value={project.progress} />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <MobileField label="Start date">{formatDMY(project.startDate)}</MobileField>
            <MobileField label="Deadline">
              <DeadlineCell project={project} />
            </MobileField>
            <MobileField label="Members">
              <AvatarStack users={project.members.map((member) => member.user)} label="Members" />
            </MobileField>
            <MobileField label="Status">{statusCell(project)}</MobileField>
          </dl>
        </div>
      )}
    />
  );
}
