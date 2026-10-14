import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LuLink2Off } from "react-icons/lu";

import { OptionSelect } from "@/components/projects/project-fields";
import { useUpdateProject } from "@/hooks/use-projects";
import type { ManpowerRow } from "@/types";

/**
 * Manpower page: the month's projects that match no plan line. Plan editors
 * pick the line here (saved on the project as its manpower plan line).
 */
export function UnlinkedProjects({
  projects,
  rows,
  canEdit,
}: {
  projects: Array<{ _id: string; code: string; name: string }>;
  rows: ManpowerRow[];
  canEdit: boolean;
}) {
  const update = useUpdateProject();
  const queryClient = useQueryClient();
  if (projects.length === 0) return null;
  const options = rows.map((r) => ({
    value: r.key,
    label: r.name,
    description: [r.brand?.name ?? "No brand", r.type].filter(Boolean).join(" · "),
  }));

  return (
    <section
      aria-labelledby="unlinked-projects-heading"
      className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 sm:p-4"
    >
      <div>
        <h3 id="unlinked-projects-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
          <LuLink2Off aria-hidden className="size-4" />
          {projects.length} project{projects.length === 1 ? "" : "s"} not linked to the plan
        </h3>
        <p className="text-xs text-muted-foreground">
          {canEdit
            ? "Pick the brand line each project belongs to. It's saved on the project and used by Delivery Pulse."
            : "A plan editor can link these to their brand line."}
        </p>
      </div>
      <ul className="divide-y text-sm">
        {projects.map((project) => (
          <li key={project._id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
            <Link to={`/projects/${project._id}`} className="min-w-0 truncate text-foreground hover:underline">
              <span className="mr-2 font-mono text-xs text-muted-foreground">{project.code}</span>
              {project.name}
            </Link>
            {canEdit && (
              <OptionSelect
                aria-label={`Plan line for ${project.name}`}
                className="w-full sm:w-72"
                value=""
                placeholder="Choose a plan line…"
                options={options}
                disabled={update.isPending}
                onChange={(key) => {
                  if (!key) return;
                  update.mutate(
                    { id: project._id, input: { manpowerRow: key } },
                    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["manpower"] }) },
                  );
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
