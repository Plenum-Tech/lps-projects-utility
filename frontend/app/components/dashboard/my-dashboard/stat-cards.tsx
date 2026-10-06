import type { IconType } from "react-icons";
import { LuFolderKanban, LuListTodo } from "react-icons/lu";
import { Link } from "react-router";

import { cn } from "@/lib/utils";

interface Stat {
  label: string;
  value: number;
  to: string;
  tone: "primary" | "destructive";
}

/** Two large linked numbers (e.g. Pending · Overdue). */
function StatPairCard({ title, icon: Icon, stats }: { title: string; icon: IconType; stats: [Stat, Stat] }) {
  return (
    <section aria-label={title} className="rounded-xl border bg-card text-card-foreground">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 font-heading text-sm font-semibold text-foreground">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </h2>
      <div className="grid grid-cols-2 divide-x">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            to={stat.to}
            aria-label={`${stat.value} ${stat.label.toLowerCase()} ${title.toLowerCase()}`}
            className="group px-4 py-3 outline-none transition-colors duration-150 first:rounded-bl-xl last:rounded-br-xl hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <span
              className={cn(
                "block font-heading text-3xl font-semibold tabular-nums",
                stat.tone === "primary" ? "text-primary" : "text-destructive"
              )}
            >
              {stat.value}
            </span>
            <span className="block text-xs text-muted-foreground group-hover:text-foreground">
              {stat.label}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function TasksStatCard({ pending, overdue }: { pending: number; overdue: number }) {
  return (
    <StatPairCard
      title="Tasks"
      icon={LuListTodo}
      stats={[
        { label: "Pending", value: pending, to: "/tasks?mine=on", tone: "primary" },
        { label: "Overdue", value: overdue, to: "/tasks?mine=on&overdue=on", tone: "destructive" },
      ]}
    />
  );
}

export function ProjectsStatCard({
  inProgress,
  overdue,
  projectsHref,
}: {
  inProgress: number;
  overdue: number;
  /** /projects, plus `?member=<me>` for admins and heads. */
  projectsHref: string;
}) {
  const join = projectsHref.includes("?") ? "&" : "?";
  return (
    <StatPairCard
      title="Projects"
      icon={LuFolderKanban}
      stats={[
        { label: "In progress", value: inProgress, to: projectsHref, tone: "primary" },
        { label: "Overdue", value: overdue, to: `${projectsHref}${join}deadline=overdue`, tone: "destructive" },
      ]}
    />
  );
}
