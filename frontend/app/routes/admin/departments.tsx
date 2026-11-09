import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Building2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";

import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { MultiSelect } from "@/components/globals/multi-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateDepartment,
  useDeleteDepartment,
  useDepartment,
  useDepartments,
  useSetDepartmentEmployees,
  useUpdateDepartment,
} from "@/hooks/use-departments";
import { usePagination } from "@/hooks/use-pagination";
import { useUsers } from "@/hooks/use-users";
import { getErrorMessage } from "@/lib/api";
import type { Department, DepartmentInput } from "@/types";

import type { Route } from "./+types/departments";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Departments | LPS" }];
}

const PAGE_SIZE = 10;

/**
 * Admin department management: create, edit, delete, and assign employees.
 * Deleting a department unassigns all of its members.
 */
export default function AdminDepartments() {
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: search,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useDepartments({ search: search || undefined, limit: PAGE_SIZE, offset });
  const departments = data?.departments;
  const [formDepartment, setFormDepartment] = useState<Department | "new" | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);
  const [managing, setManaging] = useState<Department | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Departments
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Organize employees into departments and manage membership.
          </p>
        </div>
        <Button onClick={() => setFormDepartment("new")}>
          <Plus />
          New department
        </Button>
      </header>

      <div className="mt-8 space-y-4">
        {isPending ? (
          <DepartmentListSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load departments</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {(total > 0 || search !== "") && (
              <DataTableSearch
                value={search}
                onValueChange={setSearch}
                placeholder="Search departments…"
              />
            )}
            {total > 0 ? (
              <>
                <Card>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Department</TableHead>
                          <TableHead>Members</TableHead>
                          <TableHead>Approvers</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {departments?.map((department) => (
                          <TableRow key={department._id}>
                            <TableCell>
                              <div className="flex items-center gap-3">
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                                  <Building2 className="size-4" />
                                </span>
                                <div className="min-w-0">
                                  <p className="font-medium">{department.name}</p>
                                  {department.description && (
                                    <p className="max-w-xs truncate text-xs text-muted-foreground">
                                      {department.description}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                                <Users className="size-3.5" />
                                {department.memberCount ?? 0}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              {department.approvers?.length || department.heads?.length ? (
                                [...new Set([...(department.approvers ?? []), ...(department.heads ?? [])].map((a) => a.name))].join(", ")
                              ) : (
                                <span className="text-muted-foreground">All admins</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => setManaging(department)}
                                  aria-label={`Manage members of ${department.name}`}
                                >
                                  <Users />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => setFormDepartment(department)}
                                  aria-label={`Edit ${department.name}`}
                                >
                                  <Pencil />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => setDeleting(department)}
                                  aria-label={`Delete ${department.name}`}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <DataTablePagination
                  page={page}
                  limit={PAGE_SIZE}
                  total={total}
                  onPageChange={setPage}
                />
              </>
            ) : search !== "" ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Building2 />
                  </EmptyMedia>
                  <EmptyTitle>No matching departments</EmptyTitle>
                  <EmptyDescription>
                    No departments match &ldquo;{search}&rdquo;. Try a different name or
                    description.
                  </EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              </Empty>
            ) : (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Building2 />
                  </EmptyMedia>
                  <EmptyTitle>No departments yet</EmptyTitle>
                  <EmptyDescription>
                    Create your first department to start grouping employees.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => setFormDepartment("new")}>
                  <Plus />
                  New department
                </Button>
              </Empty>
            )}
          </>
        )}
      </div>

      <DepartmentFormDialog
        open={formDepartment !== null}
        department={formDepartment === "new" ? null : formDepartment}
        onOpenChange={(open) => {
          if (!open) setFormDepartment(null);
        }}
      />
      <ManageMembersDialog
        department={managing}
        onOpenChange={(open) => {
          if (!open) setManaging(null);
        }}
      />
      <DeleteDepartmentDialog
        department={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

function DepartmentListSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading departments">
      <CardContent className="space-y-4 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Create / edit dialog                                                */
/* ------------------------------------------------------------------ */

function DepartmentFormDialog({
  open,
  department,
  onOpenChange,
}: {
  open: boolean;
  /** null = creating a new department. */
  department: Department | null;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const isEdit = department !== null;
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [approvers, setApprovers] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  // Approvers: admins and heads (they can approve anyone's timesheets / time).
  const users = useUsers();
  const approverOptions = (users.data?.users ?? [])
    .filter((u) => u.role === "admin" || u.role === "head")
    .map((u) => ({ value: u._id, label: u.name, description: u.email }));

  useEffect(() => {
    if (open) {
      setName(department?.name ?? "");
      setDescription(department?.description ?? "");
      setApprovers(department?.approvers?.map((a) => a._id) ?? []);
      setSubmitted(false);
    }
  }, [open, department]);

  const nameInvalid = submitted && name.trim() === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim()) return;

    const input: DepartmentInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      ...(isEdit ? { approvers } : {}),
    };

    if (isEdit && department) {
      update.mutate(
        { id: department._id, input },
        { onSuccess: () => onOpenChange(false) }
      );
    } else {
      create.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit department" : "New department"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the department's details."
              : "Create a department to group employees."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="department-name">Name</Label>
            <Input
              id="department-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Engineering"
              autoFocus
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "department-name-error" : undefined}
            />
            {nameInvalid && (
              <p id="department-name-error" className="text-xs text-destructive">
                Name is required.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="department-description">Description</Label>
            <Textarea
              id="department-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What does this department do?"
              rows={3}
            />
          </div>

          {isEdit && (
            <div className="space-y-1.5">
              <Label htmlFor="department-approvers">Approvers</Label>
              <MultiSelect
                id="department-approvers"
                options={approverOptions}
                value={approvers}
                onValueChange={setApprovers}
                max={10}
                placeholder={users.isPending ? "Loading people…" : "Add approvers…"}
                aria-describedby="department-approvers-hint"
              />
              <p id="department-approvers-hint" className="text-xs text-muted-foreground">
                This department&apos;s timesheets, time logs and project / brand scope changes go to
                these people for approval (empty: timesheets and time logs go to every admin, scope
                changes to leadership). Admins and heads only.
              </p>
            </div>
          )}

          {Boolean(error) && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>{isEdit ? "Update failed" : "Creation failed"}</AlertTitle>
              <AlertDescription>{getErrorMessage(error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : isEdit ? (
                <Pencil />
              ) : (
                <Plus />
              )}
              {pending
                ? isEdit
                  ? "Saving…"
                  : "Creating…"
                : isEdit
                  ? "Save changes"
                  : "Create department"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Manage members dialog                                               */
/* ------------------------------------------------------------------ */

function ManageMembersDialog({
  department,
  onOpenChange,
}: {
  department: Department | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = department !== null;
  const { data: detail, isPending: detailPending } = useDepartment(department?._id);
  const {
    data: usersData,
    isPending: usersPending,
    isError: usersError,
    error: usersLoadError,
    refetch,
  } = useUsers();
  const users = usersData?.users;
  const setEmployees = useSetDepartmentEmployees();

  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setSelected(new Set(detail?.members?.map((member) => member._id) ?? []));
    }
  }, [open, detail]);

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  const loading = detailPending || usersPending;

  function handleSave() {
    if (!department) return;
    setEmployees.mutate(
      { id: department._id, userIds: [...selected] },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage members</DialogTitle>
          <DialogDescription>
            Select the employees in {department?.name ?? "this department"}. Unchecked
            members are unassigned.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="space-y-3 p-3" aria-busy="true">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Skeleton className="size-4 rounded-[4px]" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : usersError ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Couldn&apos;t load employees: {getErrorMessage(usersLoadError)}
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                <RefreshCw />
                Retry
              </Button>
            </div>
          ) : users && users.length > 0 ? (
            <ul className="divide-y divide-border">
              {users.map((user) => {
                const checked = selected.has(user._id);
                return (
                  <li key={user._id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(user._id)}
                      />
                      <span className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate text-sm font-medium">{user.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      </span>
                      <Badge
                        variant={
                          user.role === "admin"
                            ? "default"
                            : user.role === "head"
                              ? "secondary"
                              : "outline"
                        }
                        className="capitalize"
                      >
                        {user.role === "head" ? "Head of Dept" : user.role}
                      </Badge>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Users />
                </EmptyMedia>
                <EmptyTitle>No employees to assign</EmptyTitle>
                <EmptyDescription>
                  Create users first, then come back to assign them.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>

        {setEmployees.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t update members</AlertTitle>
            <AlertDescription>{getErrorMessage(setEmployees.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={setEmployees.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={setEmployees.isPending}>
            {setEmployees.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Users />
            )}
            {setEmployees.isPending ? "Saving…" : "Save members"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Delete dialog                                                       */
/* ------------------------------------------------------------------ */

function DeleteDepartmentDialog({
  department,
  onOpenChange,
}: {
  department: Department | null;
  onOpenChange: (open: boolean) => void;
}) {
  const del = useDeleteDepartment();
  const open = department !== null;

  function handleDelete() {
    if (!department) return;
    del.mutate(department._id, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete department?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{department?.name}</span> will be
            deleted and its {department?.memberCount ?? 0} member
            {department?.memberCount === 1 ? "" : "s"} unassigned. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        {del.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t delete department</AlertTitle>
            <AlertDescription>{getErrorMessage(del.error)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={del.isPending}>
            {del.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            {del.isPending ? "Deleting…" : "Delete department"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
