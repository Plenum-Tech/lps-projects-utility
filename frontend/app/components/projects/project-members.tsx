import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  LuCheck,
  LuLoaderCircle,
  LuPencil,
  LuUserMinus,
  LuUserPlus,
  LuUsers,
  LuX,
} from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { EmptyState } from "@/components/globals/query-states";
import { FieldError } from "@/components/projects/project-fields";
import { UserAvatar } from "@/components/tasks/task-badges";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  openTasksFromError,
  useAddProjectMembers,
  useProjectAssignable,
  useRemoveProjectMember,
  useUpdateMemberRate,
} from "@/hooks/use-projects";
import { formatDateOnly } from "@/lib/tasks";
import { formatMoney } from "@/lib/time";
import type { Project, ProjectMember, ProjectPermissions } from "@/types";

const ROLE_LABELS = { admin: "Admin", head: "Head", employee: "Employee" } as const;

/** Members tab: table with rates, add/remove and inline rate editing. */
export function ProjectMembers({
  project,
  permissions,
}: {
  project: Project;
  permissions: ProjectPermissions;
}) {
  const { data: me } = useCurrentUser();
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectMember | null>(null);
  const canManage = permissions.canManageMembers && !project.archivedAt;
  const showRates =
    permissions.canViewRates || project.members.some((member) => member.hourlyRate !== undefined);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            {project.members.length} {project.members.length === 1 ? "person" : "people"} on this
            project.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setAddOpen(true)}>
            <LuUserPlus aria-hidden />
            Add members
          </Button>
        )}
      </div>

      {project.members.length === 0 ? (
        <EmptyState
          icon={LuUsers}
          title="No members yet"
          description="Members can log time, see tasks and collaborate on notes and files."
        >
          {canManage && (
            <Button onClick={() => setAddOpen(true)}>
              <LuUserPlus aria-hidden />
              Add members
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="hidden md:table-cell">Role</TableHead>
                <TableHead className="hidden sm:table-cell">Added</TableHead>
                {showRates && <TableHead className="text-right">Hourly rate</TableHead>}
                {canManage && <TableHead className="w-12"><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {project.members.map((member) => {
                const isManager = project.manager?._id === member.user._id;
                return (
                  <TableRow key={member.user._id}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <UserAvatar user={member.user} size="default" />
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-1.5 font-medium">
                            <span className="truncate">{member.user.name}</span>
                            {member.user._id === me?._id && (
                              <span className="text-xs font-normal text-muted-foreground">(you)</span>
                            )}
                            {isManager && <Badge>Manager</Badge>}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {member.user.email}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {ROLE_LABELS[member.user.role]}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                      {formatDateOnly(member.addedAt, true)}
                    </TableCell>
                    {showRates && (
                      <TableCell className="text-right">
                        {canManage && permissions.canViewRates ? (
                          <RateEditor projectId={project._id} member={member} />
                        ) : member.hourlyRate !== undefined ? (
                          <span className="tabular-nums">{formatMoney(member.hourlyRate)}/h</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    {canManage && (
                      <TableCell>
                        <span
                          className="inline-flex"
                          title={isManager ? "Change the project manager before removing them" : undefined}
                        >
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={isManager}
                            aria-label={
                              isManager
                                ? `${member.user.name} is the manager and can't be removed`
                                : `Remove ${member.user.name}`
                            }
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setRemoving(member)}
                          >
                            <LuUserMinus aria-hidden />
                          </Button>
                        </span>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {canManage && (
        <>
          <AddMembersDialog
            projectId={project._id}
            open={addOpen}
            onOpenChange={setAddOpen}
            canSetRate={permissions.canViewRates}
          />
          <RemoveMemberDialog
            projectId={project._id}
            member={removing}
            onClose={() => setRemoving(null)}
          />
        </>
      )}
    </div>
  );
}

function RateEditor({ projectId, member }: { projectId: string; member: ProjectMember }) {
  const update = useUpdateMemberRate(projectId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const current = member.hourlyRate ?? 0;
  const parsed = Number(value);
  const invalid = value.trim() === "" || !Number.isFinite(parsed) || parsed < 0;

  function save(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    if (parsed === current) {
      setEditing(false);
      return;
    }
    update.mutate(
      { userId: member.user._id, hourlyRate: parsed },
      { onSuccess: () => setEditing(false) }
    );
  }

  if (!editing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="tabular-nums"
        onClick={() => {
          setValue(String(current));
          setEditing(true);
        }}
        aria-label={`Edit hourly rate for ${member.user.name} (currently ${formatMoney(current)})`}
      >
        {formatMoney(current)}/h
        <LuPencil aria-hidden className="text-muted-foreground" />
      </Button>
    );
  }

  return (
    <form onSubmit={save} className="ml-auto flex w-fit items-center gap-1">
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-7 w-24 text-right"
        aria-label={`Hourly rate for ${member.user.name}`}
        aria-invalid={invalid || undefined}
        autoFocus
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        disabled={invalid || update.isPending}
        aria-label="Save rate"
      >
        {update.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCheck aria-hidden />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setEditing(false)}
        disabled={update.isPending}
        aria-label="Cancel"
      >
        <LuX aria-hidden />
      </Button>
    </form>
  );
}

function AddMembersDialog({
  projectId,
  open,
  onOpenChange,
  canSetRate,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canSetRate: boolean;
}) {
  const assignable = useProjectAssignable(projectId, open);
  const add = useAddProjectMembers(projectId);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [rate, setRate] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setUserIds([]);
      setRate("");
      setSubmitted(false);
    }
  }, [open]);

  const options = useMemo<MultiSelectOption[]>(
    () =>
      (assignable.data ?? []).map((user) => ({
        value: user._id,
        label: user.name,
        description: user.email,
      })),
    [assignable.data]
  );

  const rateNumber = Number(rate);
  const rateInvalid = rate.trim() !== "" && (!Number.isFinite(rateNumber) || rateNumber < 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (userIds.length === 0 || rateInvalid) return;
    add.mutate(
      { userIds, ...(rate.trim() !== "" ? { hourlyRate: rateNumber } : {}) },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !add.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>New members are notified and can start logging time.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-members">People</Label>
            <MultiSelect
              id="add-members"
              options={options}
              value={userIds}
              onValueChange={setUserIds}
              placeholder={assignable.isPending ? "Loading people…" : "Search people…"}
              emptyText={
                assignable.isError
                  ? "Couldn't load people."
                  : options.length === 0
                    ? "Everyone available is already a member."
                    : "No one found."
              }
              invalid={submitted && userIds.length === 0}
            />
            {submitted && userIds.length === 0 && <FieldError>Pick at least one person.</FieldError>}
          </div>
          {canSetRate && (
            <div className="space-y-1.5">
              <Label htmlFor="add-members-rate">
                Hourly rate <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="add-members-rate"
                type="number"
                inputMode="decimal"
                min={0}
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                placeholder="Use each person's default rate"
                aria-invalid={rateInvalid || undefined}
              />
              {rateInvalid && <FieldError>Enter a positive number.</FieldError>}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={add.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuUserPlus aria-hidden />
              )}
              Add {userIds.length > 1 ? `${userIds.length} members` : "member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMemberDialog({
  projectId,
  member,
  onClose,
}: {
  projectId: string;
  member: ProjectMember | null;
  onClose: () => void;
}) {
  const remove = useRemoveProjectMember(projectId);
  const [openTasks, setOpenTasks] = useState<number | null>(null);

  useEffect(() => {
    if (member) setOpenTasks(null);
  }, [member]);

  function confirm(force: boolean) {
    if (!member) return;
    remove.mutate(
      { userId: member.user._id, force },
      {
        onSuccess: onClose,
        onError: (error) => {
          const count = openTasksFromError(error);
          if (count !== null) setOpenTasks(count);
        },
      }
    );
  }

  const name = member?.user.name ?? "This member";

  return (
    <AlertDialog
      open={member !== null}
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {openTasks !== null ? "Unassign open tasks?" : `Remove ${name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {openTasks !== null
              ? `${name} has ${openTasks} open ${openTasks === 1 ? "task" : "tasks"} — unassign and remove? Tasks with no other assignee move to the project manager. Their logged time is kept.`
              : `${name} will lose access to this project and any running timer on it is stopped. Logged time is kept.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => confirm(openTasks !== null)}
          >
            {remove.isPending ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuUserMinus aria-hidden />
            )}
            {openTasks !== null ? "Unassign and remove" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
