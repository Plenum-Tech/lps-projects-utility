import { useMemo, useState } from "react";
import { LuShieldCheck } from "react-icons/lu";

import { MultiSelect } from "@/components/globals/multi-select";
import { QueryError } from "@/components/globals/query-states";
import { SaveBar, SwitchRow } from "@/components/projects/settings/settings-fields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectSettings, useUpdateProjectSettings } from "@/hooks/use-project-meta";
import { useAssignableUsers } from "@/hooks/use-task-meta";

/** Admin: new projects need approval before tasks; who approves. */
export function ProjectApprovalCard() {
  const settings = useProjectSettings();
  const update = useUpdateProjectSettings();
  const users = useAssignableUsers();
  const [required, setRequired] = useState<boolean | null>(null);
  const [approvers, setApprovers] = useState<string[] | null>(null);
  const savedRequired = settings.data?.projectApprovalRequired ?? true;
  const savedApprovers = settings.data?.projectApprovers ?? [];
  const curRequired = required ?? savedRequired;
  const curApprovers = approvers ?? savedApprovers;
  const dirty =
    curRequired !== savedRequired || [...curApprovers].sort().join() !== [...savedApprovers].sort().join();
  const options = useMemo(
    () => (users.data ?? []).map((u) => ({ value: u._id, label: u.name, description: u.email })),
    [users.data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuShieldCheck aria-hidden className="size-4 text-muted-foreground" />
          Project approval
        </CardTitle>
        <CardDescription>
          New projects wait for approval before anyone can add tasks. Approvers get an email with an approve link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : settings.isError ? (
          <QueryError title="Couldn't load the settings" error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!dirty) return;
              update.mutate(
                { projectApprovalRequired: curRequired, projectApprovers: curApprovers },
                {
                  onSuccess: () => {
                    setRequired(null);
                    setApprovers(null);
                  },
                },
              );
            }}
          >
            <SwitchRow
              id="project-approval-required"
              label="Require approval for new projects"
              hint="Projects created before this was turned on stay approved."
              checked={curRequired}
              onChange={setRequired}
            />
            <div className="space-y-1.5">
              <Label htmlFor="project-approvers">Approvers</Label>
              <MultiSelect
                id="project-approvers"
                options={options}
                value={curApprovers}
                onValueChange={setApprovers}
                placeholder={users.isPending ? "Loading people…" : "Add approvers…"}
                max={10}
                aria-describedby="project-approvers-hint"
              />
              <p id="project-approvers-hint" className="text-xs text-muted-foreground">
                Empty means Aasim (aasim@lps-me.com). An approver who creates a project approves it automatically.
              </p>
            </div>
            <SaveBar
              dirty={dirty}
              pending={update.isPending}
              onReset={() => {
                setRequired(null);
                setApprovers(null);
              }}
              label="Save approval settings"
            />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
