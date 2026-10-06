import { TimeLogsPage } from "@/components/timelogs/time-logs-page";

import type { Route } from "./+types/timelogs";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Time logs | Employee Management System" }];
}

/** Time logs: Mine / Team / Pending approval (`?tab=`), manual entry and approvals. */
export default function TimeLogs() {
  return <TimeLogsPage />;
}
