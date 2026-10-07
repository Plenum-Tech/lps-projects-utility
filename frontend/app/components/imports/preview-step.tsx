import { useId, useMemo } from "react";
import { LuDownload, LuLoaderCircle } from "react-icons/lu";

import { ImportRowsGrid, TotalsLine } from "@/components/imports/import-rows";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useDownloadImportErrors } from "@/hooks/use-imports";
import { useProjectOptions } from "@/hooks/use-projects";
import { IMPORT_NOUN, INLINE_IMPORT_ROWS } from "@/lib/imports";
import type { ImportJob, ImportOptions, ImportType, Role } from "@/types";

/** Rows the run will actually create or update. */
export function importableCount(job: ImportJob): number {
  return Math.max(0, job.totals.ready + job.totals.warnings - job.totals.skipped);
}

/**
 * Step 3 — options (re-validated on change), totals, the virtualised row grid
 * and the error report.
 */
export function PreviewStep({
  job,
  type,
  options,
  onOptions,
  validating,
  me,
  defaultProjectLocked,
}: {
  job: ImportJob;
  type: ImportType;
  options: ImportOptions;
  onOptions: (options: ImportOptions) => void;
  validating: boolean;
  me: { _id: string; role: Role };
  /** Opened from a project's Tasks tab — the default project is fixed. */
  defaultProjectLocked?: boolean;
}) {
  const errors = useDownloadImportErrors();
  const { totals } = job;
  const importable = importableCount(job);
  const rows = job.rows ?? [];

  return (
    <div className="space-y-4">
      <ImportOptionsCard
        type={type}
        options={options}
        onOptions={onOptions}
        disabled={validating}
        me={me}
        defaultProjectLocked={defaultProjectLocked}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <TotalsLine
          parts={[
            { label: "ready", count: totals.ready, dot: "bg-primary" },
            { label: totals.warnings === 1 ? "warning" : "warnings", count: totals.warnings, dot: "bg-chart-4" },
            { label: totals.errors === 1 ? "error" : "errors", count: totals.errors, dot: "bg-destructive" },
            ...(totals.skipped > 0
              ? [{ label: "already exist (skipped)", count: totals.skipped, dot: "bg-muted-foreground" }]
              : []),
          ]}
        />
        <div className="flex items-center gap-2">
          {validating && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" />
              Re-checking…
            </span>
          )}
          {job.hasErrorReport && (
            <Button variant="outline" size="sm" onClick={() => errors.mutate(job)} disabled={errors.isPending}>
              {errors.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
              Download error report
            </Button>
          )}
        </div>
      </div>

      <ImportRowsGrid rows={rows} type={type} mode="preview" className={validating ? "opacity-60" : undefined} />

      <p className="text-xs text-muted-foreground">
        {importable === 0
          ? `Nothing to import yet — fix the errors in your file, or change the options above.`
          : `${importable.toLocaleString()} ${importable === 1 ? IMPORT_NOUN[type].one : IMPORT_NOUN[type].many} will be imported. Rows with errors are skipped.${
              importable > INLINE_IMPORT_ROWS ? " This many rows run in the background — you can close the dialog while it works." : ""
            }`}
      </p>
    </div>
  );
}

const NO_PROJECT = "";

function ImportOptionsCard({
  type,
  options,
  onOptions,
  disabled,
  me,
  defaultProjectLocked,
}: {
  type: ImportType;
  options: ImportOptions;
  onOptions: (options: ImportOptions) => void;
  disabled: boolean;
  me: { _id: string; role: Role };
  defaultProjectLocked?: boolean;
}) {
  const id = useId();
  const projects = useProjectOptions(type === "tasks");
  const projectChoices = useMemo(
    () =>
      (projects.data ?? []).filter(
        (project) =>
          (!project.archivedAt && (me.role !== "employee" || project.manager?._id === me._id)) ||
          project._id === options.defaultProject
      ),
    [projects.data, me, options.defaultProject]
  );

  return (
    <fieldset className="space-y-4 rounded-xl border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium text-foreground">Options</legend>

      {type === "projects" ? (
        <div className="space-y-2">
          <p id={`${id}-existing`} className="text-sm text-foreground">
            If a project code already exists
          </p>
          <RadioGroup
            aria-labelledby={`${id}-existing`}
            value={options.onExisting ?? "skip"}
            onValueChange={(value) => onOptions({ ...options, onExisting: value as "skip" | "update" })}
            className="gap-2 sm:grid-cols-2"
          >
            {(
              [
                { value: "skip", label: "Skip it", hint: "Existing projects stay as they are." },
                {
                  value: "update",
                  label: "Update it",
                  hint: "Only the mapped, non-empty cells change. Members are left alone.",
                },
              ] as const
            ).map((choice) => (
              <label
                key={choice.value}
                htmlFor={`${id}-${choice.value}`}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors duration-150 ease-out has-data-checked:border-primary/40 has-data-checked:bg-primary/5"
              >
                <RadioGroupItem id={`${id}-${choice.value}`} value={choice.value} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium text-foreground">{choice.label}</span>
                  <span className="block text-xs text-muted-foreground">{choice.hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={`${id}-project`}>Default project</Label>
            <NativeSelect
              id={`${id}-project`}
              className="w-full"
              value={options.defaultProject ?? NO_PROJECT}
              onChange={(event) => onOptions({ ...options, defaultProject: event.target.value || null })}
              disabled={defaultProjectLocked || projects.isPending}
            >
              <NativeSelectOption value={NO_PROJECT}>
                {projects.isPending ? "Loading projects…" : "None — use the Project column"}
              </NativeSelectOption>
              {projectChoices.map((project) => (
                <NativeSelectOption key={project._id} value={project._id}>
                  {project.code} · {project.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">Used for rows with no project.</p>
          </div>
          <div className="flex items-start gap-3 sm:pt-6">
            <Switch
              id={`${id}-emails`}
              checked={Boolean(options.sendEmails)}
              onCheckedChange={(checked) => onOptions({ ...options, sendEmails: checked })}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <Label htmlFor={`${id}-emails`} className="cursor-pointer">
                Send assignment emails
              </Label>
              <p className="text-xs text-muted-foreground">
                Off by default so big imports don&apos;t flood inboxes. In-app notifications are always sent.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2.5">
        <Checkbox
          id={`${id}-unknown`}
          checked={Boolean(options.skipUnknownPeople)}
          onCheckedChange={(checked) => onOptions({ ...options, skipUnknownPeople: checked === true })}
          className="mt-0.5"
        />
        <div className="space-y-0.5">
          <Label htmlFor={`${id}-unknown`} className="cursor-pointer">
            Skip unknown people
          </Label>
          <p className="text-xs text-muted-foreground">
            {type === "tasks"
              ? "Import the row with a warning when at least one assignee is found, instead of failing it."
              : "Import the row with a warning instead of failing it when a manager or member isn't found."}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
