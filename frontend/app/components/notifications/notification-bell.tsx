import { useMemo, type ComponentType } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  CircleCheck,
  LoaderCircle,
  Megaphone,
  MessageSquareText,
  PartyPopper,
  XCircle,

} from "lucide-react";
import {
  LuAlarmClock,
  LuArrowRightLeft,
  LuAtSign,
  LuCalendarX,
  LuListChecks,
  LuListTodo,
  LuNotebookPen,
  LuListPlus,
  LuMessageSquare,
  LuPencil,
  LuActivity,
  LuCalendarClock,
  LuClock,
  LuFileCheck,
  LuFileClock,
  LuFileX,
  LuPaperclip,
  LuStickyNote,
  LuTimer,
  LuTimerOff,
  LuUserPlus,
  LuUserRoundCheck,
  LuFileWarning,
  LuCalendarRange,
  LuGraduationCap,
  LuCalendarPlus,
  LuShieldCheck,
  LuShieldQuestion,
  LuShieldX,
  LuTags,
  LuGitPullRequestArrow,
  LuScale,
  LuTriangleAlert,
} from "react-icons/lu";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useMarkAllAsRead,
  useMarkAsRead,
  useNotifications,
  useUnreadCount,
} from "@/hooks/use-notifications";
import { getErrorMessage } from "@/lib/api";
import type { Notification, NotificationType } from "@/types";

type NotificationIcon = ComponentType<{ className?: string }>;

const NOTIFICATION_ICONS: Record<NotificationType, NotificationIcon> = {
  leave_approved: PartyPopper,
  leave_rejected: XCircle,
  leave_requested: LuCalendarPlus,
  feedback_responded: MessageSquareText,
  announcement_created: Megaphone,
  review_assigned: ClipboardList,
  review_acknowledged: CheckCircle2,
  task_assigned: ClipboardList,
  task_completed: ClipboardCheck,
  task_approved: CircleCheck,
  task_rejected: XCircle,
  task_updated: LuPencil,
  task_status_changed: LuArrowRightLeft,
  task_comment: LuMessageSquare,
  task_mention: LuAtSign,
  subtask_created: LuListTodo,
  subtask_assigned: LuListPlus,
  subtask_completed: LuListChecks,
  task_note: LuNotebookPen,
  task_note_mention: LuAtSign,
  task_reminder: LuAlarmClock,
  task_overdue: LuCalendarX,
  project_member_added: LuUserPlus,
  project_status_changed: LuActivity,
  project_deadline: LuCalendarClock,
  pitch_milestone_missed: LuCalendarX,
  project_note: LuStickyNote,
  project_file: LuPaperclip,
  timelog_pending: LuClock,
  timelog_approved: CircleCheck,
  timelog_rejected: XCircle,
  timesheet_submitted: LuFileClock,
  timesheet_approved: LuFileCheck,
  timesheet_rejected: LuFileX,
  time_tracker_reminder: LuTimer,
  timer_auto_stopped: LuTimerOff,
  user_joined: LuUserRoundCheck,
  document_expiring: LuFileWarning,
  hr_date_upcoming: LuCalendarRange,
  training_assigned: LuGraduationCap,
  training_reminder: LuGraduationCap,
  project_approval_requested: LuShieldQuestion,
  project_approved: LuShieldCheck,
  project_rejected: LuShieldX,
  brand_approval_requested: LuTags,
  brand_approved: LuTags,
  brand_rejected: LuTags,
  change_approval_requested: LuGitPullRequestArrow,
  change_decided: LuScale,
  task_over_scope: LuTriangleAlert,
};

