import { ProjectWorkspace } from "@/components/projects/project-workspace";

import type { Route } from "./+types/projects";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Projects | LPS" }];
}

/** Projects table (List / Archive / Calendar / Pinned), filters in the URL, bulk actions. */
export default function Projects() {
  return <ProjectWorkspace />;
}
