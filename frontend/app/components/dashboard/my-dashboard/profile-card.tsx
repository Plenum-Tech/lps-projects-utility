import { LuBuilding2, LuIdCard } from "react-icons/lu";
import { Link } from "react-router";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { MyDashboard } from "@/types";

/** Avatar, name, designation, employee ID, department + open tasks / projects counts for the period. */
export function ProfileCard({
  profile,
  counts,
  projectsHref,
  openTasksHref,
  caption,
  loading,
}: {
  profile: MyDashboard["profile"];
  counts: MyDashboard["counts"];
  projectsHref: string;
  openTasksHref: string;
  /** "last 30 days" / "all time". */
  caption: string;
  loading?: boolean;
}) {
  return (
    <section aria-label="My profile" className="rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center gap-4 p-4">
        <Avatar className="size-14">
          <AvatarFallback className="text-base font-semibold">
            {profile.avatarInitials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-lg font-semibold text-foreground">
            {profile.name}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {profile.designation || "No designation set"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <LuIdCard aria-hidden className="size-3.5" />
              Employee ID:{" "}
              <span className="font-mono text-foreground">{profile.employeeId ?? "—"}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <LuBuilding2 aria-hidden className="size-3.5" />
              <span className="truncate">{profile.department?.name ?? "No department"}</span>
            </span>
          </div>
        </div>
      </div>
      <div
        aria-busy={loading || undefined}
        className={cn("grid grid-cols-2 divide-x border-t transition-opacity duration-150", loading && "opacity-60")}
      >
        <CountLink to={openTasksHref} label="Open tasks" caption={caption} value={counts.openTasks} />
        <CountLink to={projectsHref} label="Projects" caption={caption} value={counts.projects} />
      </div>
    </section>
  );
}

function CountLink({ to, label, caption, value }: { to: string; label: string; caption: string; value: number }) {
  return (
    <Link
      to={to}
      className="group px-4 py-3 outline-none transition-colors duration-150 first:rounded-bl-xl last:rounded-br-xl hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <span className="block text-xs text-muted-foreground group-hover:text-foreground">
        {label}
        <span className="text-muted-foreground/80"> · {caption}</span>
      </span>
      <span className="block font-heading text-xl font-semibold text-foreground tabular-nums">
        {value}
      </span>
    </Link>
  );
}
