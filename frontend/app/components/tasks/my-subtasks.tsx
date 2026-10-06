import { LuCalendarDays, LuListTodo } from "react-icons/lu";

import { ShortCode } from "@/components/projects/project-badges";
import { useMySubtasks } from "@/hooks/use-tasks";
import { formatDateOnly, toDateInput, todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * "My subtasks": open subtasks assigned to me on tasks I'm not assigned to
 * (those tasks don't appear on my board). Renders nothing when there are none.
 */
export function MySubtasksStrip({ onOpen }: { onOpen: (taskId: string, subtaskId: string) => void }) {
  const query = useMySubtasks();
  const items = query.data ?? [];
  if (items.length === 0) return null;
  const today = todayKey();

  return (
    <section aria-labelledby="my-subtasks-heading" className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2">
        <LuListTodo aria-hidden className="size-4 text-primary" />
        <h2 id="my-subtasks-heading" className="text-sm font-semibold text-foreground">
          My subtasks
        </h2>
        <span className="rounded-full bg-muted px-1.5 text-[0.7rem] text-muted-foreground tabular-nums">
          {items.length}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          · on tasks you aren&apos;t assigned to
        </span>
      </div>
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
        {items.map((item) => {
          const overdue = Boolean(item.dueDate) && toDateInput(item.dueDate) < today;
          return (
            <li key={item._id} className="w-64 shrink-0 snap-start">
              <button
                type="button"
                onClick={() => onOpen(item.task._id, item._id)}
                className="flex h-full w-full flex-col gap-1 rounded-lg border bg-background p-2.5 text-left transition-colors duration-150 ease-out outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <span className="line-clamp-2 text-sm font-medium text-foreground">{item.title}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {item.task.shortCode && <ShortCode code={item.task.shortCode} />}
                  <span className="truncate">{item.task.title}</span>
                </span>
                <span
                  className={cn(
                    "mt-auto inline-flex items-center gap-1 text-xs",
                    overdue ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  <LuCalendarDays aria-hidden className="size-3" />
                  {item.dueDate ? `Due ${formatDateOnly(item.dueDate)}${overdue ? " · overdue" : ""}` : "No due date"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
