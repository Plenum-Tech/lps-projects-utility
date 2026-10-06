import { AccessDenied } from "@/components/globals/query-states";
import { TimesheetReport } from "@/components/reports/timesheet-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.timesheets";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Weekly Timesheet Report | Employee Management System" }];
}

/** Head/admin only — heads are limited to their department server-side. */
export default function TimesheetReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") {
    return (
      <AccessDenied
        title="Managers only"
        description="The weekly timesheet report is available to department heads and administrators."
      />
    );
  }
  return <TimesheetReport role={user.role} />;
}
