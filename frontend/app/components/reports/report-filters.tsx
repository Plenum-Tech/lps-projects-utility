import { useMemo, type ReactNode } from "react";
import { LuCalendarRange, LuFilterX } from "react-icons/lu";

import { FilterSelect } from "@/components/globals/filter-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDepartments } from "@/hooks/use-departments";
import { useProjectOptions } from "@/hooks/use-projects";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Date range                                                          */
/* ------------------------------------------------------------------ */

/** Two native date inputs ("From" / "To"); either may be empty. */
export function DateRangeInputs({
  from,
  to,
  onChange,
  idPrefix,
  label = "Date range",
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  idPrefix: string;
  label?: string;
}) {
  const invalid = Boolean(from && to && from > to);
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <LuCalendarRange aria-hidden className="size-4 text-muted-foreground" />
      <label htmlFor={`${idPrefix}-from`} className="sr-only">
        From
      </label>
      <Input
        id={`${idPrefix}-from`}
        type="date"
        value={from}
        max={to || undefined}
        onChange={(event) => onChange({ from: event.target.value, to })}
        className="h-7 w-[9.5rem] text-xs"
        aria-invalid={invalid || undefined}
      />
      <span aria-hidden className="text-xs text-muted-foreground">
        –
      </span>
      <label htmlFor={`${idPrefix}-to`} className="sr-only">
        To
      </label>
      <Input
        id={`${idPrefix}-to`}
        type="date"
        value={to}
        min={from || undefined}
        onChange={(event) => onChange({ from, to: event.target.value })}
        className="h-7 w-[9.5rem] text-xs"
        aria-invalid={invalid || undefined}
      />
    </fieldset>
  );
}

/** Quick range presets rendered as pressed/unpressed chips. */
export function RangePresets({
  presets,
  from,
  to,
  onSelect,
}: {
  presets: { label: string; from: string; to: string }[];
  from: string;
  to: string;
  onSelect: (range: { from: string; to: string }) => void;
}) {
  return (
    <div role="group" aria-label="Date presets" className="flex flex-wrap gap-1">
      {presets.map((preset) => {
        const active = preset.from === from && preset.to === to;
        return (
          <Button
            key={preset.label}
            type="button"
            size="xs"
            variant={active ? "secondary" : "ghost"}
            aria-pressed={active}
            onClick={() => onSelect({ from: preset.from, to: preset.to })}
            className={cn(active && "ring-1 ring-ring/40")}
          >
            {preset.label}
          </Button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Entity filters                                                      */
/* ------------------------------------------------------------------ */

/** Employee filter (heads: own department; admins: everyone). */
export function EmployeeFilter({
  value,
  onChange,
  department,
}: {
  value: string;
  onChange: (value: string) => void;
  /** When set, only that department's people are offered. */
  department?: string;
}) {
  const users = useAssignableUsers();
  const options = useMemo(
    () =>
      (users.data ?? [])
        .filter((user) => !department || user.department?._id === department || user._id === value)
        .map((user) => ({ value: user._id, label: user.name })),
    [users.data, department, value]
  );
  return (
    <FilterSelect
      label="Employee"
      value={value}
      onChange={onChange}
      options={options}
      anyLabel="All employees"
      className="max-w-56"
    />
  );
}

export function ProjectFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const projects = useProjectOptions();
  const options = useMemo(
    () =>
      (projects.data ?? []).map((project) => ({
        value: project._id,
        label: `${project.code} · ${project.name}`,
      })),
    [projects.data]
  );
  return (
    <FilterSelect
      label="Project"
      value={value}
      onChange={onChange}
      options={options}
      anyLabel="All projects"
      className="max-w-60"
    />
  );
}

/** Admin-only department filter (mount it only for admins). */
export function DepartmentFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const departments = useDepartments();
  const options = useMemo(
    () =>
      (departments.data?.departments ?? []).map((department) => ({
        value: department._id,
        label: department.name,
      })),
    [departments.data]
  );
  return (
    <FilterSelect
      label="Department"
      value={value}
      onChange={onChange}
      options={options}
      anyLabel="All departments"
      className="max-w-56"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

/** Bordered filter strip with an optional "Reset" action. */
export function ReportFilterBar({
  children,
  onReset,
  canReset,
}: {
  children: ReactNode;
  onReset?: () => void;
  canReset?: boolean;
}) {
  return (
    <section
      aria-label="Report filters"
      className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/60 p-3"
    >
      {children}
      {onReset && canReset && (
        <Button type="button" variant="ghost" size="sm" onClick={onReset} className="ml-auto">
          <LuFilterX aria-hidden />
          Reset
        </Button>
      )}
    </section>
  );
}
