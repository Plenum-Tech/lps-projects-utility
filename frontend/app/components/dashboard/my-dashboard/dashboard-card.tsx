import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuArrowRight } from "react-icons/lu";
import { Link } from "react-router";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Card shell for the personal dashboard: icon + title, optional count badge,
 * optional header extra and a "View all" link.
 */
export function DashboardCard({
  title,
  icon: Icon,
  badge,
  headerExtra,
  viewAll,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon: IconType;
  badge?: ReactNode;
  headerExtra?: ReactNode;
  viewAll?: { to: string; label?: string };
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground", className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 font-heading text-sm font-semibold text-foreground">
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{title}</span>
          {badge !== undefined && badge !== null && badge !== false && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
              {badge}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {headerExtra}
          {viewAll && (
            <Link
              to={viewAll.to}
              className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {viewAll.label ?? "View all"}
              <LuArrowRight aria-hidden className="size-3" />
            </Link>
          )}
        </div>
      </header>
      <div className={cn("min-w-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Designed empty state inside a dashboard card. */
export function CardEmpty({
  icon: Icon,
  text = "No record found",
  className,
}: {
  icon: IconType;
  text?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground",
        className
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
        <Icon aria-hidden className="size-4" />
      </span>
      {text}
    </div>
  );
}

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Avatar + name + designation row used by the people cards. */
export function PersonRow({
  name,
  designation,
  trailing,
}: {
  name: string;
  designation?: string;
  trailing?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Avatar className="size-8">
        <AvatarFallback className="text-xs">{initialsOf(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{designation || "—"}</p>
      </div>
      {trailing && <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">{trailing}</div>}
    </li>
  );
}

/** "Today" / "Tomorrow" / "in 3 days" / "1 month after" (Worksuite wording). */
export function inDaysPhrase(inDays: number): string {
  if (inDays <= 0) return "Today";
  if (inDays === 1) return "Tomorrow";
  if (inDays >= 30) return "1 month after";
  return `in ${inDays} days`;
}
