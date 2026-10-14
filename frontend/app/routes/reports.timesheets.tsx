import { AccessDenied } from "@/components/globals/query-states";
import { TimesheetReport } from "@/components/reports/timesheet-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.timesheets";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Weekly Timesheet Report | LPS" }];
}

/** Admins, leadership and heads (their department, server-side). */
export default function TimesheetReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  // Admins, leadership and heads (computed by the server).
  if (!(user.access?.timeReport ?? user.role !== "employee")) {
    return (
      <AccessDenied
        title="Not available"
        description="The weekly timesheet report is available to administrators, leadership and heads of department."
      />
    );
  }
  return <TimesheetReport role={user.role === "employee" ? "admin" : user.role} />;
}