/** Theme tokens only — no palette colours. */
const NOTIFICATION_ICON_COLORS: Record<NotificationType, string> = {
  leave_approved: "text-primary",
  leave_rejected: "text-destructive",
  leave_requested: "text-chart-2",
  feedback_responded: "text-chart-2",
  announcement_created: "text-chart-4",
  review_assigned: "text-chart-3",
  review_acknowledged: "text-primary",
  task_assigned: "text-chart-2",
  task_completed: "text-chart-4",
  task_approved: "text-primary",
  task_rejected: "text-destructive",
  task_updated: "text-muted-foreground",
  task_status_changed: "text-chart-2",
  task_comment: "text-chart-3",
  task_mention: "text-primary",
  subtask_created: "text-chart-3",
  subtask_assigned: "text-chart-2",
  subtask_completed: "text-primary",
  task_note: "text-chart-3",
  task_note_mention: "text-primary",
  task_reminder: "text-chart-4",
  task_overdue: "text-destructive",
  project_member_added: "text-chart-2",
  project_status_changed: "text-chart-3",
  project_deadline: "text-chart-4",
  pitch_milestone_missed: "text-destructive",
  project_note: "text-chart-3",
  project_file: "text-muted-foreground",
  timelog_pending: "text-chart-4",
  timelog_approved: "text-primary",
  timelog_rejected: "text-destructive",
  timesheet_submitted: "text-chart-4",
  timesheet_approved: "text-primary",
  timesheet_rejected: "text-destructive",
  time_tracker_reminder: "text-chart-2",
  timer_auto_stopped: "text-chart-5",
  user_joined: "text-primary",
  document_expiring: "text-destructive",
  hr_date_upcoming: "text-chart-4",
  training_assigned: "text-chart-2",
  training_reminder: "text-chart-4",
  project_approval_requested: "text-chart-4",
  project_approved: "text-primary",
  project_rejected: "text-destructive",
  brand_approval_requested: "text-chart-4",
  brand_approved: "text-primary",
  brand_rejected: "text-destructive",
  change_approval_requested: "text-chart-4",
  change_decided: "text-chart-2",
  task_over_scope: "text-destructive",
};

/**
 * Bell icon with unread count badge. Clicking opens a popover panel showing
 * recent notifications with quick actions (mark read, navigate).
 */
export function NotificationBell() {
  const { data: unreadData, isPending: unreadPending } = useUnreadCount();
  const unreadCount = unreadData?.count ?? 0;

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" className="relative" aria-label="Notifications" />}
      >
        <Bell />
        {unreadPending ? null : unreadCount > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[0.6rem] font-bold text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <NotificationPanel />
      </PopoverContent>
    </Popover>
  );
}

/** The dropdown panel content. */
function NotificationPanel() {
  const navigate = useNavigate();
  const {
    data,
    isPending,
    isError,
    error,
  } = useNotifications({ limit: 20 });
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();

  const notifications = data?.notifications ?? [];
  const hasUnread = notifications.some((n) => !n.read);

  function handleNotificationClick(notification: Notification) {
    // Mark as read (fire-and-forget).
    if (!notification.read) {
      markAsRead.mutate(notification._id);
    }
    // Navigate to the linked page.
    // Task notifications open the detail sheet via /tasks?task=<id>.
    const target =
      notification.link ??
      (notification.task
        ? `/tasks?task=${notification.task}`
        : notification.project
          ? `/projects/${notification.project}`
          : null);
    if (target) {
      navigate(target);
    }
  }

  return (
    <div className="flex flex-col">
      <PopoverHeader className="flex flex-row items-center justify-between border-b px-3 py-2.5">
        <PopoverTitle className="text-sm">Notifications</PopoverTitle>
        {hasUnread && (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1 px-1.5 py-0.5 text-xs text-muted-foreground"
            onClick={() => markAllAsRead.mutate()}
            disabled={markAllAsRead.isPending}
          >
            {markAllAsRead.isPending ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <CheckCheck className="size-3" />
            )}
            Mark all read
          </Button>
        )}
      </PopoverHeader>

      <ScrollArea className="h-80">
        {isPending ? (
          <NotificationListSkeleton />
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {getErrorMessage(error)}
            </p>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Bell className="mb-2 size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium text-muted-foreground">No notifications</p>
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              You&apos;re all caught up!
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {notifications.map((notification) => (
              <NotificationItem
                key={notification._id}
                notification={notification}
                onClick={() => handleNotificationClick(notification)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function NotificationItem({
  notification,
  onClick,
}: {
  notification: Notification;
  onClick: () => void;
}) {
  // A type this build doesn't know yet (newer server) still renders.
  const Icon = NOTIFICATION_ICONS[notification.type] ?? Bell;
  const iconColor = NOTIFICATION_ICON_COLORS[notification.type] ?? "text-muted-foreground";

  const relativeTime = useMemo(
    () => formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true }),
    [notification.createdAt]
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 ${
        !notification.read ? "bg-accent/30" : ""
      }`}
    >
      <span className="mt-0.5 shrink-0">
        <Icon className={`size-4 ${iconColor}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-foreground">
          {notification.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {notification.message}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[0.65rem] text-muted-foreground/70">{relativeTime}</span>
          {notification.actor && (
            <span className="text-[0.65rem] text-muted-foreground/70">
              by {notification.actor.name}
            </span>
          )}
        </div>
      </div>
      {!notification.read && (
        <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
      )}
    </button>
  );
}

function NotificationListSkeleton() {
  return (
    <div className="space-y-0" aria-busy="true" aria-label="Loading notifications">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex gap-3 px-3 py-2.5">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
