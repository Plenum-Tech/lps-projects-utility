import { useState } from "react";

import { TaskComments } from "@/components/tasks/task-comments";
import { TaskFiles } from "@/components/tasks/task-files";
import { TimeLogPanel } from "@/components/timelogs/time-log-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Role, Task, TaskPermissions } from "@/types";

export type WorkTab = "comments" | "files" | "time";

/**
 * Comments, files and time for a task — shown in the Edit / Update task form
 * (the task page itself only shows the rework history).
 */
export function TaskWorkSections({
  task,
  permissions,
  me,
  initialTab = "comments",
}: {
  task: Task;
  permissions: TaskPermissions;
  me: { _id: string; role: Role };
  initialTab?: WorkTab;
}) {
  // Projects can switch manual entries off (their managers can still add them).
  const manualOff = task.project?.manualTimeLogs === false && !permissions.canEdit;
  const [tab, setTab] = useState<WorkTab>(task.project || initialTab !== "time" ? initialTab : "comments");
  return (
    <section className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
      <Tabs value={tab} onValueChange={(value) => setTab(value as WorkTab)}>
        <TabsList className="no-scrollbar w-full justify-start overflow-x-auto sm:justify-center">
          <TabsTrigger value="comments">
            Comments{task.commentCount > 0 ? ` (${task.commentCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="files">Files{task.fileCount > 0 ? ` (${task.fileCount})` : ""}</TabsTrigger>
          {task.project && <TabsTrigger value="time">Time</TabsTrigger>}
        </TabsList>
        <TabsContent value="comments" className="pt-3">
          <TaskComments taskId={task._id} me={me} />
        </TabsContent>
        <TabsContent value="files" className="pt-3">
          <TaskFiles
            taskId={task._id}
            me={me}
            canManageAll={permissions.canDelete || me.role === "admin"}
            subtasks={task.subtasks}
          />
        </TabsContent>
        {task.project && (
          <TabsContent value="time" className="space-y-3 pt-3">
            {manualOff && (
              <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Manual time entries are off for this project.</span> Use the
                timer, or enter the time spent when you mark the task complete. The project&apos;s manager, its creator or
                an admin can turn them on in Projects → Edit → &ldquo;Allow manual time logs&rdquo;.
              </p>
            )}
            <TimeLogPanel taskId={task._id} canLogTime={Boolean(permissions.canLogTime)} manualAllowed={!manualOff} />
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
