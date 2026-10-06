import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LuBan, LuInbox } from "react-icons/lu";

import { TaskCard } from "@/components/tasks/task-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMoveTask } from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import {
  STATUS_META,
  TASK_STATUSES,
  allowedDropStatuses,
  positionBetween,
} from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Role, Task, TaskBoardResponse, TaskStatus } from "@/types";

const COLUMN_PREFIX = "column:";

function columnId(status: TaskStatus) {
  return `${COLUMN_PREFIX}${status}`;
}

/**
 * Kanban board (dnd-kit). Five fixed columns; cards can only be dropped where
 * the current user's role allows — other columns are dimmed and excluded from
 * collision detection while dragging. Moves are optimistic (see useMoveTask).
 */
export function TaskBoard({
  board,
  user,
  onOpen,
}: {
  board: TaskBoardResponse;
  user: { _id: string; role: Role };
  onOpen: (id: string) => void;
}) {
  const moveTask = useMoveTask();
  const toast = useToast();
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Where does each task live? (id → status)
  const statusById = useMemo(() => {
    const map = new Map<string, TaskStatus>();
    for (const status of TASK_STATUSES) {
      for (const task of board.columns[status] ?? []) map.set(task._id, status);
    }
    return map;
  }, [board]);

  const allowed = useMemo(
    () => new Set(activeTask ? allowedDropStatuses(activeTask, user) : []),
    [activeTask, user]
  );

  function statusOf(id: UniqueIdentifier): TaskStatus | undefined {
    const key = String(id);
    if (key.startsWith(COLUMN_PREFIX)) return key.slice(COLUMN_PREFIX.length) as TaskStatus;
    return statusById.get(key);
  }

  // Only consider droppables in allowed columns → disallowed targets never activate.
  const collisionDetection: CollisionDetection = (args) =>
    closestCorners({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => {
        const status = statusOf(container.id);
        return status !== undefined && allowed.has(status);
      }),
    });

  function handleDragStart(event: DragStartEvent) {
    const status = statusOf(event.active.id);
    const task = status
      ? board.columns[status].find((item) => item._id === String(event.active.id))
      : undefined;
    setActiveTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const task = activeTask;
    setActiveTask(null);
    const { over } = event;
    if (!task || !over) return;

    const targetStatus = statusOf(over.id);
    if (!targetStatus) return;
    if (!allowedDropStatuses(task, user).includes(targetStatus)) {
      toast.warning(`You can't move this task to ${STATUS_META[targetStatus].label}.`);
      return;
    }

    // Target column without the dragged card.
    const target = board.columns[targetStatus].filter((item) => item._id !== task._id);
    let index = target.length;
    const overId = String(over.id);
    if (!overId.startsWith(COLUMN_PREFIX)) {
      const overIndex = target.findIndex((item) => item._id === overId);
      if (overIndex >= 0) {
        const sourceIndex = board.columns[targetStatus].findIndex(
          (item) => item._id === task._id
        );
        const originalOverIndex = board.columns[targetStatus].findIndex(
          (item) => item._id === overId
        );
        // Same column, moving down → land after the hovered card.
        index =
          sourceIndex >= 0 && sourceIndex < originalOverIndex ? overIndex + 1 : overIndex;
      }
    }

    // No-op: same column, same slot.
    if (targetStatus === task.status) {
      const currentIndex = board.columns[targetStatus].findIndex((item) => item._id === task._id);
      if (currentIndex === index) return;
    }

    const position = positionBetween(target[index - 1]?.position, target[index]?.position);
    moveTask.mutate({ task, status: targetStatus, index, position });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTask(null)}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To pick up a task, press space or enter. Use the arrow keys to move it between columns, then press space or enter to drop it, or escape to cancel.",
        },
      }}
    >
      <div
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0 lg:snap-none"
        role="region"
        aria-label="Task board"
      >
        {TASK_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            tasks={board.columns[status] ?? []}
            total={board.totals[status] ?? 0}
            limit={board.limit}
            user={user}
            onOpen={onOpen}
            dragActive={activeTask !== null}
            dropAllowed={allowed.has(status)}
            isSource={activeTask?.status === status}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={{ duration: 180, easing: "ease-out" }}>
        {activeTask ? <TaskCard task={activeTask} dragging /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function BoardColumn({
  status,
  tasks,
  total,
  limit,
  user,
  onOpen,
  dragActive,
  dropAllowed,
  isSource,
}: {
  status: TaskStatus;
  tasks: Task[];
  total: number;
  limit: number;
  user: { _id: string; role: Role };
  onOpen: (id: string) => void;
  dragActive: boolean;
  dropAllowed: boolean;
  isSource: boolean;
}) {
  const meta = STATUS_META[status];
  const { setNodeRef, isOver } = useDroppable({
    id: columnId(status),
    disabled: dragActive && !dropAllowed,
  });
  const blocked = dragActive && !dropAllowed;

  return (
    <section
      aria-label={`${meta.label} column`}
      className={cn(
        "flex w-[min(19rem,85vw)] shrink-0 snap-start flex-col rounded-xl border bg-muted/40 transition-[opacity,border-color,background-color] duration-150 ease-out lg:w-auto lg:min-w-0 lg:flex-1",
        blocked && "border-dashed opacity-50",
        dragActive && dropAllowed && !isSource && "border-ring/50 bg-primary/5",
        isOver && "border-ring bg-primary/10"
      )}
    >
      <header className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden className={cn("size-2 rounded-full", meta.dot)} />
          {meta.label}
        </h2>
        <span
          className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums"
          aria-label={`${total} tasks`}
        >
          {total}
        </span>
      </header>

      <div ref={setNodeRef} className="flex min-h-40 flex-1 flex-col gap-2 px-2 pb-2">
        <SortableContext
          items={tasks.map((task) => task._id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <SortableTaskCard key={task._id} task={task} user={user} onOpen={onOpen} />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
            {blocked ? (
              <>
                <LuBan aria-hidden className="size-4" />
                Not allowed
              </>
            ) : (
              <>
                <LuInbox aria-hidden className="size-4" />
                {dragActive ? "Drop here" : "No tasks"}
              </>
            )}
          </div>
        )}

        {blocked && tasks.length > 0 && (
          <p className="flex items-center justify-center gap-1.5 py-1 text-xs text-muted-foreground">
            <LuBan aria-hidden className="size-3.5" />
            Not allowed
          </p>
        )}

        {total > limit && (
          <p className="px-1 pt-1 text-center text-xs text-muted-foreground">
            Showing {tasks.length} of {total}. Use filters or the list view to see more.
          </p>
        )}
      </div>
    </section>
  );
}

function SortableTaskCard({
  task,
  user,
  onOpen,
}: {
  task: Task;
  user: { _id: string; role: Role };
  onOpen: (id: string) => void;
}) {
  const canDrag = allowedDropStatuses(task, user).length > 0;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task._id,
    disabled: !canDrag,
  });

  return (
    <TaskCard
      ref={setNodeRef}
      task={task}
      onOpen={onOpen}
      disabled={!canDrag}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
      aria-roledescription={canDrag ? "draggable task" : undefined}
      aria-label={task.title}
    />
  );
}

export function TaskBoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading board">
      {TASK_STATUSES.map((status) => (
        <div
          key={status}
          className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border bg-muted/40 p-3 lg:w-auto lg:flex-1"
        >
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: status === "todo" ? 3 : 2 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}
