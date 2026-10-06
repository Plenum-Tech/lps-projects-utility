import { useState, type FormEvent } from "react";
import { LuTimer } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { SaveBar, SwitchRow } from "@/components/projects/settings/settings-fields";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectSettings, useUpdateProjectSettings } from "@/hooks/use-project-meta";
import type { ProjectSettings } from "@/types";

type Draft = Pick<
  ProjectSettings,
  "logTimeFor" | "approvalRequired" | "dailyTimeLogReport"
> & { autoStopTimerAt: string; trackerReminderAt: string };

function toDraft(settings: ProjectSettings): Draft {
  return {
    logTimeFor: settings.logTimeFor,
    approvalRequired: settings.approvalRequired,
    dailyTimeLogReport: settings.dailyTimeLogReport,
    autoStopTimerAt: settings.autoStopTimerAt ?? "",
    trackerReminderAt: settings.trackerReminderAt ?? "",
  };
}

const LOG_TIME_OPTIONS: { value: ProjectSettings["logTimeFor"]; label: string; hint: string }[] = [
  { value: "project", label: "Project", hint: "A log needs a project; the task is optional." },
  { value: "task", label: "Task", hint: "Every log must reference a task." },
];

/** Admin: how time is logged, approved and reminded. */
export function TimeLogSettingsCard() {
  const settings = useProjectSettings();
  const update = useUpdateProjectSettings();
  // Local edits layered over the saved settings, so a save in another card
  // (same singleton) never wipes unsaved changes here.
  const [edits, setEdits] = useState<Partial<Draft>>({});
  const saved = settings.data ? toDraft(settings.data) : null;
  const draft = saved ? { ...saved, ...edits } : null;
  const dirty = Boolean(
    draft && saved && (Object.keys(edits) as (keyof Draft)[]).some((key) => draft[key] !== saved[key])
  );
  const setDraft = (next: Draft) => setEdits(next);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !dirty) return;
    update.mutate({
      logTimeFor: draft.logTimeFor,
      approvalRequired: draft.approvalRequired,
      dailyTimeLogReport: draft.dailyTimeLogReport,
      autoStopTimerAt: draft.autoStopTimerAt || null,
      trackerReminderAt: draft.trackerReminderAt || null,
    }, { onSuccess: () => setEdits({}) });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTimer aria-hidden className="size-4 text-muted-foreground" />
          Time logs
        </CardTitle>
        <CardDescription>
          Applies to every project. Times use the company time zone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading time-log settings">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : settings.isError || !draft ? (
          <QueryError
            title="Couldn't load time-log settings"
            error={settings.error}
            onRetry={() => void settings.refetch()}
            retrying={settings.isFetching}
          />
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Log time against</legend>
              <RadioGroup
                value={draft.logTimeFor}
                onValueChange={(value) =>
                  setDraft({ ...draft, logTimeFor: value as Draft["logTimeFor"] })
                }
                className="grid gap-2 sm:grid-cols-2"
              >
                {LOG_TIME_OPTIONS.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`log-time-for-${option.value}`}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors duration-150 has-data-checked:border-ring/60 has-data-checked:bg-primary/5"
                  >
                    <RadioGroupItem
                      id={`log-time-for-${option.value}`}
                      value={option.value}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>

            <SwitchRow
              id="approval-required"
              label="Approval required"
              hint="Off: new logs are approved immediately."
              checked={draft.approvalRequired}
              onChange={(approvalRequired) => setDraft({ ...draft, approvalRequired })}
            />

            <TimeRow
              id="auto-stop-at"
              label="Auto-stop running timers at"
              hint={
                draft.autoStopTimerAt
                  ? `Timers still running are stopped at ${draft.autoStopTimerAt} daily.`
                  : "Off — timers run until stopped."
              }
              value={draft.autoStopTimerAt}
              onChange={(autoStopTimerAt) => setDraft({ ...draft, autoStopTimerAt })}
            />

            <TimeRow
              id="tracker-reminder-at"
              label="Remind people with no log today at"
              hint={
                draft.trackerReminderAt
                  ? "Skips weekends and approved leave."
                  : "Off — no daily tracker reminder."
              }
              value={draft.trackerReminderAt}
              onChange={(trackerReminderAt) => setDraft({ ...draft, trackerReminderAt })}
            />

            <SwitchRow
              id="daily-time-log-report"
              label="Daily time-log report"
              hint="Summary email to admins and heads at 19:30."
              checked={draft.dailyTimeLogReport}
              onChange={(dailyTimeLogReport) => setDraft({ ...draft, dailyTimeLogReport })}
            />

            <SaveBar
              dirty={dirty}
              pending={update.isPending}
              onReset={() => setEdits({})}
              label="Save time-log settings"
            />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function TimeRow({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="time"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-32"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            aria-label={`Turn off: ${label}`}
          >
            Off
          </Button>
        )}
      </div>
    </div>
  );
}
