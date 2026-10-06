import { LuBell, LuCircleAlert, LuRefreshCw } from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useEmailPreferences,
  useUpdateEmailPreferences,
} from "@/hooks/use-email-preferences";
import { getErrorMessage } from "@/lib/api";
import type { EmailPreferences } from "@/types";

export const PREFERENCES: {
  key: keyof EmailPreferences;
  title: string;
  description: string;
  /** Only shown to admins (e.g. invitation acceptances). */
  adminOnly?: boolean;
  /** Only shown to admins and department heads (e.g. leave requests to review). */
  managersOnly?: boolean;
}[] = [
  {
    key: "taskAssigned",
    title: "Task assignments",
    description: "When a task or subtask is assigned to you.",
  },
  {
    key: "taskUpdates",
    title: "Task updates",
    description: "Status changes, edits, submissions and review decisions.",
  },
  {
    key: "taskComments",
    title: "Comments & mentions",
    description: "New comments on your tasks and when someone @mentions you.",
  },
  {
    key: "taskReminders",
    title: "Reminders",
    description: "Upcoming and overdue due dates, plus recurring task copies.",
  },
  {
    key: "projectUpdates",
    title: "Project updates",
    description: "Added to a project, status changes, deadlines, new notes and files.",
  },
  {
    key: "timeLogs",
    title: "Time tracking",
    description: "Time-log and timesheet approvals, rejections and tracker reminders.",
  },
  {
    key: "hrReminders",
    title: "HR reminders",
    description: "Document expiries, probation / notice / internship end dates.",
  },
  {
    key: "leaveRequests",
    title: "Leave requests",
    description: "When someone whose leave you approve applies for time off.",
    managersOnly: true,
  },
  {
    key: "teamUpdates",
    title: "Team updates",
    description: "When someone you invited accepts and joins.",
    adminOnly: true,
  },
];

/** Profile → per-category email switches. In-app notifications always stay on. */
export function EmailPreferencesCard() {
  const preferences = useEmailPreferences();
  const update = useUpdateEmailPreferences();
  const { data: currentUser } = useCurrentUser();
  const role = currentUser?.role;
  const visible = PREFERENCES.filter((pref) =>
    pref.adminOnly ? role === "admin" : pref.managersOnly ? role === "admin" || role === "head" : true
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuBell aria-hidden className="size-4 text-muted-foreground" />
          Notifications
        </CardTitle>
        <CardDescription>
          Choose which task, project and time-tracking emails you receive. You&apos;ll still see everything in the
          notification bell.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {preferences.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading email preferences">
            {visible.map((pref) => (
              <Skeleton key={pref.key} className="h-12 w-full" />
            ))}
          </div>
        ) : preferences.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t load your email preferences</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(preferences.error)}
              <Button variant="outline" size="sm" onClick={() => void preferences.refetch()}>
                <LuRefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <ul className="divide-y rounded-lg border">
            {visible.map((pref) => {
              const id = `email-pref-${pref.key}`;
              return (
                <li key={pref.key} className="flex items-center justify-between gap-4 px-3 py-3">
                  <div className="min-w-0">
                    <Label htmlFor={id}>{pref.title}</Label>
                    <p id={`${id}-description`} className="text-xs text-muted-foreground">
                      {pref.description}
                    </p>
                  </div>
                  <Switch
                    id={id}
                    checked={preferences.data[pref.key] ?? true}
                    onCheckedChange={(checked) => update.mutate({ [pref.key]: checked })}
                    aria-describedby={`${id}-description`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
