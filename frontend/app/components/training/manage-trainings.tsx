import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  BellRing,
  Download,
  Eye,
  GraduationCap,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import * as XLSX from "xlsx";

import {
  MultiSelect,
  type MultiSelectOption,
} from "@/components/globals/multi-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { ConvertProgress } from "@/components/training/convert-progress";
import { useDepartments } from "@/hooks/use-departments";
import {
  useAdminTrainings,
  useCreateTraining,
  useDeleteTraining,
  useRemindTraining,
  trainingSourceUrl,
  useTrainingProgress,
  useUpdateTraining,
} from "@/hooks/use-trainings";
import { useUsers } from "@/hooks/use-users";
import { getErrorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { formatDateOnly } from "@/lib/tasks";
import type { AdminTraining, TrainingStatus, TrainingSummary } from "@/types";

const STATUS_LABEL: Record<TrainingStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

/** Admin: create, edit, archive and track trainings. */
export function ManageTrainings() {
  const [showArchived, setShowArchived] = useState(false);
  const query = useAdminTrainings(showArchived);
  const update = useUpdateTraining();
  const remind = useRemindTraining();
  const [form, setForm] = useState<AdminTraining | "new" | null>(null);
  const [progressFor, setProgressFor] = useState<AdminTraining | null>(null);
  const [deleting, setDeleting] = useState<AdminTraining | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(checked) => setShowArchived(checked === true)}
          />
          Show archived
        </label>
        <Button onClick={() => setForm("new")}>
          <Plus />
          New training
        </Button>
      </div>

      {query.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn&apos;t load trainings</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {getErrorMessage(query.error)}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              <RefreshCw />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.data.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GraduationCap />
            </EmptyMedia>
            <EmptyTitle>No trainings</EmptyTitle>
            <EmptyDescription>
              Upload a slide deck and assign it to your team.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Training</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.map((training) => (
                <TableRow
                  key={training._id}
                  className={training.archived ? "opacity-60" : undefined}
                >
                  <TableCell>
                    <Link
                      to={`/training/${training._id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {training.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {training.slideCount} slides ·{" "}
                      {training.sourceFile.filename}
                      {training.mandatory && ` · mandatory (${training.completeWithinDays} ${training.completeWithinDays === 1 ? "day" : "days"})`}
                      {training.archived && " · archived"}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {training.assignAll
                      ? "Everyone"
                      : [
                          training.departments.length > 0 &&
                            `${training.departments.length} dept.`,
                          training.users.length > 0 &&
                            `${training.users.length} people`,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                  </TableCell>
                  <TableCell className="text-sm">
                    {training.dueDate
                      ? formatDateOnly(training.dueDate, true)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    <button
                      type="button"
                      className="rounded-sm underline-offset-4 hover:underline"
                      onClick={() => setProgressFor(training)}
                    >
                      {training.stats.completed} / {training.stats.assigned}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="View slides"
                        render={<Link to={`/training/${training._id}`} />}
                        nativeButton={false}
                      >
                        <Eye />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={`Download ${training.sourceFile.filename}`}
                        render={
                          <a href={trainingSourceUrl(training._id)} download />
                        }
                        nativeButton={false}
                      >
                        <Download />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Progress"
                        onClick={() => setProgressFor(training)}
                      >
                        <Users />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Send reminder"
                        disabled={training.archived || remind.isPending}
                        onClick={() => remind.mutate(training._id)}
                      >
                        <BellRing />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Edit"
                        onClick={() => setForm(training)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={training.archived ? "Restore" : "Archive"}
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({
                            id: training._id,
                            input: { archived: !training.archived },
                          })
                        }
                      >
                        {training.archived ? <ArchiveRestore /> : <Archive />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Delete"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(training)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <TrainingFormDialog
        training={form === "new" ? null : form}
        open={form !== null}
        onOpenChange={(open) => !open && setForm(null)}
      />
      <ProgressDialog
        training={progressFor}
        onOpenChange={(open) => !open && setProgressFor(null)}
      />
      <DeleteDialog
        training={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

type AssignMode = "all" | "departments" | "users";

function TrainingFormDialog({
  training,
  open,
  onOpenChange,
}: {
  training: TrainingSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = training !== null;
  const create = useCreateTraining();
  const update = useUpdateTraining();
  const pending = create.isPending || update.isPending;

  const { data: departmentsData } = useDepartments();
  const { data: usersData } = useUsers();
  const departmentOptions = useMemo<MultiSelectOption[]>(
    () =>
      (departmentsData?.departments ?? []).map((d) => ({
        value: d._id,
        label: d.name,
      })),
    [departmentsData],
  );
  const userOptions = useMemo<MultiSelectOption[]>(
    () =>
      (usersData?.users ?? []).map((u) => ({
        value: u._id,
        label: u.name,
        description: u.email,
      })),
    [usersData],
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [withinDays, setWithinDays] = useState("3");
  const [mode, setMode] = useState<AssignMode>("all");
  const [departments, setDepartments] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [resetProgress, setResetProgress] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);

  // Seed the form when it opens (keyed on the training being edited).
  const seedKey = open ? (training?._id ?? "new") : null;
  if (seedKey !== seeded) {
    setSeeded(seedKey);
    setTitle(training?.title ?? "");
    setDescription(training?.description ?? "");
    setDueDate(training?.dueDate ? training.dueDate.slice(0, 10) : "");
    setMandatory(training?.mandatory ?? false);
    setWithinDays(String(training?.completeWithinDays ?? 3));
    setMode(
      training
        ? training.assignAll
          ? "all"
          : training.departments.length > 0
            ? "departments"
            : "users"
        : "all",
    );
    setDepartments(training?.departments ?? []);
    setUsers(training?.users ?? []);
    setFile(null);
    setResetProgress(true);
    setSubmitted(false);
  }

  const titleInvalid = title.trim().length === 0;
  const fileInvalid = !isEdit && !file;
  const assignInvalid =
    (mode === "departments" && departments.length === 0) ||
    (mode === "users" && users.length === 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (titleInvalid || fileInvalid || assignInvalid) return;
    const input = {
      title: title.trim(),
      description: description.trim(),
      dueDate,
      mandatory,
      completeWithinDays: Math.min(60, Math.max(1, Math.round(Number(withinDays) || 3))),
      assignAll: mode === "all",
      departments: mode === "departments" ? departments : [],
      users: mode === "users" ? users : [],
      file,
      ...(isEdit && file ? { resetProgress } : {}),
    };
    if (isEdit) {
      update.mutate(
        { id: training._id, input },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      create.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit training" : "New training"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the details, or upload a new version of the deck."
              : "Upload a PowerPoint or PDF. Everyone assigned is notified and must read every slide."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="training-title">Title</Label>
            <Input
              id="training-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              aria-invalid={(submitted && titleInvalid) || undefined}
              autoFocus
            />
            {submitted && titleInvalid && (
              <p className="text-xs text-destructive">A title is required.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="training-description">Description</Label>
            <Textarea
              id="training-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="What this training covers and why it matters."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="training-file">
              {isEdit ? "Replace the deck (optional)" : "Slide deck"}
            </Label>
            <Input
              id="training-file"
              type="file"
              accept=".pptx,.ppt,.odp,.pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              aria-invalid={(submitted && fileInvalid) || undefined}
            />
            <p className="text-xs text-muted-foreground">
              PowerPoint (.pptx, .ppt), OpenDocument or PDF, up to 50 MB.
              Converting takes a moment.
            </p>
            {submitted && fileInvalid && (
              <p className="text-xs text-destructive">Upload the slide deck.</p>
            )}
            {isEdit && file && (
              <label className="mt-2 flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  checked={resetProgress}
                  onCheckedChange={(checked) =>
                    setResetProgress(checked === true)
                  }
                  className="mt-0.5"
                />
                <span className="text-sm">
                  Everyone must read the new version
                  <span className="block text-xs text-muted-foreground">
                    Unticked: existing completions are kept; people part-way
                    through start again.
                  </span>
                </span>
              </label>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="training-due">Due date (optional)</Label>
            <Input
              id="training-due"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={mandatory}
                onCheckedChange={(checked) => setMandatory(checked === true)}
                className="mt-0.5"
              />
              <span className="text-sm">
                Mandatory
                <span className="block text-xs text-muted-foreground">
                  Pops up at sign-in until completed. HR is emailed when each person completes it.
                </span>
              </span>
            </label>
            {mandatory && (
              <div className="flex items-center gap-2 pl-6 text-sm">
                <span>Complete within</span>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={withinDays}
                  onChange={(event) => setWithinDays(event.target.value)}
                  className="h-8 w-20"
                  aria-label="Days to complete"
                />
                <span>days of first sign-in</span>
              </div>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Assign to</legend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as AssignMode)}
              className="gap-2"
            >
              {(
                [
                  ["all", "Everyone", "Including people who join later"],
                  ["departments", "Departments", "Current and future members"],
                  ["users", "Specific people", ""],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-2.5"
                >
                  <RadioGroupItem
                    id={`assign-${value}`}
                    value={value}
                    className="mt-0.5"
                  />
                  <span className="text-sm">
                    {label}
                    {hint && (
                      <span className="block text-xs text-muted-foreground">
                        {hint}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </RadioGroup>
            {mode === "departments" && (
              <MultiSelect
                options={departmentOptions}
                value={departments}
                onValueChange={setDepartments}
                placeholder="Choose departments…"
                invalid={submitted && assignInvalid}
              />
            )}
            {mode === "users" && (
              <MultiSelect
                options={userOptions}
                value={users}
                onValueChange={setUsers}
                placeholder="Choose people…"
                invalid={submitted && assignInvalid}
              />
            )}
            {submitted && assignInvalid && (
              <p className="text-xs text-destructive">Choose at least one.</p>
            )}
          </fieldset>
          {pending && file && <ConvertProgress fileSize={file.size} />}
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
              {pending && <LoaderCircle className="animate-spin" />}
              {pending
                ? file
                  ? "Converting…"
                  : "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Publish training"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function ProgressDialog({
  training,
  onOpenChange,
}: {
  training: AdminTraining | null;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useTrainingProgress(training?._id ?? null);
  const remind = useRemindTraining();
  const [status, setStatus] = useState<TrainingStatus | "all">("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter(
      (row) =>
        (status === "all" || row.status === status) &&
        (!needle ||
          row.user.name.toLowerCase().includes(needle) ||
          row.user.email.toLowerCase().includes(needle) ||
          (row.user.department?.name ?? "").toLowerCase().includes(needle)),
    );
  }, [query.data, status, search]);

  function exportExcel() {
    if (!training) return;
    const ws = XLSX.utils.json_to_sheet(
      rows.map((row) => ({
        Name: row.user.name,
        Email: row.user.email,
        Department: row.user.department?.name ?? "",
        Designation: row.user.designation,
        "Slides read": `${row.viewedCount} / ${training.slideCount}`,
        "Slides not read": row.status === "completed" ? "" : (row.missing ?? []).join(", "),
        Status: STATUS_LABEL[row.status],
        Started: row.startedAt ? formatDate(row.startedAt) : "",
        Completed: row.completedAt ? formatDate(row.completedAt) : "",
      })),
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Progress");
    XLSX.writeFile(
      wb,
      `${training.title.replace(/[^\w.-]+/g, "_")}-progress.xlsx`,
    );
  }

  const total = query.data?.rows.length ?? 0;
  const completed =
    query.data?.rows.filter((r) => r.status === "completed").length ?? 0;

  return (
    <Dialog open={training !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{training?.title}</DialogTitle>
          <DialogDescription>
            {completed} of {total} completed
            {training?.dueDate &&
              ` · due ${formatDateOnly(training.dueDate, true)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {(["all", "not_started", "in_progress", "completed"] as const).map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={status === value ? "secondary" : "ghost"}
                  onClick={() => setStatus(value)}
                >
                  {value === "all" ? "All" : STATUS_LABEL[value]}
                </Button>
              ),
            )}
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or department"
            className="h-8 w-full sm:ml-auto sm:w-56"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={exportExcel}
            disabled={rows.length === 0}
          >
            <Download />
            Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !training ||
              training.archived ||
              remind.isPending ||
              completed === total
            }
            onClick={() => training && remind.mutate(training._id)}
          >
            <BellRing />
            Remind pending
          </Button>
        </div>
        {query.isPending ? (
          <Skeleton className="h-40" />
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn&apos;t load progress</AlertTitle>
            <AlertDescription>{getErrorMessage(query.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Read</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      No one matches.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.user._id}>
                      <TableCell>
                        <span className="font-medium">{row.user.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {row.user.designation || row.user.email}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.user.department?.name ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {row.viewedCount} / {training?.slideCount}
                        {row.status !== "completed" && (row.missing?.length ?? 0) > 0 && (
                          <span
                            className="block max-w-56 truncate text-xs text-warn"
                            title={`Not read: slides ${row.missing!.join(", ")}`}
                          >
                            Not read: {row.missing!.length > 12 ? `${row.missing!.slice(0, 12).join(", ")}…` : row.missing!.join(", ")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.status === "completed"
                              ? "default"
                              : row.status === "in_progress"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {STATUS_LABEL[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.completedAt ? formatDate(row.completedAt) : "—"}
                        {row.hrNotifiedAt && (
                          <span
                            className="block text-[11px] text-muted-foreground"
                            title={`HR emailed: ${(row.hrNotifiedTo ?? []).join(", ")}`}
                          >
                            HR emailed {formatDate(row.hrNotifiedAt)} · {(row.hrNotifiedTo ?? []).length} recipient
                            {(row.hrNotifiedTo ?? []).length === 1 ? "" : "s"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function DeleteDialog({
  training,
  onOpenChange,
}: {
  training: AdminTraining | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteTraining();
  return (
    <Dialog
      open={training !== null}
      onOpenChange={(open) => !remove.isPending && onOpenChange(open)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete training?</DialogTitle>
          <DialogDescription>
            &ldquo;{training?.title}&rdquo; and everyone&apos;s completion
            records will be removed permanently. To keep the records, archive it
            instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={remove.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              training &&
              remove.mutate(training._id, {
                onSuccess: () => onOpenChange(false),
              })
            }
          >
            {remove.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Trash2 />
            )}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
