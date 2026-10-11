import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";
import type { DeliveryTrafficResponse } from "@/types";

function hours(h: number | null): string {
  if (h === null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round((h / 24) * 10) / 10} days`;
}

/**
 * Traffic desk: tasks waiting with a traffic manager (not yet routed to the
 * team) and how quickly tasks that came in via a traffic manager were assigned
 * onwards in the period — the traffic manager's own performance metric.
 */
export function TrafficDesk({ data }: { data: DeliveryTrafficResponse }) {
  if (!data.configured) {
    return (
      <p className="text-sm text-muted-foreground">
        No traffic manager is set. An admin adds them in Settings → Delivery → Traffic managers.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {(
          [
            ["Waiting with traffic", String(data.totals.waiting), "Open tasks not yet assigned to the team"],
            ["Assigned onwards", String(data.totals.routed), "Routed to the team in this period"],
            ["Average time to assign", hours(data.totals.avgHours), "From creation to the first team assignee"],
            ["Median time to assign", hours(data.totals.medianHours), "Half of the tasks were routed faster"],
          ] as const
        ).map(([label, value, hint]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Traffic manager</th>
              <th className="px-3 py-2 text-right font-medium">Waiting (unassigned)</th>
              <th className="px-3 py-2 text-right font-medium">Assigned onwards</th>
              <th className="px-3 py-2 text-right font-medium">Avg time to assign</th>
              <th className="px-3 py-2 text-right font-medium">Median</th>
            </tr>
          </thead>
          <tbody>
            {data.managers.map((m) => (
              <tr key={m.person.id ?? m.person.name} className="border-t">
                <td className="px-3 py-2 font-medium">{m.person.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.waiting}</td>
                <td className="px-3 py-2 text-right tabular-nums">{m.routed}</td>
                <td className="px-3 py-2 text-right tabular-nums">{hours(m.avgHours)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{hours(m.medianHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.waiting.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Waiting longest (not yet assigned to the team)</p>
          <ul className="divide-y rounded-lg border">
            {data.waiting.slice(0, 15).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <Link to={`/tasks?task=${t.id}`} className="min-w-0 truncate hover:underline">
                  <span className="font-mono text-xs text-muted-foreground">{t.code}</span> {t.title}
                  {t.project && <span className="text-xs text-muted-foreground"> · {t.project}</span>}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  with {t.manager.name}
                  <Badge variant={t.waitingDays > 2 ? "destructive" : "outline"}>
                    {t.waitingDays === 0 ? "today" : `${t.waitingDays} d`}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
