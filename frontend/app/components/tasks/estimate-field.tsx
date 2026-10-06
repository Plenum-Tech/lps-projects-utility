import { useEffect, useId, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuPencil } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUpdateTask } from "@/hooks/use-tasks";
import { formatEffort, parseEstimate, splitEstimate } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * "Estimated time" as hours + minutes inputs. Values are strings so the
 * fields can be empty (no estimate); validate with `parseEstimate`.
 */
export function EstimateField({
  hours,
  minutes,
  onChange,
  invalid,
  label = "Estimated time",
  hint = "Optional — compared with the hours logged.",
  className,
}: {
  hours: string;
  minutes: string;
  onChange: (value: { hours: string; minutes: string }) => void;
  invalid?: boolean;
  label?: string;
  hint?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <fieldset className={cn("space-y-1.5", className)} aria-describedby={`${id}-hint`}>
      <legend className="mb-1.5 text-sm leading-none font-medium">{label}</legend>
      <div className="flex items-center gap-2">
        <div className="relative w-24">
          <Input
            id={`${id}-hours`}
            type="number"
            inputMode="numeric"
            min={0}
            max={1666}
            step={1}
            value={hours}
            onChange={(event) => onChange({ hours: event.target.value, minutes })}
            placeholder="0"
            className="pr-7 tabular-nums"
            aria-label="Estimated hours"
            aria-invalid={invalid || undefined}
          />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
            h
          </span>
        </div>
        <div className="relative w-24">
          <Input
            id={`${id}-minutes`}
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            value={minutes}
            onChange={(event) => onChange({ hours, minutes: event.target.value })}
            placeholder="0"
            className="pr-7 tabular-nums"
            aria-label="Estimated minutes"
            aria-invalid={invalid || undefined}
          />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
            m
          </span>
        </div>
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid ? "Use whole hours and 0–59 minutes (up to 1666h 40m)." : hint}
      </p>
    </fieldset>
  );
}

/**
 * Detail-sheet editor: shows the estimate (or "--") with an edit popover for
 * people who may edit the task.
 */
export function EstimateEditor({
  taskId,
  value,
  canEdit,
}: {
  taskId: string;
  value: number | null | undefined;
  canEdit: boolean;
}) {
  const update = useUpdateTask();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => splitEstimate(value));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(splitEstimate(value));
      setSubmitted(false);
    }
  }, [open, value]);

  const parsed = parseEstimate(draft.hours, draft.minutes);
  const text = value === null || value === undefined ? "--" : formatEffort(value);
  if (!canEdit) return <span className="tabular-nums">{text}</span>;

  function save(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (parsed === "invalid") return;
    if (parsed === (value ?? null)) {
      setOpen(false);
      return;
    }
    update.mutate(
      { id: taskId, input: { estimateMinutes: parsed } },
      { onSuccess: () => setOpen(false) }
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md text-left tabular-nums outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`Estimated time: ${text}. Edit`}
          />
        }
      >
        {text}
        <LuPencil aria-hidden className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <form onSubmit={save} noValidate className="space-y-3">
          <EstimateField
            hours={draft.hours}
            minutes={draft.minutes}
            onChange={setDraft}
            invalid={submitted && parsed === "invalid"}
            hint="Leave both empty to clear."
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
