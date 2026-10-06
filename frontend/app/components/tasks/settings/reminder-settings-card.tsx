import { useEffect, useState, type FormEvent } from "react";
import { LuAlarmClock, LuCircleAlert, LuLoaderCircle, LuRefreshCw, LuSave } from "react-icons/lu";

import { useReportDirty } from "@/components/settings/unsaved-changes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useTaskSettings, useUpdateTaskSettings } from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";

function validDays(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 30;
}

/** Due-date reminder schedule (runs daily at 08:00 IST). */
export function ReminderSettingsCard() {
  const settings = useTaskSettings();
  const update = useUpdateTaskSettings();
  const [before, setBefore] = useState(1);
  const [onDeadline, setOnDeadline] = useState(true);
  const [after, setAfter] = useState(1);

  useEffect(() => {
    if (settings.data) {
      setBefore(settings.data.reminderBeforeDays);
      setOnDeadline(settings.data.reminderOnDeadline);
      setAfter(settings.data.reminderAfterDays);
    }
  }, [settings.data]);

  const invalid = !validDays(before) || !validDays(after);
  const dirty =
    settings.data !== undefined &&
    (before !== settings.data.reminderBeforeDays ||
      onDeadline !== settings.data.reminderOnDeadline ||
      after !== settings.data.reminderAfterDays);

  useReportDirty(dirty);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    update.mutate({
      reminderBeforeDays: before,
      reminderOnDeadline: onDeadline,
      reminderAfterDays: after,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuAlarmClock aria-hidden className="size-4 text-muted-foreground" />
          Due-date reminders
        </CardTitle>
        <CardDescription>
          Sent to assignees every morning at 08:00 (IST). Set a value to 0 to turn it off.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading reminder settings">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : settings.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t load reminder settings</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(settings.error)}
              <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
                <LuRefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <DaysRow
              id="reminder-before"
              label="Before the due date"
              hint={before === 0 ? "Off" : `${before} day${before === 1 ? "" : "s"} before`}
              value={before}
              onChange={setBefore}
            />
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <div>
                <Label htmlFor="reminder-on">On the due date</Label>
                <p className="text-xs text-muted-foreground">&ldquo;Due today&rdquo; reminder</p>
              </div>
              <Switch id="reminder-on" checked={onDeadline} onCheckedChange={setOnDeadline} />
            </div>
            <DaysRow
              id="reminder-after"
              label="After the due date (overdue)"
              hint={after === 0 ? "Off" : `${after} day${after === 1 ? "" : "s"} overdue — creator is told too`}
              value={after}
              onChange={setAfter}
            />
            {invalid && (
              <p className="text-xs text-destructive" role="alert">
                Days must be whole numbers between 0 and 30.
              </p>
            )}
            <Button type="submit" disabled={update.isPending || invalid || !dirty}>
              {update.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSave aria-hidden />
              )}
              Save reminders
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function DaysRow({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          max={30}
          value={Number.isNaN(value) ? "" : value}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          className="h-8 w-20"
          aria-invalid={!validDays(value) || undefined}
        />
        <span className="text-xs text-muted-foreground">days</span>
      </div>
    </div>
  );
}
