import { AccessDenied } from "@/components/globals/query-states";
import { TimesheetPerformancePage } from "@/components/timelogs/timesheet-performance";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/timesheet.performance";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timesheet performance | LPS" }];
}

/** Estimate vs actual, rework time and brand hours — leadership. */
export default function TimesheetPerformanceRoute() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (!user.leadership) {
    return <AccessDenied title="Leadership only" description="Timesheet performance is available to leadership." />;
  }
  return <TimesheetPerformancePage />;
}
