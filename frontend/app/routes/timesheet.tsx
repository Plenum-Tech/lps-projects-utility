import { TimesheetPage } from "@/components/timelogs/timesheet-page";

import type { Route } from "./+types/timesheet";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Timesheet | Employee Management System" }];
}

/** Weekly timesheet grid (`?week=YYYY-MM-DD`): save a draft, submit for approval. */
export default function Timesheet() {
  return <TimesheetPage />;
}
