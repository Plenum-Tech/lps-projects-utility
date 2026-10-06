import { LuRepeat } from "react-icons/lu";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeRecurrence } from "@/lib/tasks";
import type { RecurrenceInput, RecurrenceUnit } from "@/types";

const UNIT_LABELS: Record<RecurrenceUnit, string> = { day: "day(s)", week: "week(s)", month: "month(s)" };

export const DEFAULT_RECURRENCE: RecurrenceInput = { every: 1, unit: "week", cycles: -1 };

/** Validates a recurrence; returns an error message or null. */
export function recurrenceError(value: RecurrenceInput | null): string | null {
  if (!value) return null;
  if (!Number.isInteger(value.every) || value.every < 1 || value.every > 365) {
    return "Repeat every 1–365.";
  }
  if (value.cycles !== -1 && (!Number.isInteger(value.cycles) || value.cycles < 1 || value.cycles > 1000)) {
    return "Cycles must be 1–1000, or forever.";
  }
  return null;
}

/** "Repeat every [N] [day/week/month] for [N | forever] cycles". */
export function RecurrenceField({
  value,
  onChange,
  disabled,
  showError,
}: {
  value: RecurrenceInput | null;
  onChange: (value: RecurrenceInput | null) => void;
  disabled?: boolean;
  showError?: boolean;
}) {
  const enabled = value !== null;
  const error = showError ? recurrenceError(value) : null;

  return (
    <fieldset className="space-y-3 rounded-lg border p-3" disabled={disabled} aria-label="Recurrence">
      <div className="flex items-center justify-between gap-3">
          <Label htmlFor="task-repeat" className="flex items-center gap-2">
            <LuRepeat aria-hidden className="size-4 text-muted-foreground" />
            Repeat this task
          </Label>
        <Switch
          id="task-repeat"
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? DEFAULT_RECURRENCE : null)}
        />
      </div>

      {value && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Every</span>
            <Input
              type="number"
              min={1}
              max={365}
              value={Number.isNaN(value.every) ? "" : value.every}
              onChange={(event) => onChange({ ...value, every: event.target.valueAsNumber })}
              className="h-8 w-20"
              aria-label="Repeat interval"
              aria-invalid={Boolean(error) || undefined}
            />
            <Select
              value={value.unit}
              onValueChange={(unit) => onChange({ ...value, unit: unit as RecurrenceUnit })}
              items={UNIT_LABELS}
            >
              <SelectTrigger className="w-28" aria-label="Repeat unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(UNIT_LABELS) as RecurrenceUnit[]).map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {UNIT_LABELS[unit]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">for</span>
            {value.cycles !== -1 && (
              <Input
                type="number"
                min={1}
                max={1000}
                value={Number.isNaN(value.cycles) ? "" : value.cycles}
                onChange={(event) => onChange({ ...value, cycles: event.target.valueAsNumber })}
                className="h-8 w-20"
                aria-label="Number of cycles"
                aria-invalid={Boolean(error) || undefined}
              />
            )}
            <span className="text-muted-foreground">{value.cycles === -1 ? "ever" : "cycles"}</span>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={value.cycles === -1}
              onCheckedChange={(checked) => onChange({ ...value, cycles: checked ? -1 : 4 })}
            />
            Repeat forever
          </label>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : (
            !recurrenceError(value) && (
              <p className="text-xs text-muted-foreground">
                {describeRecurrence(value)}. A fresh copy is created from the start date.
              </p>
            )
          )}
        </div>
      )}
    </fieldset>
  );
}
