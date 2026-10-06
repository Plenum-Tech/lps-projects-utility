import { LuCalendarDays, LuListChecks } from "react-icons/lu";
import { Link } from "react-router";

import { tabsListVariants } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const LINKS = [
  { to: "/timesheet", label: "Weekly timesheet", icon: LuCalendarDays },
  { to: "/timelogs", label: "Time logs", icon: LuListChecks },
] as const;

/** Tab-styled switch between the weekly timesheet and the time-log list. */
export function TimeNav({ current }: { current: "/timesheet" | "/timelogs" }) {
  return (
    <nav aria-label="Time tracking views" className={cn(tabsListVariants(), "h-8")}>
      {LINKS.map(({ to, label, icon: Icon }) => {
        const active = to === current;
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active
                ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                : "text-foreground/60 hover:text-foreground dark:text-muted-foreground"
            )}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
