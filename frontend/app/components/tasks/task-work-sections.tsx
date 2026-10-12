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
          <TabsContent value="time" className="pt-3">
            <TimeLogPanel taskId={task._id} canLogTime={Boolean(permissions.canLogTime)} manualAllowed />
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
