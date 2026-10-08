import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuFolderKanban, LuListTodo } from "react-icons/lu";
import { Link } from "react-router";

import { countDelta } from "@/components/dashboard/my-dashboard/period";
import { DeltaPill } from "@/components/delivery/delivery-ui";
import { cn } from "@/lib/utils";
import type { MyDashboard } from "@/types";

interface Stat {
  label: string;
  value: number;
  to: string;
  tone: "primary" | "destructive" | "good";
  /** Extra line under the caption (on-time share, delta pill). */
  detail?: ReactNode;
  /** Accessible extra text for the link. */
  srDetail?: string;
  /** What the number counts (tooltip + screen readers), e.g. "assigned to you, not completed". */
  hint?: string;
}

const TONE: Record<Stat["tone"], string> = {
  primary: "text-primary",
  destructive: "text-destructive",
  good: "text-good",
};

/** Linked numbers (e.g. Pending · Overdue · Completed); captions name the period. */
function StatGroupCard({
  title,
  icon: Icon,
  stats,
  caption,
  loading,
}: {
  title: string;
  icon: IconType;
  stats: Stat[];
  /** "last 30 days" / "all time". */
  caption: string;
  loading?: boolean;
}) {
  return (
    <section
      aria-label={title}
      aria-busy={loading || undefined}
      className="rounded-xl border bg-card text-card-foreground"
    >
      <h2 className="flex items-center gap-2 border-b px-4 py-3 font-heading text-sm font-semibold text-foreground">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h2>
      <div
        className={cn(
          "grid divide-x transition-opacity duration-150",
          stats.length === 3 ? "grid-cols-3" : "grid-cols-2",
          loading && "opacity-60"
        )}
      >
        {stats.map((stat) => (
          <Link
            key={stat.label}
            to={stat.to}
            title={stat.hint ? `${stat.label} · ${stat.hint}` : undefined}
            aria-label={`${stat.value} ${stat.label.toLowerCase()} ${title.toLowerCase()}, ${caption}${stat.hint ? `, ${stat.hint}` : ""}${stat.srDetail ? `, ${stat.srDetail}` : ""}`}
            className="group min-w-0 px-3 py-3 outline-none transition-colors duration-150 first:rounded-bl-xl last:rounded-br-xl hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-4"
          >
            <span className={cn("block font-heading text-3xl font-semibold tabular-nums", TONE[stat.tone])}>
              {stat.value}
            </span>
            <span className="block text-xs text-muted-foreground group-hover:text-foreground">
              {stat.label}
              <span className="text-muted-foreground/80"> · {caption}</span>
            </span>
            {stat.detail && <span className="mt-1 flex flex-wrap items-center gap-1">{stat.detail}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}

function CompletedDetail({ onTimePct, delta }: { onTimePct?: number | null; delta: ReturnType<typeof countDelta> }) {
  return (
    <>
      {onTimePct !== undefined && (
        <span className="text-[0.7rem] font-medium text-muted-foreground tabular-nums">
          {onTimePct === null ? "— on time" : `${onTimePct.toFixed(1).replace(/\.0$/, "")}% on time`}
        </span>
      )}
      {delta && <DeltaPill delta={delta} unit="count" compact />}
    </>
  );
}

export function TasksStatCard({
  counts,
  completed,
  caption,
  links,
  loading,
}: {
  counts: MyDashboard["counts"];
  completed: MyDashboard["completedTasks"];
  caption: string;
  links: { pending: string; overdue: string; completed: string };
  loading?: boolean;
}) {
  const delta = countDelta(completed.count, completed.previous);
  return (
    <StatGroupCard
      title="Tasks"
      icon={LuListTodo}
      caption={caption}
      loading={loading}
      stats={[
        {
          label: "Pending",
          value: counts.pendingTasks,
          to: links.pending,
          tone: "primary",
          hint: "assigned to you, not completed",
        },
        {
          label: "Overdue",
          value: counts.overdueTasks,
          to: links.overdue,
          tone: "destructive",
          hint: "pending, due before today",
        },
        {
          label: "Completed",
          value: completed.count,
          to: links.completed,
          tone: "good",
          detail: <CompletedDetail onTimePct={completed.onTimePct} delta={delta} />,
          srDetail: [
            completed.onTimePct !== null ? `${completed.onTimePct}% on time` : null,
            completed.previous !== null ? `${completed.previous} in the previous period` : null,
          ]
            .filter(Boolean)
            .join(", "),
        },
      ]}
    />
  );
}

export function ProjectsStatCard({
  counts,
  completed,
  caption,
  links,
  loading,
}: {
  counts: MyDashboard["counts"];
  completed: MyDashboard["completedProjects"];
  caption: string;
  /** /projects filtered exactly like each number (see projectLinks). */
  links: { inProgress: string; overdue: string; completed: string };
  loading?: boolean;
}) {
  const delta = countDelta(completed.count, completed.previous);
  return (
    <StatGroupCard
      title="Projects"
      icon={LuFolderKanban}
      caption={caption}
      loading={loading}
      stats={[
        {
          label: "In progress",
          value: counts.projectsInProgress,
          to: links.inProgress,
          tone: "primary",
          hint: "you're a member, progress < 100%",
        },
        {
          label: "Overdue",
          value: counts.projectsOverdue,
          to: links.overdue,
          tone: "destructive",
          hint: "in progress, deadline passed",
        },
        {
          label: "Completed",
          value: completed.count,
          to: links.completed,
          hint: "you're a member, moved to a completed status",
          tone: "good",
          detail: delta ? <CompletedDetail delta={delta} /> : undefined,
          srDetail: completed.previous !== null ? `${completed.previous} in the previous period` : undefined,
        },
      ]}
    />
  );
}
