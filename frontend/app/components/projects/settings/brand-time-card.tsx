import { useMemo, useState } from "react";
import { LuTags } from "react-icons/lu";

import { MultiSelect } from "@/components/globals/multi-select";
import { QueryError } from "@/components/globals/query-states";
import { SaveBar } from "@/components/projects/settings/settings-fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDepartments } from "@/hooks/use-departments";
import { useProjectSettings, useUpdateProjectSettings } from "@/hooks/use-project-meta";

/** Admin: which departments log weekly-timesheet hours on a brand as a whole (no approval). */
export function BrandTimeCard() {
  const settings = useProjectSettings();
  const update = useUpdateProjectSettings();
  const departments = useDepartments();
  const [picked, setPicked] = useState<string[] | null>(null);
  // Nothing saved yet: the defaults in use (360 Program, Community Management, Leadership).
  const saved = settings.data?.brandTimeDepartments?.length
    ? settings.data.brandTimeDepartments
    : (settings.data?.brandTimeDepartmentsInUse ?? []);
  const current = picked ?? saved;
  const dirty = picked !== null && [...picked].sort().join() !== [...saved].sort().join();
  const options = useMemo(
    () => (departments.data?.departments ?? []).map((d) => ({ value: d._id, label: d.name })),
    [departments.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTags aria-hidden className="size-4 text-muted-foreground" />
          Brand time
        </CardTitle>
        <CardDescription>
          People in these departments can add brand rows to their weekly timesheet and log hours on a brand as a whole
          (not a task). Brand hours need no approval. Leadership always can.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : settings.isError ? (
          <QueryError title="Couldn't load the settings" error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!dirty) return;
              update.mutate({ brandTimeDepartments: current }, { onSuccess: () => setPicked(null) });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="brand-time-departments">Departments</Label>
              <MultiSelect
                id="brand-time-departments"
                options={options}
                value={current}
                onValueChange={setPicked}
                placeholder={departments.isPending ? "Loading departments…" : "Add departments…"}
                aria-describedby="brand-time-hint"
              />
              <p id="brand-time-hint" className="text-xs text-muted-foreground">
                By default: 360 Program, Community Management and Leadership.
              </p>
            </div>
            <SaveBar dirty={dirty} pending={update.isPending} onReset={() => setPicked(null)} label="Save brand time settings" />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
