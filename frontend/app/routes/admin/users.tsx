import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Building2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { LuMailPlus, LuMails, LuUsers } from "react-icons/lu";
import { useSearchParams } from "react-router";

import { formatDate } from "@/lib/format";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { FilterSelect } from "@/components/globals/filter-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InvitationsTable } from "@/components/users/invitations-table";
import {
  EmploymentFields,
  employmentFormFrom,
  employmentPayload,
  validateEmployment,
  type EmploymentForm,
} from "@/components/users/employment-fields";
import { InviteDialog } from "@/components/users/invite-dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDepartments } from "@/hooks/use-departments";
import { usePagination } from "@/hooks/use-pagination";
import {
  useCreateUser,
  useDeleteUser,
  useUpdateUser,
  useUsers,
} from "@/hooks/use-users";
import { getErrorMessage } from "@/lib/api";
import type { CreateUserInput, Role, UpdateUserInput, User } from "@/types";

import type { Route } from "./+types/users";

/** Sentinel for the department select's "no department" option. */
const NO_DEPARTMENT = "__none__";

const PAGE_SIZE = 10;

export function meta({}: Route.MetaArgs) {
  return [{ title: "Manage Users | LPS" }];
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

type UsersPageTab = "users" | "invitations";

const ROLE_FILTER_OPTIONS = [
  { value: "employee", label: "Employee" },
  { value: "head", label: "Head of Dept" },
  { value: "admin", label: "Admin" },
];

/**
 * Admin employee management: create, read, update, and delete user records,
 * plus email invitations (Invitations tab, `?tab=invitations`).
 * Role and department assignment live here; employees manage only their own
 * name/password on the profile page.
 */
export default function AdminUsers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: UsersPageTab = searchParams.get("tab") === "invitations" ? "invitations" : "users";
  const [formUser, setFormUser] = useState<User | "new" | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const changeTab = useCallback(
    (next: UsersPageTab) => {
      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          if (next === "users") updated.delete("tab");
          else updated.set("tab", next);
          return updated;
        },
        { preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            Manage Users
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Invite people by email or create accounts directly, and manage roles and access.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setFormUser("new")}>
            <Plus />
            New user
          </Button>
          <Button onClick={() => setInviteOpen(true)}>
            <LuMailPlus aria-hidden />
            Invite people
          </Button>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => changeTab(value === "invitations" ? "invitations" : "users")}
        className="mt-6 gap-5"
      >
        <TabsList variant="line" className="w-full justify-start border-b pb-0.5">
          <TabsTrigger value="users" className="flex-none px-2.5">
            <LuUsers aria-hidden />
            Users
          </TabsTrigger>
          <TabsTrigger value="invitations" className="flex-none px-2.5">
            <LuMails aria-hidden />
            Invitations
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          {tab === "users" && <UsersTab onEdit={setFormUser} />}
        </TabsContent>
        <TabsContent value="invitations">
          {tab === "invitations" && <InvitationsTable onInvite={() => setInviteOpen(true)} />}
        </TabsContent>
      </Tabs>

      <UserFormDialog
        open={formUser !== null}
        user={formUser === "new" ? null : formUser}
        onOpenChange={(open) => {
          if (!open) setFormUser(null);
        }}
      />
      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onViewInvitations={() => changeTab("invitations")}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Users tab                                                           */
/* ------------------------------------------------------------------ */

function UsersTab({ onEdit }: { onEdit: (user: User | "new") => void }) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const filtered = search !== "" || roleFilter !== "" || departmentFilter !== "";
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: `${search}|${roleFilter}|${departmentFilter}`,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useUsers({
    search: search || undefined,
    role: roleFilter || undefined,
    department: departmentFilter || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const users = data?.users;
  const { data: departmentsData } = useDepartments();

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);
  const { data: currentUser } = useCurrentUser();
  const [deleting, setDeleting] = useState<User | null>(null);

  const departmentName = (id?: string | null) =>
    departmentsData?.departments.find((department) => department._id === id)?.name;
  const departmentFilterOptions = useMemo(
    () => [
      { value: "none", label: "Unassigned" },
      ...(departmentsData?.departments ?? []).map((department) => ({
        value: department._id,
        label: department.name,
      })),
    ],
    [departmentsData]
  );
  const clearFilters = () => {
    setSearch("");
    setRoleFilter("");
    setDepartmentFilter("");
  };

  return (
    <div>
      <div className="space-y-4">
        {isPending ? (
          <UserListSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load users</AlertTitle>
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
            {(total > 0 || filtered) && (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <DataTableSearch
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search by name or email…"
                  className="sm:max-w-xs sm:flex-1"
                />
                <div className="flex flex-wrap gap-2">
                  <FilterSelect
                    label="Role"
                    value={roleFilter}
                    onChange={setRoleFilter}
                    options={ROLE_FILTER_OPTIONS}
                  />
                  <FilterSelect
                    label="Department"
                    value={departmentFilter}
                    onChange={setDepartmentFilter}
                    options={departmentFilterOptions}
                  />
                </div>
              </div>
            )}
            {total > 0 ? (
              <>
                <Card>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Employee</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead>Department</TableHead>
                            <TableHead>Joined</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {users?.map((user) => {
                            const isSelf = user._id === currentUser?._id;
                            return (
                              <TableRow key={user._id}>
                                <TableCell>
                                  <div className="flex items-center gap-3">
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                                      {initials(user.name)}
                                    </span>
                                    <div className="min-w-0">
                                      <p className="flex items-center gap-2 font-medium">
                                        <span className="truncate">{user.name}</span>
                                        {isSelf && (
                                          <Badge variant="outline" className="shrink-0">
                                            You
                                          </Badge>
                                        )}
                                      </p>
                                      <p className="truncate text-xs text-muted-foreground">
                                        {user.email}
                                      </p>
                                      {(user.employeeId || user.designation) && (
                                        <p className="truncate text-xs text-muted-foreground">
                                          {user.employeeId && (
                                            <span className="font-mono">{user.employeeId}</span>
                                          )}
                                          {user.employeeId && user.designation ? " · " : ""}
                                          {user.designation}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell>
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
                                </TableCell>
                                <TableCell>
                                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                                    <Building2 className="size-3.5" />
                                    {departmentName(user.department) ?? "Unassigned"}
                                  </span>
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                  {formatDate(user.createdAt)}
                                </TableCell>
                                <TableCell>
                                  <div className="flex justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() => onEdit(user)}
                                      aria-label={`Edit ${user.name}`}
                                    >
                                      <Pencil />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() => setDeleting(user)}
                                      disabled={isSelf}
                                      aria-label={
                                        isSelf
                                          ? "You cannot delete your own account"
                                          : `Delete ${user.name}`
                                      }
                                    >
                                      <Trash2 />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
                <DataTablePagination
                  page={page}
                  limit={PAGE_SIZE}
                  total={total}
                  onPageChange={setPage}
                />
              </>
            ) : filtered ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle>No matching users</EmptyTitle>
                  <EmptyDescription>
                    {search !== "" ? (
                      <>No users match &ldquo;{search}&rdquo; with these filters.</>
                    ) : (
                      "No users match these filters."
                    )}
                  </EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </Empty>
            ) : (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle>No users yet</EmptyTitle>
                  <EmptyDescription>
                    Create your first employee account to get started.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => onEdit("new")}>
                  <Plus />
                  New user
                </Button>
              </Empty>
            )}
          </>
        )}
      </div>

      <DeleteUserDialog
        user={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </div>
  );
}

function UserListSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading users">
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

function UserFormDialog({
  open,
  user,
  onOpenChange,
}: {
  open: boolean;
  /** null = creating a new user. */
  user: User | null;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateUser();
  const update = useUpdateUser();
  const { data: departmentsData } = useDepartments();
  const { data: currentUser } = useCurrentUser();
  const isEdit = user !== null;
  const isSelf = isEdit && user?._id === currentUser?._id;
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("employee");
  const [department, setDepartment] = useState<string>(NO_DEPARTMENT);
  const [password, setPassword] = useState("");
  const [hourlyRate, setHourlyRate] = useState("0");
  const [employment, setEmployment] = useState<EmploymentForm>(() => employmentFormFrom(null));
  const [submitted, setSubmitted] = useState(false);

  const departmentOptions = useMemo(
    () =>
      (departmentsData?.departments ?? []).map((item) => ({
        value: item._id,
        label: item.name,
      })),
    [departmentsData]
  );
  const selectedDepartment =
    department === NO_DEPARTMENT
      ? null
      : (departmentOptions.find((option) => option.value === department) ?? null);

  useEffect(() => {
    if (open) {
      setName(user?.name ?? "");
      setEmail(user?.email ?? "");
      setRole(user?.role ?? "employee");
      setDepartment(user?.department ?? NO_DEPARTMENT);
      setPassword("");
      setHourlyRate(String(user?.hourlyRate ?? 0));
      setEmployment(employmentFormFrom(user));
      setSubmitted(false);
      create.reset();
      update.reset();
    }
  }, [open, user]);

  const nameInvalid = submitted && name.trim() === "";
  const emailInvalid = submitted && !/^\S+@\S+\.\S+$/.test(email.trim());
  const passwordInvalid =
    submitted && (isEdit ? password !== "" && password.length < 8 : password.length < 8);
  // A head of department must have a department — the backend enforces this too.
  const headDepartmentInvalid = submitted && role === "head" && department === NO_DEPARTMENT;
  const rateValue = hourlyRate.trim() === "" ? 0 : Number(hourlyRate);
  const rateValid = Number.isFinite(rateValue) && rateValue >= 0 && rateValue <= 100000;
  const rateInvalid = submitted && !rateValid;
  const employmentErrors = validateEmployment(employment, isEdit);
  const errorMessage = error ? getErrorMessage(error) : null;
  // 409 duplicate employee ID → show it on the field instead of the generic alert.
  const duplicateEmployeeId = errorMessage !== null && /employee id/i.test(errorMessage);
  const shownEmploymentErrors = submitted
    ? {
        ...employmentErrors,
        employeeId: employmentErrors.employeeId ?? (duplicateEmployeeId ? errorMessage : undefined),
      }
    : {};

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);

    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email.trim())) return;
    if (isEdit ? password !== "" && password.length < 8 : password.length < 8) return;
    if (role === "head" && department === NO_DEPARTMENT) return;
    if (!rateValid) return;
    if (Object.keys(employmentErrors).length > 0) return;

    const departmentValue: string | null =
      department === NO_DEPARTMENT ? null : department;

    if (isEdit && user) {
      const input: UpdateUserInput = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        role,
        department: departmentValue,
      };
      if (password) input.password = password;
      if (rateValue !== (user.hourlyRate ?? 0)) input.hourlyRate = rateValue;
      Object.assign(input, employmentPayload(employment, user));
      update.mutate({ id: user._id, input }, { onSuccess: () => onOpenChange(false) });
    } else {
      const input: CreateUserInput = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
        department: departmentValue,
        hourlyRate: rateValue,
        ...employmentPayload(employment, null),
      };
      create.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit user" : "New user"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the user's account details."
              : "Create an account for an employee or administrator."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="user-name">Name</Label>
            <Input
              id="user-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jane Doe"
              autoFocus
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "user-name-error" : undefined}
            />
            {nameInvalid && (
              <p id="user-name-error" className="text-xs text-destructive">
                Name is required.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-email">Email</Label>
            <Input
              id="user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="jane@company.com"
              aria-invalid={emailInvalid}
              aria-describedby={emailInvalid ? "user-email-error" : undefined}
            />
            {emailInvalid && (
              <p id="user-email-error" className="text-xs text-destructive">
                Enter a valid email address.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="user-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole(value as Role)}
                disabled={isSelf}
                items={{ employee: "Employee", head: "Head of Department", admin: "Admin" }}
              >
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="employee">Employee</SelectItem>
                  <SelectItem value="head">Head of Department</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              {isSelf && (
                <p className="text-xs text-muted-foreground">
                  You can&apos;t change your own role.
                </p>
              )}
              {role === "head" && (
                <p className="text-xs text-muted-foreground">
                  A head of department must have a department assigned.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="user-department">Department</Label>
              <Combobox
                items={departmentOptions}
                value={selectedDepartment}
                onValueChange={(item) => setDepartment(item?.value ?? NO_DEPARTMENT)}
                autoHighlight
              >
                <ComboboxInput
                  id="user-department"
                  placeholder="Search departments…"
                  className="w-full"
                  showClear
                />
                <ComboboxContent sideOffset={4}>
                  <ComboboxEmpty>No departments found.</ComboboxEmpty>
                  <ComboboxList>
                    {(item) => (
                      <ComboboxItem key={item.value} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {headDepartmentInvalid && (
                <p id="user-department-error" className="text-xs text-destructive">
                  A head of department must be assigned to a department.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-hourly-rate">Hourly rate</Label>
            <Input
              id="user-hourly-rate"
              type="number"
              inputMode="decimal"
              min={0}
              max={100000}
              step="0.01"
              value={hourlyRate}
              onChange={(event) => setHourlyRate(event.target.value)}
              aria-invalid={rateInvalid}
              aria-describedby="user-hourly-rate-hint"
            />
            <p
              id="user-hourly-rate-hint"
              className={rateInvalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {rateInvalid
                ? "Enter a rate between 0 and 100,000."
                : "Default rate for time-log earnings. A project member rate above 0 overrides it."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-password">Password</Label>
            <Input
              id="user-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                isEdit ? "Leave blank to keep the current password" : "At least 8 characters"
              }
              autoComplete="new-password"
              aria-invalid={passwordInvalid}
              aria-describedby={passwordInvalid ? "user-password-error" : undefined}
            />
            {passwordInvalid && (
              <p id="user-password-error" className="text-xs text-destructive">
                Password must be at least 8 characters.
              </p>
            )}
          </div>

          <EmploymentFields
            form={employment}
            onChange={(patch) => {
              setEmployment((current) => ({ ...current, ...patch }));
              if (patch.employeeId !== undefined && duplicateEmployeeId) {
                create.reset();
                update.reset();
              }
            }}
            errors={shownEmploymentErrors}
            isEdit={isEdit}
          />

          {Boolean(error) && !duplicateEmployeeId && (
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
                  : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Delete dialog                                                       */
/* ------------------------------------------------------------------ */

function DeleteUserDialog({
  user,
  onOpenChange,
}: {
  user: User | null;
  onOpenChange: (open: boolean) => void;
}) {
  const del = useDeleteUser();
  const open = user !== null;

  function handleDelete() {
    if (!user) return;
    del.mutate(user._id, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete user?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{user?.name}</span> (
            {user?.email}) will be permanently removed. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        {del.isError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t delete user</AlertTitle>
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
            {del.isPending ? "Deleting…" : "Delete user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
