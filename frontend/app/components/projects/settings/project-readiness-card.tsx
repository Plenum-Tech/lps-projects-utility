import { useState, type FormEvent } from "react";
import { LuGauge } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { SaveBar } from "@/components/projects/settings/settings-fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { useProjectSettings, useUpdateProjectSettings } from "@/hooks/use-project-meta";

interface Draft {
  retainerDay: number;
  pitchDays: number;
  greenFrom: number;
  amberFrom: number;
}
const whole = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** Leadership: when planning is due (the readiness cut-offs) and the score's green / amber lines. */
export function ProjectReadinessCard() {
  const { data: user } = useCurrentUser();
  const settings = useProjectSettings();
  const update = useUpdateProjectSettings();
  const [edits, setEdits] = useState<Partial<Draft>>({});
  if (!user?.leadership) return null;

  const saved: Draft | null = settings.data
    ? {
        retainerDay: settings.data.readinessRetainerDay ?? 3,
        pitchDays: settings.data.readinessPitchDays ?? 2,
        greenFrom: settings.data.readinessGreenFrom ?? 80,
        amberFrom: settings.data.readinessAmberFrom ?? 50,
      }
    : null;
  const draft = saved ? { ...saved, ...edits } : null;
  const dirty = Boolean(draft && saved && (Object.keys(saved) as Array<keyof Draft>).some((k) => draft[k] !== saved[k]));
  const invalid = draft
    ? !whole(draft.retainerDay, 1, 20) || !whole(draft.pitchDays, 0, 20) || !whole(draft.greenFrom, 1, 100) || !whole(draft.amberFrom, 0, 99) || draft.amberFrom >= draft.greenFrom
    : false;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft || !dirty || invalid) return;
    update.mutate({ readiness: draft }, { onSuccess: () => setEdits({}) });
  }

  const field = (key: keyof Draft, label: string, hint: string, min: number, max: number) => (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div>
        <Label htmlFor={`readiness-${key}`}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Input
        id={`readiness-${key}`}
        type="number"
        min={min}
        max={max}
        value={Number.isNaN(draft![key]) ? "" : draft![key]}
        onChange={(event) => setEdits({ ...edits, [key]: event.target.valueAsNumber })}
        className="h-8 w-20"
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuGauge aria-hidden className="size-4 text-muted-foreground" />
          Project readiness
        </CardTitle>
        <CardDescription>
          The readiness score (out of 100) checks that a project was planned — its scope entered as tasks, with assignees, due dates and estimates — by these cut-offs. Leadership sets them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : settings.isError || !draft ? (
          <QueryError title="Couldn't load the readiness settings" error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-3">
            {field("retainerDay", "Retainers: planned by working day", `Working day ${draft.retainerDay || "?"} of the month (Monday to Friday).`, 1, 20)}
            {field("pitchDays", "Pitches: working days after the internal briefing", "Counted from the Milestone 1 meeting, else the pitch's start date.", 0, 20)}
            {field("greenFrom", "Green from", "Scores at or above this are green.", 1, 100)}
            {field("amberFrom", "Amber from", "Scores from here up to green are amber; below it red.", 0, 99)}
            {invalid && <p className="text-xs text-destructive">Use whole numbers, and keep amber below green.</p>}
            <SaveBar dirty={dirty} pending={update.isPending} invalid={invalid} onReset={() => setEdits({})} label="Save readiness settings" />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
