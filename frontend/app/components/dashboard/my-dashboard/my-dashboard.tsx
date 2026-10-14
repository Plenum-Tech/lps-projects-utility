import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { DocumentExpiriesCard } from "@/components/dashboard/my-dashboard/document-expiries";
import { MyCalendar, MyCalendarLegend } from "@/components/dashboard/my-dashboard/my-calendar";
import { MyTasksTable } from "@/components/dashboard/my-dashboard/my-tasks-table";
import {
  BirthdaysCard,
  HrDateCard,
  JoiningsCard,
  OnLeaveTodayCard,
} from "@/components/dashboard/my-dashboard/people-cards";
import {
  MyPeriodPicker,
  periodCaption,
  periodDays,
  projectLinks,
  taskLinks,
  useMyDashboardPeriod,
} from "@/components/dashboard/my-dashboard/period";
import { ProfileCard } from "@/components/dashboard/my-dashboard/profile-card";
import { ProjectsStatCard, TasksStatCard } from "@/components/dashboard/my-dashboard/stat-cards";
import { WeekTimelogs } from "@/components/dashboard/my-dashboard/week-timelogs";
import { WelcomeClock } from "@/components/dashboard/my-dashboard/welcome-clock";
import { MissingTimeCard } from "@/components/tasks/missing-time";
import { QueryError } from "@/components/globals/query-states";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";
import { myDashboardKeys, useMyDashboard } from "@/hooks/use-my-dashboard";
import type { MyDashboard as MyDashboardData } from "@/types";

/**
 * Personal dashboard (every role): welcome + clock, profile, people cards on
 * the left (~5/12); tasks / projects stats, week time logs, document expiries,
 * my tasks and my calendar on the right (~7/12). Stacks on mobile.
 */
export function MyDashboard({ toggle }: { toggle?: ReactNode }) {
  const { data: user } = useCurrentUser();
  const [period, setPeriod] = useMyDashboardPeriod();
  const query = useMyDashboard(period);
  const queryClient = useQueryClient();
  const [openTask, setOpenTask] = useState<{ id: string; subtaskId?: string } | null>(null);

  const data = query.data;
  const firstName = (data?.profile.name ?? user?.name ?? "").split(" ")[0];

  function closeTask() {
    setOpenTask(null);
    // The sheet may have changed status / due dates — refresh the cards.
    void queryClient.invalidateQueries({ queryKey: myDashboardKeys.all });
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {toggle && <div className="mb-4">{toggle}</div>}
      <WelcomeClock name={firstName} extra={<MyPeriodPicker value={period} onChange={setPeriod} />} />
      <MissingTimeCard onOpenTask={(id) => setOpenTask({ id })} />

      {query.isPending ? (
        <MyDashboardSkeleton />
      ) : query.isError || !data ? (
        <QueryError
          className="mt-6"
          title="Couldn't load your dashboard"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      ) : (
        <MyDashboardGrid
          data={data}
          // Previous period's numbers stay on screen (dimmed) until the new ones arrive.
          loading={query.isPlaceholderData}
          onOpenTask={(id, subtaskId) => setOpenTask({ id, subtaskId })}
        />
      )}

      {user && (
        <TaskDetailSheet
          taskId={openTask?.id ?? null}
          subtaskId={openTask?.subtaskId ?? null}
          me={{ _id: user._id, role: user.role }}
          onClose={closeTask}
        />
      )}
    </div>
  );
}

function MyDashboardGrid({
  data,
  loading,
  onOpenTask,
}: {
  data: MyDashboardData;
  loading: boolean;
  onOpenTask: (taskId: string, subtaskId?: string) => void;
}) {
  const { profile, counts, totals, hrScope } = data;
  // Captions and links follow the period the numbers were computed for.
  const caption = periodCaption(data.period.key);
  const links = taskLinks(data.period);
  const projectHrefs = projectLinks(data.period, profile._id);
  // Restricted HR cards: always for heads/admins (department / all); for
  // "self" only when the viewer has a date coming up.
  const showHr = (count: number) => hrScope !== "self" || count > 0;

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-5 lg:gap-6">
        <ProfileCard
          profile={profile}
          counts={counts}
          projectsHref={projectHrefs.inProgress}
          openTasksHref={links.open}
          caption={caption}
          loading={loading}
        />
        <BirthdaysCard items={data.birthdays} total={totals.birthdays} />
        <OnLeaveTodayCard items={data.onLeaveToday} total={totals.onLeaveToday} />
        <JoiningsCard items={data.joiningsAndAnniversaries} total={totals.joiningsAndAnniversaries} />
        {showHr(totals.probation) && (
          <HrDateCard kind="probation" items={data.probation} total={totals.probation} />
        )}
        {showHr(totals.notice) && <HrDateCard kind="notice" items={data.notice} total={totals.notice} />}
        {showHr(totals.internship) && (
          <HrDateCard kind="internship" items={data.internship} total={totals.internship} />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:col-span-7 lg:gap-6">
        <div className="grid gap-4 lg:gap-6">
          <TasksStatCard
            counts={counts}
            completed={data.completedTasks}
            caption={caption}
            links={links}
            loading={loading}
          />
          <ProjectsStatCard
            counts={counts}
            completed={data.completedProjects}
            caption={caption}
            links={projectHrefs}
            loading={loading}
          />
        </div>
        <WeekTimelogs
          initial={data.weekTimelogs}
          today={data.today}
          periodMinutes={data.loggedMinutes}
          periodCaption={caption}
        />
        <DocumentExpiriesCard
          items={data.documentExpiries}
          total={totals.documentExpiries}
          showOwner={hrScope !== "self"}
        />
        <MyTasksTable
          tasks={data.myTasks}
          total={counts.openTasks}
          onOpen={(id) => onOpenTask(id)}
          viewAllHref={links.open}
          caption={caption}
          allTime={data.period.key === "all"}
          loading={loading}
        />
        <div className="space-y-2">
          <MyCalendar
            key={data.period.key}
            onOpenTask={onOpenTask}
            periodFrom={data.period.from}
            periodDays={periodDays(data.period.key)}
          />
          <MyCalendarLegend />
        </div>
      </div>
    </div>
  );
}

function MyDashboardSkeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-6" aria-busy="true" aria-label="Loading dashboard">
      <div className="flex flex-col gap-4 lg:col-span-5 lg:gap-6">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
      <div className="flex flex-col gap-4 lg:col-span-7 lg:gap-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:gap-6">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
