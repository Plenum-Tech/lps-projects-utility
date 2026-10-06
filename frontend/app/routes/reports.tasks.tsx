import { AccessDenied } from "@/components/globals/query-states";
import { TaskReport } from "@/components/reports/task-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.tasks";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Task Report | LPS" }];
}

/** Head/admin only — heads are limited to their department server-side. */
export default function TaskReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") {
    return (
      <AccessDenied
        title="Managers only"
        description="The task report is available to department heads and administrators."
      />
    );
  }
  return <TaskReport role={user.role} />;
}
