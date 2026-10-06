import { TaskWorkspace } from "@/components/tasks/task-workspace";

import type { Route } from "./+types/tasks";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Tasks | Employee Management System" }];
}

/** Tasks table / board / calendar / pinned / waiting approval, detail sheet (?task=<id>). */
export default function Tasks() {
  return <TaskWorkspace />;
}
