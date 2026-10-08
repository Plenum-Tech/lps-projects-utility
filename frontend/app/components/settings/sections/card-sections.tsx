import { LuBot, LuCircleCheck, LuCircleMinus, LuMail } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { PoliciesTab } from "@/components/leaves/manage-leaves";
import { EmailPreferencesCard, PREFERENCES } from "@/components/profile/email-preferences-card";
import { EmploymentCard } from "@/components/profile/employment-card";
import {
  ChangePasswordCard,
  DepartmentCard,
  PersonalInfoCard,
} from "@/components/profile/profile-cards";
import { ProjectCategoriesCard } from "@/components/projects/settings/project-categories-card";
import { ProjectReminderCard } from "@/components/projects/settings/project-reminder-card";
import { ProjectStatusesCard } from "@/components/projects/settings/project-statuses-card";
import { ProjectTypesCard } from "@/components/projects/settings/project-types-card";
import { TimeLogSettingsCard } from "@/components/projects/settings/time-log-settings-card";
import { ReminderSettingsCard } from "@/components/tasks/settings/reminder-settings-card";
import { SmtpStatusCard } from "@/components/tasks/settings/smtp-status-card";
import { TaskCategoriesCard } from "@/components/tasks/settings/task-categories-card";
import { TaskLabelsCard } from "@/components/tasks/settings/task-labels-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { useMeetingConfig } from "@/hooks/use-meetings";

/** Settings → Profile: name, employment details (read-only) and department. */
export function ProfileSection() {
  return (
    <div className="space-y-6">
      <PersonalInfoCard />
      <EmploymentCard />
      <DepartmentCard />
    </div>
  );
}

/** Settings → Security: change password. */
export function SecuritySection() {
  return <ChangePasswordCard />;
}

/** Settings → Notifications: own email switches; admins also get SMTP health + an event summary. */
export function NotificationSection() {
  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  return (
    <div className="space-y-6">
      <EmailPreferencesCard />
      {isAdmin && user && (
        <>
          <SmtpStatusCard adminEmail={user.email} />
          <EmailEventsCard />
        </>
      )}
    </div>
  );
}

function EmailEventsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuMail aria-hidden className="size-4 text-muted-foreground" />
          Which events send email
        </CardTitle>
        <CardDescription>
          Everyone can switch each category off for themselves. In-app notifications are always on, and
          account emails (invitations, sign-in help) are always sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-lg border">
          {PREFERENCES.map((pref) => (
            <li key={pref.key} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{pref.title}</p>
                <p className="text-xs text-muted-foreground">{pref.description}</p>
              </div>
              {pref.adminOnly && <Badge variant="outline">Admins</Badge>}
              {pref.managersOnly && <Badge variant="outline">Admins &amp; heads</Badge>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Settings → Tasks: labels, categories, due-date reminders. */
export function TaskSection() {
  return (
    <div className="space-y-6">
      <TaskLabelsCard />
      <TaskCategoriesCard />
      <ReminderSettingsCard />
    </div>
  );
}

/** Settings → Projects: statuses, name types, categories, deadline reminders. */
export function ProjectSection() {
  return (
    <div className="space-y-6">
      <ProjectStatusesCard />
      <ProjectTypesCard />
      <ProjectCategoriesCard />
      <ProjectReminderCard />
    </div>
  );
}

/** Settings → Time Logs: who logs time, approvals, auto-stop, reminders, daily report. */
export function TimeLogSection() {
  return <TimeLogSettingsCard />;
}

/** Settings → Leaves: per-type leave policies. */
export function LeaveSection() {
  return <PoliciesTab />;
}

/** Settings → Meetings: read-only AI extraction status. */
export function MeetingSection() {
  const config = useMeetingConfig();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuBot aria-hidden className="size-4 text-muted-foreground" />
          AI action-item extraction
        </CardTitle>
        <CardDescription>
          Optional Gemini pass that suggests action items from a meeting transcript. Configured on the server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {config.isPending ? (
          <Skeleton className="h-6 w-48" />
        ) : config.isError ? (
          <QueryError
            title="Couldn't check the AI status"
            error={config.error}
            onRetry={() => void config.refetch()}
            retrying={config.isRefetching}
          />
        ) : config.data.aiEnabled ? (
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LuCircleCheck aria-hidden className="size-4 text-primary" />
            Enabled — &quot;Extract with AI&quot; is available on meetings.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LuCircleMinus aria-hidden className="size-4 text-muted-foreground" />
            Off — the &quot;Extract with AI&quot; button is hidden on meetings.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          To turn it on, set <code className="font-mono">MEETING_AI_EXTRACTION=true</code> and a{" "}
          <code className="font-mono">GEMINI_API_KEY</code> in the backend environment, then restart the server.
        </p>
      </CardContent>
    </Card>
  );
}
