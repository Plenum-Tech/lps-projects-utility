import type { IconType } from "react-icons";
import { LuCake, LuDoorOpen, LuGraduationCap, LuHourglass, LuPartyPopper, LuTreePalm } from "react-icons/lu";

import {
  CardEmpty,
  DashboardCard,
  PersonRow,
  inDaysPhrase,
} from "@/components/dashboard/my-dashboard/dashboard-card";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { MyDashboard, MyDashboardHrDate } from "@/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function Chip({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "primary" | "warning" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        tone === "primary" && "bg-primary/10 text-primary",
        tone === "warning" && "bg-chart-4/15 text-foreground",
        tone === "muted" && "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

/** Upcoming birthdays (day + month only — never the year). */
export function BirthdaysCard({ items, total }: { items: MyDashboard["birthdays"]; total: number }) {
  return (
    <DashboardCard title="Birthdays" icon={LuCake} badge={total || undefined}>
      {items.length === 0 ? (
        <CardEmpty icon={LuCake} />
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <PersonRow
              key={item.user._id}
              name={item.user.name}
              designation={item.user.designation}
              trailing={
                <>
                  <Chip tone={item.inDays === 0 ? "primary" : "muted"}>
                    <span aria-hidden>🎂</span> {item.day} {MONTHS[item.month - 1]}
                  </Chip>
                  <span className={cn("text-xs", item.inDays === 0 ? "font-medium text-primary" : "text-muted-foreground")}>
                    {inDaysPhrase(item.inDays)}
                  </span>
                </>
              }
            />
          ))}
        </ul>
      )}
      {total > items.length && <MoreNote count={total - items.length} />}
    </DashboardCard>
  );
}

export function OnLeaveTodayCard({ items, total }: { items: MyDashboard["onLeaveToday"]; total: number }) {
  return (
    <DashboardCard title="On leave today" icon={LuTreePalm} badge={total || undefined}>
      {items.length === 0 ? (
        <CardEmpty icon={LuTreePalm} />
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <PersonRow
              key={item.user._id}
              name={item.user.name}
              designation={item.user.designation}
              trailing={
                <span className="text-xs text-muted-foreground">
                  until <span className="font-medium text-foreground">{formatPlainDate(item.until, "d MMM")}</span>
                </span>
              }
            />
          ))}
        </ul>
      )}
      {total > items.length && <MoreNote count={total - items.length} />}
    </DashboardCard>
  );
}

export function JoiningsCard({
  items,
  total,
}: {
  items: MyDashboard["joiningsAndAnniversaries"];
  total: number;
}) {
  return (
    <DashboardCard title="Today's joinings & work anniversaries" icon={LuPartyPopper} badge={total || undefined}>
      {items.length === 0 ? (
        <CardEmpty icon={LuPartyPopper} />
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <PersonRow
              key={`${item.user._id}-${item.kind}`}
              name={item.user.name}
              designation={item.user.designation}
              trailing={
                item.kind === "joining" ? (
                  <Chip tone="primary">Joined today</Chip>
                ) : (
                  <Chip tone="warning">
                    {item.years} year{item.years === 1 ? "" : "s"} today <span aria-hidden>🎉</span>
                  </Chip>
                )
              }
            />
          ))}
        </ul>
      )}
      {total > items.length && <MoreNote count={total - items.length} />}
    </DashboardCard>
  );
}

const HR_CARDS = {
  probation: { title: "Probation ending", icon: LuHourglass },
  notice: { title: "Notice period", icon: LuDoorOpen },
  internship: { title: "Internship ending", icon: LuGraduationCap },
} satisfies Record<string, { title: string; icon: IconType }>;

/** Probation / notice / internship end dates (scoped by the server's hrScope). */
export function HrDateCard({
  kind,
  items,
  total,
}: {
  kind: keyof typeof HR_CARDS;
  items: (MyDashboardHrDate & { startDate?: string | null })[];
  total: number;
}) {
  const meta = HR_CARDS[kind];
  return (
    <DashboardCard title={meta.title} icon={meta.icon} badge={total || undefined}>
      {items.length === 0 ? (
        <CardEmpty icon={meta.icon} />
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <PersonRow
              key={item.user._id}
              name={item.user.name}
              designation={item.user.designation}
              trailing={
                <>
                  <span className="text-xs font-medium text-foreground tabular-nums">
                    {kind === "notice" && item.startDate
                      ? `${formatPlainDate(item.startDate, "d MMM")} – `
                      : ""}
                    {formatPlainDate(item.date)}
                  </span>
                  <span className={cn("text-xs", item.inDays <= 7 ? "font-medium text-chart-4" : "text-muted-foreground")}>
                    {inDaysPhrase(item.inDays)}
                  </span>
                </>
              }
            />
          ))}
        </ul>
      )}
      {total > items.length && <MoreNote count={total - items.length} />}
    </DashboardCard>
  );
}

function MoreNote({ count }: { count: number }) {
  return (
    <p className="border-t px-4 py-2 text-xs text-muted-foreground">
      +{count} more
    </p>
  );
}
