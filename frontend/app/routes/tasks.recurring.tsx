import { RecurringTasksPage } from "@/components/tasks/recurring-tasks-table";

import type { Route } from "./+types/tasks.recurring";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Recurring tasks | LPS" }];
}

/** Recurring task schedules: cycles, next run, copies, edit / stop / delete. */
export default function RecurringTasks() {
  return <RecurringTasksPage />;
}
