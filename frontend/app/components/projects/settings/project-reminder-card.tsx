import { useState, type FormEvent } from "react";
import { LuBellRing } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { SaveBar } from "@/components/projects/settings/settings-fields";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectSettings, useUpdateProjectSettings } from "@/hooks/use-project-meta";
import type { ProjectSettings } from "@/types";

type Recipient = ProjectSettings["deadlineReminderTo"][number];

const RECIPIENTS: { value: Recipient; label: string; hint: string }[] = [
  { value: "manager", label: "Project manager", hint: "The project's manager" },
  { value: "members", label: "Members", hint: "Everyone on the project" },
  { value: "admins", label: "Admins", hint: "All administrators" },
];

interface Draft {
  days: number;
  to: Recipient[];
}

function sameSet(a: Recipient[], b: Recipient[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function validDays(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 60;
}

/** Admin: project deadline reminder (sent daily at 08:00). */
export function ProjectReminderCard() {
  const settings = useProjectSettings();
  const update = useUpdateProjectSettings();
  const [edits, setEdits] = useState<Partial<Draft>>({});

  const saved: Draft | null = settings.data
    ? { days: settings.data.deadlineReminderDays, to: settings.data.deadlineReminderTo }
    : null;
  const draft = saved ? { ...saved, ...edits } : null;
  const dirty = Boolean(
    draft && saved && (draft.days !== saved.days || !sameSet(draft.to, saved.to))
  );
  const invalidDays = draft ? !validDays(draft.days) : false;
  const noRecipients = Boolean(draft && draft.days > 0 && draft.to.length === 0);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !dirty || invalidDays || noRecipients) return;
    update.mutate(
      { deadlineReminderDays: draft.days, deadlineReminderTo: draft.to },
      { onSuccess: () => setEdits({}) }
    );
  }

  function toggle(recipient: Recipient, checked: boolean) {
    if (!draft) return;
    const to = checked
      ? [...new Set([...draft.to, recipient])]
      : draft.to.filter((item) => item !== recipient);
    setEdits({ ...edits, to });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuBellRing aria-hidden className="size-4 text-muted-foreground" />
          Deadline reminders
        </CardTitle>
        <CardDescription>
          Sent once, every morning at 08:00, when a project&apos;s deadline is this many days
          away. Set 0 to turn it off.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading reminder settings">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : settings.isError || !draft ? (
          <QueryError
            title="Couldn't load reminder settings"
            error={settings.error}
            onRetry={() => void settings.refetch()}
            retrying={settings.isFetching}
          />
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="deadline-reminder-days">Days before the deadline</Label>
                <p className="text-xs text-muted-foreground">
                  {draft.days === 0
                    ? "Off"
                    : validDays(draft.days)
                      ? `${draft.days} day${draft.days === 1 ? "" : "s"} before`
                      : "Enter 0–60"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="deadline-reminder-days"
                  type="number"
                  min={0}
                  max={60}
                  value={Number.isNaN(draft.days) ? "" : draft.days}
                  onChange={(event) => setEdits({ ...edits, days: event.target.valueAsNumber })}
                  className="h-8 w-20"
                  aria-invalid={invalidDays || undefined}
                  aria-describedby={invalidDays ? "deadline-reminder-days-error" : undefined}
                />
                <span className="text-xs text-muted-foreground">days</span>
              </div>
            </div>
            {invalidDays && (
              <p id="deadline-reminder-days-error" className="text-xs text-destructive" role="alert">
                Days must be a whole number between 0 and 60.
              </p>
            )}

            <fieldset className="space-y-2" disabled={draft.days === 0}>
              <legend className="text-sm font-medium text-foreground">Send to</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {RECIPIENTS.map((recipient) => {
                  const id = `deadline-to-${recipient.value}`;
                  return (
                    <Label
                      key={recipient.value}
                      htmlFor={id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal transition-colors duration-150 has-data-checked:border-ring/60 has-data-checked:bg-primary/5 has-disabled:cursor-not-allowed has-disabled:opacity-60"
                    >
                      <Checkbox
                        id={id}
                        checked={draft.to.includes(recipient.value)}
                        onCheckedChange={(checked) => toggle(recipient.value, checked === true)}
                        disabled={draft.days === 0}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-sm font-medium text-foreground">
                          {recipient.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">{recipient.hint}</span>
                      </span>
                    </Label>
                  );
                })}
              </div>
              {noRecipients && (
                <p className="text-xs text-destructive" role="alert">
                  Choose at least one recipient, or set days to 0.
                </p>
              )}
            </fieldset>

            <SaveBar
              dirty={dirty}
              pending={update.isPending}
              invalid={invalidDays || noRecipients}
              onReset={() => setEdits({})}
              label="Save reminders"
            />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
