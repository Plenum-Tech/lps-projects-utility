import { GuestTaskWorkspace } from "@/components/tasks/guest-task-workspace";
import { TaskWorkspace } from "@/components/tasks/task-workspace";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/tasks";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Tasks | LPS" }];
}

/**
 * Tasks table / board / calendar / pinned / waiting approval, detail sheet (?task=<id>).
 * Outside guests get the plain list of the tasks they were invited to.
 */
export default function Tasks() {
  const { data: user } = useCurrentUser();
  return user?.isGuest ? <GuestTaskWorkspace /> : <TaskWorkspace />;
}
