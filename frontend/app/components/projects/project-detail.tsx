import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import type { IconType } from "react-icons";
import {
  LuActivity,
  LuClipboardList,
  LuClock,
  LuFlag,
  LuFolderX,
  LuLayoutDashboard,
  LuMessagesSquare,
  LuNotebookPen,
  LuPaperclip,
  LuUsers,
} from "react-icons/lu";

import { EmptyState, QueryError } from "@/components/globals/query-states";
import { MeetingsWorkspace } from "@/components/meetings/meetings-workspace";
import { ProjectActivityFeed } from "@/components/projects/project-activity";
import { errorStatus } from "@/components/projects/project-fields";
import { ProjectFiles } from "@/components/projects/project-files";
import { ProjectHeader } from "@/components/projects/project-header";
import { ProjectMembers } from "@/components/projects/project-members";
import { ProjectMilestones } from "@/components/projects/project-milestones";
import { ProjectNotes } from "@/components/projects/project-notes";
import { ProjectOverview } from "@/components/projects/project-overview";
import { TaskWorkspace } from "@/components/tasks/task-workspace";
import { TimeLogPanel } from "@/components/timelogs/time-log-panel";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProject, useProjectRealtime } from "@/hooks/use-projects";
import { ProjectApprovalBanner } from "@/components/projects/project-approval";

const TABS = [
  "overview",
  "tasks",
  "meetings",
  "milestones",
  "members",
  "files",
  "notes",
  "timelogs",
  "activity",
] as const;
type ProjectDetailTab = (typeof TABS)[number];

const TAB_META: Record<ProjectDetailTab, { label: string; icon: IconType }> = {
  overview: { label: "Overview", icon: LuLayoutDashboard },
  tasks: { label: "Tasks", icon: LuClipboardList },
  meetings: { label: "Meetings", icon: LuMessagesSquare },
  milestones: { label: "Milestones", icon: LuFlag },
  members: { label: "Members", icon: LuUsers },
  files: { label: "Files", icon: LuPaperclip },
  notes: { label: "Notes", icon: LuNotebookPen },
  timelogs: { label: "Time logs", icon: LuClock },
  activity: { label: "Activity", icon: LuActivity },
};

function isTab(value: string | null): value is ProjectDetailTab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

/** The /projects/:id page: header, actions and the tabbed workspace. */
export function ProjectDetail({ projectId }: { projectId: string }) {
  useProjectRealtime();
  const detail = useProject(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab: ProjectDetailTab = isTab(rawTab) ? rawTab : "overview";

  const changeTab = useCallback(
    (next: ProjectDetailTab) => {
      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          if (next === "overview") updated.delete("tab");
          else updated.set("tab", next);
          // The task detail sheet only belongs to the Tasks tab.
          if (next !== "tasks") updated.delete("task");
          return updated;
        },
        { preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  if (detail.isPending) return <ProjectDetailSkeleton />;

  if (detail.isError) {
    const status = errorStatus(detail.error);
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {status === 403 || status === 404 ? (
          <EmptyState
            icon={LuFolderX}
            title="Project unavailable"
            description={
              status === 404
                ? "This project doesn't exist or was deleted."
                : "You don't have access to this project."
            }
            className="py-16"
          >
            <Link to="/projects" className={buttonVariants({ variant: "outline" })}>
              Back to projects
            </Link>
          </EmptyState>
        ) : (
          <QueryError
            title="Couldn't load the project"
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isRefetching}
          />
        )}
      </div>
    );
  }

  const { project, permissions } = detail.data;
  const archived = Boolean(project.archivedAt);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <ProjectHeader project={project} permissions={permissions} />
      <ProjectApprovalBanner project={project} permissions={permissions} />

      <Tabs
        value={tab}
        onValueChange={(value) => isTab(String(value)) && changeTab(value as ProjectDetailTab)}
        className="mt-6 gap-5"
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList variant="line" className="w-max min-w-full justify-start border-b pb-0.5">
            {TABS.map((key) => {
              const Icon = TAB_META[key].icon;
              return (
                <TabsTrigger key={key} value={key} className="flex-none px-2.5">
                  <Icon aria-hidden />
                  {TAB_META[key].label}
                  {key === "members" && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {project.members.length}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="overview">
          <ProjectOverview detail={detail.data} />
        </TabsContent>
        <TabsContent value="tasks">
          {tab === "tasks" && (
            <TaskWorkspace
              project={{
                _id: project._id,
                name: project.name,
                code: project.code,
                canCreateTasks: permissions.canCreateTasks && !archived && !project.expired,
                // New projects take no tasks until they have a scope (the brand's, usually).
                noScope:
                  project.requiresScope && !(project.scopeItems?.length ?? 0)
                    ? { addScopeHref: project.brand?._id ? `/brands/${project.brand._id}` : null }
                    : null,
              }}
            />
          )}
        </TabsContent>
        <TabsContent value="meetings">
          {tab === "meetings" && (
            <MeetingsWorkspace project={{ _id: project._id, archived }} />
          )}
        </TabsContent>
        <TabsContent value="milestones">
          {tab === "milestones" && (
            <ProjectMilestones
              projectId={project._id}
              canManage={permissions.canManageMilestones && !archived}
            />
          )}
        </TabsContent>
        <TabsContent value="members">
          <ProjectMembers project={project} permissions={permissions} />
        </TabsContent>
        <TabsContent value="files">
          {tab === "files" && (
            <ProjectFiles
              projectId={project._id}
              canUpload={permissions.canUploadFiles && !archived}
            />
          )}
        </TabsContent>
        <TabsContent value="notes">
          {tab === "notes" && (
            <ProjectNotes project={project} canAdd={permissions.canAddNotes && !archived} />
          )}
        </TabsContent>
        <TabsContent value="timelogs">
          {tab === "timelogs" && (
            <TimeLogPanel
              projectId={project._id}
              canLogTime={permissions.canLogTime}
              manualAllowed={project.manualTimeLogs || permissions.isManager}
            />
          )}
        </TabsContent>
        <TabsContent value="activity">
          {tab === "activity" && <ProjectActivityFeed projectId={project._id} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProjectDetailSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8"
      aria-busy="true"
      aria-label="Loading project"
    >
      <Skeleton className="h-4 w-28" />
      <div className="flex items-start gap-4">
        <Skeleton className="size-15 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <Skeleton className="h-9 w-full max-w-2xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
      </div>
    </div>
  );
}
