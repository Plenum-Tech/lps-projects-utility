import { LuBriefcaseBusiness } from "react-icons/lu";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dateKey } from "@/lib/time";
import type { User } from "@/types";

/** Form state of the Manage Users → Employment section ("YYYY-MM-DD" or ""). */
export interface EmploymentForm {
  designation: string;
  employeeId: string;
  dateOfBirth: string;
  joiningDate: string;
  probationEndDate: string;
  internshipEndDate: string;
  noticePeriodStart: string;
  noticePeriodEnd: string;
}

const DATE_KEYS = [
  "dateOfBirth",
  "joiningDate",
  "probationEndDate",
  "internshipEndDate",
  "noticePeriodStart",
  "noticePeriodEnd",
] as const;

export const EMPLOYEE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/;

/** Date-only API value → "YYYY-MM-DD" (UTC date part, never timezone-shifted). */
const toInput = (value: string | null | undefined) => (value ? value.slice(0, 10) : "");

export function employmentFormFrom(user: User | null): EmploymentForm {
  return {
    designation: user?.designation ?? "",
    employeeId: user?.employeeId ?? "",
    dateOfBirth: toInput(user?.dateOfBirth),
    joiningDate: toInput(user?.joiningDate),
    probationEndDate: toInput(user?.probationEndDate),
    internshipEndDate: toInput(user?.internshipEndDate),
    noticePeriodStart: toInput(user?.noticePeriodStart),
    noticePeriodEnd: toInput(user?.noticePeriodEnd),
  };
}

export interface EmploymentErrors {
  designation?: string;
  employeeId?: string;
  dateOfBirth?: string;
  noticePeriodEnd?: string;
}

/** Client-side checks mirroring the backend rules. */
export function validateEmployment(form: EmploymentForm, isEdit: boolean): EmploymentErrors {
  const errors: EmploymentErrors = {};
  if (form.designation.trim().length > 100) errors.designation = "Keep the designation under 100 characters.";
  const id = form.employeeId.trim();
  if (isEdit && id === "") errors.employeeId = "Employee ID cannot be empty.";
  else if (id.length > 30) errors.employeeId = "Keep the employee ID under 30 characters.";
  else if (id && !EMPLOYEE_ID_PATTERN.test(id))
    errors.employeeId = "Use letters, numbers, spaces and . _ - / (start with a letter or number).";
  if (form.dateOfBirth && form.dateOfBirth > dateKey(new Date()))
    errors.dateOfBirth = "Date of birth can't be in the future.";
  if (form.noticePeriodStart && form.noticePeriodEnd && form.noticePeriodEnd < form.noticePeriodStart)
    errors.noticePeriodEnd = "Notice end must be on or after its start.";
  return errors;
}

/**
 * Builds the HR part of a create/update body. On edit only changed fields are
 * sent; "" clears a date.
 */
export function employmentPayload(form: EmploymentForm, user: User | null) {
  const initial = employmentFormFrom(user);
  const out: Partial<Record<keyof EmploymentForm, string | null>> = {};
  const designation = form.designation.trim();
  const employeeId = form.employeeId.trim();
  if (!user || designation !== initial.designation) out.designation = designation;
  if (user ? employeeId !== initial.employeeId : employeeId !== "") out.employeeId = employeeId;
  for (const key of DATE_KEYS) {
    if (user ? form[key] !== initial[key] : form[key] !== "") out[key] = form[key] || null;
  }
  return out;
}

/** Employment section of the Manage Users dialog (designation, ID, HR dates). */
export function EmploymentFields({
  form,
  onChange,
  errors,
  isEdit,
}: {
  form: EmploymentForm;
  onChange: (patch: Partial<EmploymentForm>) => void;
  errors: EmploymentErrors;
  isEdit: boolean;
}) {
  const today = dateKey(new Date());

  function dateField(
    key: (typeof DATE_KEYS)[number],
    label: string,
    extra?: { max?: string; min?: string; error?: string }
  ) {
    const id = `user-hr-${key}`;
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          type="date"
          value={form[key]}
          max={extra?.max}
          min={extra?.min}
          onChange={(event) => onChange({ [key]: event.target.value })}
          aria-invalid={Boolean(extra?.error)}
          aria-describedby={extra?.error ? `${id}-error` : undefined}
        />
        {extra?.error && (
          <p id={`${id}-error`} className="text-xs text-destructive">
            {extra.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <fieldset className="space-y-4 rounded-lg border bg-muted/30 p-3">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-foreground">
        <LuBriefcaseBusiness aria-hidden className="size-4 text-muted-foreground" />
        Employment
      </legend>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="user-hr-designation">Designation</Label>
          <Input
            id="user-hr-designation"
            value={form.designation}
            maxLength={100}
            onChange={(event) => onChange({ designation: event.target.value })}
            placeholder="e.g. Senior Engineer"
            aria-invalid={Boolean(errors.designation)}
            aria-describedby={errors.designation ? "user-hr-designation-error" : undefined}
          />
          {errors.designation && (
            <p id="user-hr-designation-error" className="text-xs text-destructive">
              {errors.designation}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-hr-employee-id">Employee ID</Label>
          <Input
            id="user-hr-employee-id"
            value={form.employeeId}
            maxLength={30}
            onChange={(event) => onChange({ employeeId: event.target.value })}
            placeholder={isEdit ? "EMP-0001" : "Auto (EMP-00xx)"}
            className="font-mono"
            aria-invalid={Boolean(errors.employeeId)}
            aria-describedby="user-hr-employee-id-hint"
          />
          <p
            id="user-hr-employee-id-hint"
            className={errors.employeeId ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {errors.employeeId ?? (isEdit ? "Must be unique." : "Leave blank to assign the next ID.")}
          </p>
        </div>
        {dateField("dateOfBirth", "Date of birth", { max: today, error: errors.dateOfBirth })}
        {dateField("joiningDate", "Joining date")}
        {dateField("probationEndDate", "Probation ends")}
        {dateField("internshipEndDate", "Internship ends")}
        {dateField("noticePeriodStart", "Notice period starts")}
        {dateField("noticePeriodEnd", "Notice period ends", {
          min: form.noticePeriodStart || undefined,
          error: errors.noticePeriodEnd,
        })}
      </div>
    </fieldset>
  );
}
