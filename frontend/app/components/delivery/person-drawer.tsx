import { LuCircleCheck, LuUserRound } from "react-icons/lu";

import { TaskBrandCell, TaskCell } from "@/components/delivery/actions-section";
import { BrandName } from "@/components/delivery/brand-dot";
import { DASH, fmtDays, fmtNum, fmtPct, lowRateTone, overdueTone, rateTone, TONE_TEXT, type Tone } from "@/components/delivery/delivery-format";
import { PanelState } from "@/components/delivery/delivery-ui";
import { WeeklyBars, WeeklyTable } from "@/components/delivery/weekly-charts";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useDeliveryPerson } from "@/hooks/use-delivery";
import { formatDateOnly } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryFilters } from "@/types";

/** Person drawer: stats, brand breakdown, weekly trend and open work. */
export function PersonDrawer({
  personId,
  personName,
  filters,
  onClose,
  onOpenTask,
}: {
  personId: string | null;
  personName: string;
  filters: DeliveryFilters;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const query = useDeliveryPerson(personId, filters);
  const data = query.data && query.data.person.id === personId ? query.data : undefined;

  return (
    <Sheet open={Boolean(personId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-xl">
        <SheetHeader className="border-b p-4 pr-12">
          <SheetTitle className="flex items-center gap-2">
            <LuUserRound aria-hidden className="size-4 text-muted-foreground" />
            {data?.person.name ?? personName}
          </SheetTitle>
          <SheetDescription>
            {data
              ? [data.person.team.name, data.person.department?.name !== data.person.team.name ? data.person.department?.name : null]
                  .filter(Boolean)
                  .join(" · ") || "No department"
              : "Delivery for the selected period and filters."}
          </SheetDescription>
          {data && !data.stats.ranked && (
            <Badge variant="outline" className="w-fit">
              Not ranked — fewer than {data.minCompletedToRank} completed
            </Badge>
          )}
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <PanelState
            query={{ ...query, isPending: query.isPending || (!data && query.isFetching) }}
            errorTitle="Couldn't load this person"
            skeletonHeight="h-96"
          >
            {() =>
              data && (
                <>
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat label="Completed" value={fmtNum(data.stats.completed)} />
                    <Stat label="On time" value={fmtPct(data.stats.onTimePct)} tone={rateTone(data.stats.onTimePct)} />
                    <Stat label="Mean days" value={fmtDays(data.stats.meanDays)} />
                    <Stat label="Rework share" value={fmtPct(data.stats.reworkPct)} tone={lowRateTone(data.stats.reworkPct)} />
                    <Stat label="Open now" value={fmtNum(data.stats.open)} />
                    <Stat label="Overdue now" value={fmtNum(data.stats.overdue)} tone={overdueTone(data.stats.overdue, data.stats.open)} />
                  </dl>

                  <section aria-labelledby="drawer-brands" className="space-y-2">
                    <h3 id="drawer-brands" className="text-sm font-medium">
                      Brands
                    </h3>
                    {data.brands.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No brand activity in this period.</p>
                    ) : (
                      <div className="overflow-x-auto rounded-lg border">
                        <table className="w-full text-sm">
                          <caption className="sr-only">Brand breakdown</caption>
                          <thead>
                            <tr className="border-b text-xs text-muted-foreground">
                              <th scope="col" className="h-9 px-3 text-left font-medium">Brand</th>
                              <th scope="col" className="h-9 px-3 text-right font-medium">Completed</th>
                              <th scope="col" className="h-9 px-3 text-right font-medium">On time</th>
                              <th scope="col" className="h-9 px-3 text-right font-medium">Open</th>
                              <th scope="col" className="h-9 px-3 text-right font-medium">Overdue</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.brands.map((row) => (
                              <tr key={row.brand.id} className="border-b last:border-0">
                                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                                  <BrandName name={row.brand.name} color={row.brand.color} noBrand={row.brand.noBrand} className="max-w-40" />
                                </th>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(row.completed)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmtPct(row.onTimePct)}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(row.open)}</td>
                                <td className={cn("px-3 py-1.5 text-right tabular-nums", row.overdue > 0 && "text-critical")}>
                                  {fmtNum(row.overdue)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section aria-labelledby="drawer-weekly" className="space-y-2">
                    <h3 id="drawer-weekly" className="text-sm font-medium">
                      Completed per week
                    </h3>
                    {data.weekly.weeks.every((week) => week.completed === 0) ? (
                      <p className="text-sm text-muted-foreground">Nothing completed in this period.</p>
                    ) : (
                      <>
                        <WeeklyBars weeks={data.weekly.weeks} dataKey="completed" className="h-40" />
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground">Table view</summary>
                          <div className="mt-2">
                            <WeeklyTable weeks={data.weekly.weeks} columns={[{ key: "completed", format: fmtNum }]} />
                          </div>
                        </details>
                      </>
                    )}
                  </section>

                  <section aria-labelledby="drawer-open" className="space-y-2">
                    <h3 id="drawer-open" className="text-sm font-medium">
                      Open work <span className="text-muted-foreground">({data.openWork.length})</span>
                    </h3>
                    {data.openWork.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                        <LuCircleCheck aria-hidden className="size-4" />
                        No open tasks.
                      </div>
                    ) : (
                      <ul className="divide-y rounded-lg border">
                        {data.openWork.map((task) => (
                          <li key={task.id}>
                            <button
                              type="button"
                              onClick={() => onOpenTask(task.id)}
                              className="flex w-full flex-col gap-1 px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                            >
                              <TaskCell task={task} className="max-w-none" />
                              <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                                <TaskBrandCell task={task} />
                                <span>Due {task.dueDate ? formatDateOnly(task.dueDate) : DASH}</span>
                                {task.daysLate !== null && <span className="font-medium text-critical">{task.daysLate} d late</span>}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )
            }
          </PanelState>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn("mt-1 font-heading text-xl font-semibold tabular-nums", value === DASH ? "text-muted-foreground" : TONE_TEXT[tone])}>
        {value}
      </dd>
    </div>
  );
}
