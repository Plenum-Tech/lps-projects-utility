import { redirect } from "react-router";

import type { Route } from "./+types/tasks";

/** Legacy admin task page — task management now lives at /tasks for every role. */
export function clientLoader({ request }: Route.ClientLoaderArgs) {
  const { search } = new URL(request.url);
  return redirect(`/tasks${search}`);
}

export default function AdminTasksRedirect() {
  return null;
}
