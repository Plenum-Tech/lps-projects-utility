import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowLeft,
  LuCalendar,
  LuChevronDown,
  LuCopy,
  LuEllipsis,
  LuInfo,
  LuLoaderCircle,
  LuPencil,
  LuPin,
  LuPinOff,
  LuTrash2,
  LuUser,
} from "react-icons/lu";

import { FieldError, SwitchRow } from "@/components/projects/project-fields";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import {
  LegacyNameBadge,
  ProgressRing,
  ProjectStatusPill,
  ShortCode,
} from "@/components/projects/project-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjectStatuses } from "@/hooks/use-project-meta";
import {
  useArchiveProject,
  useChangeProjectStatus,
  useDeleteProject,
  useDuplicateProject,
  useTogglePin,
} from "@/hooks/use-projects";
import { PROJECT_CODE_PATTERN, statusColor } from "@/lib/projects";
import { formatDateOnly } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Project, ProjectPermissions } from "@/types";

type DialogKind = "edit" | "duplicate" | "archive" | "restore" | "delete" | null;

/** Project title block + permission-driven actions. */
export function ProjectHeader({
  project,
  permissions,
}: {
  project: Project;
  permissions: ProjectPermissions;
}) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const statuses = useProjectStatuses();
  const changeStatus = useChangeProjectStatus();
  const togglePin = useTogglePin();
  const archived = Boolean(project.archivedAt);

  const statusTargets = (statuses.data ?? []).filter(
    (status) => status.active && status._id !== project.status._id
  );
  const close = () => setDialog(null);

  const hasMenu =
    permissions.canDuplicate ||
    permissions.canArchive ||
    permissions.canRestore ||
    permissions.canDelete;

  return (
    <div className="space-y-4">
      <Link
        to="/projects"
        className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LuArrowLeft aria-hidden className="size-4" />
        All projects
      </Link>

      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <ProgressRing value={project.progress} size={60} stroke={5} />
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ShortCode code={project.code} />
              <ProjectStatusPill status={project.status} />
              {!project.naming && <LegacyNameBadge />}
              {archived && (
                <Badge variant="outline" className="gap-1">
                  <LuArchive aria-hidden className="size-3" />
                  Archived
                </Badge>
              )}
              {project.pinned && (
                <span className="inline-flex items-center gap-1 text-xs text-primary">
                  <LuPin aria-hidden className="size-3" />
                  Pinned
                </span>
              )}
            </div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight break-words text-foreground sm:text-3xl">
              {project.name}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LuUser aria-hidden className="size-4" />
                {project.manager ? project.manager.name : "No manager"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5",
                  project.isOverdue && "font-medium text-destructive"
                )}
              >
                <LuCalendar aria-hidden className="size-4" />
                {project.deadline
                  ? `Due ${formatDateOnly(project.deadline, true)}`
                  : "No deadline"}
                {project.isOverdue && " · overdue"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => togglePin.mutate({ id: project._id, pinned: !project.pinned })}
            disabled={togglePin.isPending}
            aria-pressed={project.pinned}
          >
            {project.pinned ? <LuPinOff aria-hidden /> : <LuPin aria-hidden />}
            {project.pinned ? "Unpin" : "Pin"}
          </Button>

          {permissions.canChangeStatus && !archived && statusTargets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" disabled={changeStatus.isPending} />}
              >
                {changeStatus.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", statusColor(project.status.color).dot)}
                  />
                )}
                Change status
                <LuChevronDown aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Move to</DropdownMenuLabel>
                  {statusTargets.map((status) => (
                    <DropdownMenuItem
                      key={status._id}
                      onClick={() => changeStatus.mutate({ id: project._id, status: status._id })}
                    >
                      <span
                        aria-hidden
                        className={cn("size-2 rounded-full", statusColor(status.color).dot)}
                      />
                      {status.name}
                      {status.isCompleted && (
                        <span className="ml-auto text-xs text-muted-foreground">Completes</span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {permissions.canEdit && !archived && (
            <Button size="sm" onClick={() => setDialog("edit")}>
              <LuPencil aria-hidden />
              Edit
            </Button>
          )}

          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon-sm" aria-label="More actions" />}
              >
                <LuEllipsis aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  {permissions.canDuplicate && (
                    <DropdownMenuItem onClick={() => setDialog("duplicate")}>
                      <LuCopy aria-hidden />
                      Duplicate
                    </DropdownMenuItem>
                  )}
                  {permissions.canArchive && !archived && (
                    <DropdownMenuItem onClick={() => setDialog("archive")}>
                      <LuArchive aria-hidden />
                      Archive
                    </DropdownMenuItem>
                  )}
                  {permissions.canRestore && archived && (
                    <DropdownMenuItem onClick={() => setDialog("restore")}>
                      <LuArchiveRestore aria-hidden />
                      Restore
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                {permissions.canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
                      <LuTrash2 aria-hidden />
                      Delete permanently
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {archived && (
        <Alert>
          <LuInfo aria-hidden className="size-4" />
          <AlertTitle>This project is archived</AlertTitle>
          <AlertDescription>
            It&apos;s read-only — tasks, milestones, notes and files can&apos;t be changed and no
            time can be logged.
            {permissions.canRestore && " Restore it to continue working."}
          </AlertDescription>
        </Alert>
      )}

      {permissions.canEdit && (
        <ProjectFormDialog
          open={dialog === "edit"}
          onOpenChange={(open) => !open && close()}
          project={project}
          canViewRates={permissions.canViewRates}
        />
      )}
      {permissions.canDuplicate && (
        <DuplicateProjectDialog
          project={project}
          open={dialog === "duplicate"}
          onOpenChange={(open) => !open && close()}
        />
      )}
      <ArchiveDialog
        project={project}
        archive={dialog === "archive"}
        open={dialog === "archive" || dialog === "restore"}
        onOpenChange={(open) => !open && close()}
      />
      {permissions.canDelete && (
        <DeleteProjectDialog
          project={project}
          open={dialog === "delete"}
          onOpenChange={(open) => !open && close()}
        />
      )}
    </div>
  );
}

export function ArchiveDialog({
  project,
  archive,
  open,
  onOpenChange,
}: {
  project: Project;
  archive: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useArchiveProject();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archive ? "Archive this project?" : "Restore this project?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {archive
              ? `${project.name} becomes read-only and any running timers on it are stopped. You can restore it later.`
              : `${project.name} becomes editable again and the team can log time on it.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { id: project._id, archive },
                { onSuccess: () => onOpenChange(false) }
              )
            }
          >
            {mutation.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : archive ? (
              <LuArchive aria-hidden />
            ) : (
              <LuArchiveRestore aria-hidden />
            )}
            {archive ? "Archive" : "Restore"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
  onDeleted,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Defaults to navigating back to /projects (detail page). */
  onDeleted?: () => void;
}) {
  const remove = useDeleteProject();
  const navigate = useNavigate();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !remove.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {project.code} permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            {project.name} and all of its tasks, time logs, files, notes, milestones and activity
            will be removed for everyone. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(project._id, {
                onSuccess: () => {
                  onOpenChange(false);
                  if (onDeleted) onDeleted();
                  else void navigate("/projects");
                },
              })
            }
          >
            {remove.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuTrash2 aria-hidden />
            )}
            Delete permanently
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DuplicateProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const duplicate = useDuplicateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [includeTasks, setIncludeTasks] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [deadline, setDeadline] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(`${project.name} (copy)`);
    setCode(`${project.code}2`.slice(0, 10));
    setIncludeTasks(false);
    setStartDate("");
    setDeadline("");
    setSubmitted(false);
  }, [open, project.name, project.code]);

  const codeError = PROJECT_CODE_PATTERN.test(code) ? null : "2–10 uppercase letters or digits.";
  const nameError = name.trim() ? null : "A name is required.";
  const datesError =
    startDate && deadline && deadline < startDate
      ? "The deadline can't be before the start date."
      : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (codeError || nameError || datesError) return;
    duplicate.mutate(
      {
        id: project._id,
        input: {
          name: name.trim(),
          code,
          includeTasks,
          ...(startDate ? { startDate } : {}),
          ...(deadline ? { deadline } : {}),
        },
      },
      {
        onSuccess: (data) => {
          onOpenChange(false);
          void navigate(`/projects/${data.project._id}`);
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !duplicate.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Duplicate project</DialogTitle>
          <DialogDescription>
            Copies settings, members, rates and milestones. Tasks are optional and start as To do.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1.5">
              <Label htmlFor="duplicate-name">Name</Label>
              <Input
                id="duplicate-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                aria-invalid={(submitted && Boolean(nameError)) || undefined}
                autoFocus
              />
              {submitted && nameError && <FieldError>{nameError}</FieldError>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="duplicate-code">Code</Label>
              <Input
                id="duplicate-code"
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
                maxLength={10}
                className="font-mono uppercase"
                aria-invalid={(submitted && Boolean(codeError)) || undefined}
              />
              {submitted && codeError && <FieldError>{codeError}</FieldError>}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="duplicate-start">
                Start date <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="duplicate-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="duplicate-deadline">
                Deadline <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="duplicate-deadline"
                type="date"
                value={deadline}
                min={startDate || undefined}
                onChange={(event) => setDeadline(event.target.value)}
                aria-invalid={(submitted && Boolean(datesError)) || undefined}
              />
            </div>
            {submitted && datesError && (
              <div className="sm:col-span-2">
                <FieldError>{datesError}</FieldError>
              </div>
            )}
          </div>
          <SwitchRow
            id="duplicate-tasks"
            label="Include tasks"
            description="Copy every task with its subtasks (new codes, status reset to To do)."
            checked={includeTasks}
            onCheckedChange={setIncludeTasks}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={duplicate.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={duplicate.isPending}>
              {duplicate.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuCopy aria-hidden />
              )}
              Duplicate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
