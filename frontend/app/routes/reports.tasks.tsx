import { TaskReport } from "@/components/reports/task-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.tasks";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Task Report | LPS" }];
}

/** View-only, open to everyone. */
export default function TaskReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  // View-only and open to everyone, across all departments.
  return <TaskReport role="admin" />;
}
