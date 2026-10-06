import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { IconType } from "react-icons";
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowRight,
  LuCircleCheck,
  LuCirclePlus,
  LuCopy,
  LuFlag,
  LuHistory,
  LuLoaderCircle,
  LuNotebookPen,
  LuPaperclip,
  LuPencil,
  LuTrash2,
  LuUserCog,
  LuUserMinus,
  LuUserPlus,
  LuWallet,
} from "react-icons/lu";

import { formatDateTime } from "@/lib/format";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectActivity } from "@/hooks/use-projects";
import { PROJECT_ACTIVITY_LABELS } from "@/lib/projects";
import { cn } from "@/lib/utils";
import type { ProjectActivity, ProjectActivityAction } from "@/types";

const PAGE = 30;

const ACTION_ICONS: Record<ProjectActivityAction, { icon: IconType; tone: string }> = {
  created: { icon: LuCirclePlus, tone: "bg-primary/10 text-primary" },
  updated: { icon: LuPencil, tone: "bg-muted text-muted-foreground" },
  status_changed: { icon: LuArrowRight, tone: "bg-chart-2/15 text-foreground" },
  member_added: { icon: LuUserPlus, tone: "bg-chart-3/15 text-foreground" },
  member_removed: { icon: LuUserMinus, tone: "bg-muted text-muted-foreground" },
  member_rate_changed: { icon: LuWallet, tone: "bg-muted text-muted-foreground" },
  manager_changed: { icon: LuUserCog, tone: "bg-chart-3/15 text-foreground" },
  milestone_created: { icon: LuFlag, tone: "bg-chart-4/15 text-foreground" },
  milestone_updated: { icon: LuFlag, tone: "bg-muted text-muted-foreground" },
  milestone_completed: { icon: LuCircleCheck, tone: "bg-primary/10 text-primary" },
  milestone_reopened: { icon: LuFlag, tone: "bg-chart-4/15 text-foreground" },
  milestone_deleted: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  file_added: { icon: LuPaperclip, tone: "bg-chart-2/15 text-foreground" },
  file_removed: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  note_added: { icon: LuNotebookPen, tone: "bg-chart-2/15 text-foreground" },
  note_updated: { icon: LuNotebookPen, tone: "bg-muted text-muted-foreground" },
  note_deleted: { icon: LuTrash2, tone: "bg-muted text-muted-foreground" },
  archived: { icon: LuArchive, tone: "bg-muted text-muted-foreground" },
  restored: { icon: LuArchiveRestore, tone: "bg-primary/10 text-primary" },
  duplicated: { icon: LuCopy, tone: "bg-muted text-muted-foreground" },
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function list(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length ? items.join(", ") : null;
}

/** Small contextual suffix from `details` (titles, filenames, status names). */
function detailSuffix(entry: ProjectActivity): string | null {
  const details = entry.details ?? {};
  switch (entry.action) {
    case "status_changed":
      return text(details.to) ? `now ${text(details.to)}` : null;
    case "updated":
      return list(details.fields);
    case "file_added":
      return list(details.files);
    case "file_removed":
      return text(details.filename);
    case "duplicated":
      return text(details.code) ? `as ${text(details.code)}` : null;
    case "milestone_created":
    case "milestone_updated":
    case "milestone_completed":
    case "milestone_reopened":
    case "milestone_deleted":
    case "note_added":
    case "note_updated":
    case "note_deleted":
      return text(details.title);
    default:
      return null;
  }
}

/** Activity tab: newest-first timeline with "Load more". */
export function ProjectActivityFeed({ projectId }: { projectId: string }) {
  const [limit, setLimit] = useState(PAGE);
  const activity = useProjectActivity(projectId, limit);
  const entries = activity.data?.activity ?? [];
  const total = activity.data?.total ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-lg font-semibold">Activity</h2>
        <p className="text-sm text-muted-foreground">Everything that happened on this project.</p>
      </div>

      {activity.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex gap-3">
              <Skeleton className="size-7 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : activity.isError ? (
        <QueryError
          title="Couldn't load activity"
          error={activity.error}
          onRetry={() => void activity.refetch()}
          retrying={activity.isRefetching}
        />
      ) : entries.length === 0 ? (
        <EmptyState icon={LuHistory} title="No activity yet" />
      ) : (
        <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          <ol className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-3.5 before:w-px before:bg-border">
            {entries.map((entry) => {
              const meta = ACTION_ICONS[entry.action] ?? ACTION_ICONS.updated;
              const Icon = meta.icon;
              const suffix = detailSuffix(entry);
              return (
                <li key={entry._id} className="relative flex gap-3">
                  <span
                    className={cn(
                      "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-card",
                      meta.tone
                    )}
                  >
                    <Icon aria-hidden className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-sm break-words text-foreground">
                      <span className="font-medium">{entry.actor?.name ?? "System"}</span>{" "}
                      <span className="text-muted-foreground">
                        {PROJECT_ACTIVITY_LABELS[entry.action] ?? "made a change"}
                      </span>
                      {suffix && <span className="text-foreground"> · {suffix}</span>}
                    </p>
                    <time
                      dateTime={entry.createdAt}
                      className="text-xs text-muted-foreground"
                      title={formatDateTime(entry.createdAt)}
                    >
                      {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
          {total > entries.length && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setLimit((current) => current + PAGE)}
              disabled={activity.isFetching}
            >
              {activity.isFetching && <LuLoaderCircle aria-hidden className="animate-spin" />}
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
