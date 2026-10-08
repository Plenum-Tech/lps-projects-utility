import { LuClipboardList } from "react-icons/lu";

import { CardEmpty, DashboardCard } from "@/components/dashboard/my-dashboard/dashboard-card";
import { LabelChip } from "@/components/tasks/label-chip";
import { STATUS_META } from "@/lib/tasks";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { MyDashboard } from "@/types";

/**
 * Compact "most urgent first" table of my open tasks. The body scrolls inside
 * the card (~6 rows); a row opens the task sheet.
 */
export function MyTasksTable({
  tasks,
  total,
  onOpen,
  viewAllHref,
  caption,
  allTime,
  loading,
}: {
  tasks: MyDashboard["myTasks"];
  /** Open tasks assigned to me in the period (for the badge). */
  total: number;
  onOpen: (taskId: string) => void;
  /** /tasks filtered like this list (mine, open, created or due in the period). */
  viewAllHref: string;
  /** "last 30 days" / "all time". */
  caption: string;
  allTime: boolean;
  loading?: boolean;
}) {
  return (
    <DashboardCard
      title="My tasks"
      icon={LuClipboardList}
      badge={total}
      headerExtra={<span className="text-xs text-muted-foreground">{caption}</span>}
      viewAll={{ to: viewAllHref }}
      className={cn("transition-opacity duration-150", loading && "opacity-60")}
    >
      {tasks.length === 0 ? (
        <CardEmpty
          icon={LuClipboardList}
          text={allTime ? "No open tasks — you're all caught up" : `No open tasks created or due in the ${caption}`}
        />
      ) : (
        <div className="max-h-[19.5rem] overflow-auto" aria-busy={loading || undefined}>
          <table className="w-full text-sm">
            <caption className="sr-only">My most urgent open tasks</caption>
            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-semibold whitespace-nowrap">Task#</th>
                <th scope="col" className="px-2 py-2 font-semibold">Task</th>
                <th scope="col" className="hidden px-2 py-2 font-semibold sm:table-cell">Status</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold whitespace-nowrap">Due date</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {tasks.map((task) => {
                const status = STATUS_META[task.status];
                return (
                  <tr
                    key={task._id}
                    onClick={() => onOpen(task._id)}
                    className="cursor-pointer align-top transition-colors duration-150 hover:bg-muted/50"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
                      {task.code}
                    </td>
                    <td className="min-w-0 px-2 py-2.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(task._id);
                        }}
                        className="line-clamp-2 rounded-sm text-left font-medium text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        {task.title}
                      </button>
                      {(task.labels.length > 0 || task.project) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {task.labels.slice(0, 3).map((label) => (
                            <LabelChip key={label._id} name={label.name} color={label.color} />
                          ))}
                          {task.labels.length === 0 && task.project && (
                            <span className="truncate text-xs text-muted-foreground">{task.project.name}</span>
                          )}
                        </div>
                      )}
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
                        <span aria-hidden className={cn("size-2 rounded-full", status.dot)} />
                        {status.label}
                      </span>
                    </td>
                    <td className="hidden px-2 py-2.5 whitespace-nowrap sm:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span aria-hidden className={cn("size-2 rounded-full", status.dot)} />
                        {status.label}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right text-xs whitespace-nowrap tabular-nums",
                        task.overdue ? "font-medium text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {task.dueDate ? formatPlainDate(task.dueDate, "d MMM") : "—"}
                      {task.overdue && <span className="sr-only"> (overdue)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </DashboardCard>
  );
}
