import { ProjectDetail } from "@/components/projects/project-detail";

import type { Route } from "./+types/projects.$id";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Project | Employee Management System" }];
}

/** Project detail — header actions and tabs (synced to `?tab=`). */
export default function ProjectPage({ params }: Route.ComponentProps) {
  // Re-mount on navigation between projects so per-project state resets.
  return <ProjectDetail key={params.id} projectId={params.id} />;
}
