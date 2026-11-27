import { Checkbox } from "@/components/ui/checkbox";
import { useTickDeliverable } from "@/hooks/use-tasks";
import type { Task } from "@/types";

/**
 * A task that covers several deliverables (Video 1, 4, 9 and Static 2): each one ticked off as it
 * gets done. A completed task counts them all as done.
 */
export function DeliverableTicks({ task }: { task: Task }) {
  const tick = useTickDeliverable();
  const items = task.titleParts?.items ?? [];
  if (items.length < 2) return null;
  const closed = task.status === "completed" || task.status === "rejected";
  const blocked = task.overScope?.status === "pending" || task.overScope?.status === "rejected";
  const isDone = (done?: boolean) => task.status === "completed" || Boolean(done);
  const doneCount = items.filter((d) => isDone(d.done)).length;
  const groups = new Map<string, typeof items>();
  for (const d of items) groups.set(d.unit, [...(groups.get(d.unit) ?? []), d]);
  return (
    <section className="rounded-lg border p-3" aria-label="Deliverables in this task">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Deliverables in this task</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {doneCount} of {items.length} done
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${(doneCount / items.length) * 100}%` }} />
      </div>
      <div className="mt-3 space-y-2.5">
        {[...groups.entries()].map(([unit, list]) => (
          <div key={unit}>
            {groups.size > 1 && <p className="mb-1 text-xs font-medium text-muted-foreground">{unit}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {list.map((d) => {
                const id = `tick-${task._id}-${unit}-${d.n}`;
                return (
                  <label key={d.n} htmlFor={id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      id={id}
                      checked={isDone(d.done)}
                      disabled={closed || blocked || tick.isPending}
                      onCheckedChange={(checked) => tick.mutate({ id: task._id, unit: d.unit, n: d.n, done: checked === true })}
                    />
                    <span className={isDone(d.done) ? "text-muted-foreground line-through" : undefined}>
                      {unit} {d.n}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {!closed && !blocked && <p className="mt-2 text-xs text-muted-foreground">Tick each one as it gets done. Completing the task counts them all as done.</p>}
    </section>
  );
}
