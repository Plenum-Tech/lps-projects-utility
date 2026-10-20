/**
 * Shared frontend types mirroring the backend DTOs (see backend/src).
 * The backend strips `password` and `__v` via its Mongoose toJSON transform.
 */

export type Role = "admin" | "employee" | "head";

/** Mirrors the backend User model as returned by the API (Mongoose toJSON). */
export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role;
  /** What menus may show (from /auth/me). */
  access?: { timeReport: boolean; brandCreator?: boolean; /** Admins (not the brand creators): rename brands, applied at once. */ brandRename?: boolean };
  /** Leadership (project approvers): admin powers everywhere; `role` comes back as "admin". */
  leadership?: boolean;
  /** Department id when assigned (single department per employee). */
  department?: string | null;
  /** Email notification switches (present on /auth/me and user responses). */
  emailPreferences?: EmailPreferences;
  /** Default hourly rate for time-log earnings (admin-editable). */
  hourlyRate?: number;
  /** Project ids pinned by this user. */
  pinnedProjects?: string[];
  /* HR fields (self / admin responses only). Date-only values are UTC-midnight ISO strings. */
  designation?: string;
  employeeId?: string | null;
  dateOfBirth?: string | null;
  joiningDate?: string | null;
  probationEndDate?: string | null;
  internshipEndDate?: string | null;
  noticePeriodStart?: string | null;
  noticePeriodEnd?: string | null;
  /** True for imported accounts that must set a password via a link before signing in. */
  passwordSetupRequired?: boolean;
  /** An admin set a default password: ask for a new one at sign-in. */
  mustChangePassword?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors the backend Department model as returned by the API (Mongoose toJSON). */
export interface Department {
  _id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** Present on the admin list response. */
  memberCount?: number;
  /** Present on the detail response. */
  members?: DepartmentMember[];
}

/** Minimal user shape returned inside a department's member list. */
export interface DepartmentMember {
  _id: string;
  name: string;
  email: string;
  role: Role;
}

/** POST/PATCH /api/departments body. */
export interface DepartmentInput {
  name: string;
  description?: string;
}

/** PUT /api/departments/:id/employees body. */
export interface SetDepartmentEmployeesInput {
  userIds: string[];
}

/** Successful department responses are wrapped as `{ department }`. */
export interface DepartmentResponse {
  department: Department;
}

export interface DepartmentListResponse {
  departments: Department[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

export interface MyDepartmentResponse {
  department: Department | null;
}

export interface UsersListResponse {
  users: User[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

/** POST /api/auth/login body. */
export interface LoginInput {
  email: string;
  password: string;
}

/** POST /api/users body (admin-only endpoint). */
export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role?: Role;
  department?: string | null;
  hourlyRate?: number;
  /* HR fields — "YYYY-MM-DD"; "" / null clears (employeeId: blank → auto on create). */
  designation?: string | null;
  employeeId?: string | null;
  dateOfBirth?: string | null;
  joiningDate?: string | null;
  probationEndDate?: string | null;
  internshipEndDate?: string | null;
  noticePeriodStart?: string | null;
  noticePeriodEnd?: string | null;
}

/** PATCH /api/users/:id body (admin-only endpoint). */
export interface UpdateUserInput {
  name?: string;
  email?: string;
  role?: Role;
  /** Department id, or null to unassign. */
  department?: string | null;
  /** Optional password reset — omitted/empty keeps the current password. */
  password?: string;
  hourlyRate?: number;
  /* HR fields — "YYYY-MM-DD"; "" / null clears (employeeId: blank → auto on create). */
  designation?: string | null;
  employeeId?: string | null;
  dateOfBirth?: string | null;
  joiningDate?: string | null;
  probationEndDate?: string | null;
  internshipEndDate?: string | null;
  noticePeriodStart?: string | null;
  noticePeriodEnd?: string | null;
}

/** PATCH /api/users/me body — employees may only change name + password. */
export interface UpdateProfileInput {
  name?: string;
  currentPassword?: string;
  password?: string;
}

/** GET /api/users/me — own profile with the department populated. */
export interface MyProfile extends Omit<User, "department"> {
  department: { _id: string; name: string } | null;
}

/** Successful auth/user responses are wrapped as `{ user }`. */
export interface UserResponse {
  user: User;
}

/** Every action the activity log records — mirrors the backend `ACTIVITY_ACTIONS` enum. */
export type ActivityAction =
  | "login"
  | "login_failed"
  | "logout"
  | "user_created"
  | "user_updated"
  | "user_deleted"
  | "profile_updated"
  | "department_created"
  | "department_updated"
  | "department_deleted"
  | "department_members_updated"
  | "leave_created"
  | "leave_cancelled"
  | "leave_approved"
  | "leave_rejected"
  | "leave_balance_adjusted"
  | "leave_policy_updated"
  | "announcement_created"
  | "announcement_updated"
  | "announcement_deleted"
  | "feedback_created"
  | "feedback_responded"
  | "feedback_resolved"
  | "feedback_reopened"
  | "attendance_marked"
  | "attendance_bulk_marked"
  | "review_created"
  | "review_generated"
  | "review_acknowledged"
  | "review_completed"
  | "review_deleted"
  | "goal_updated"
  | "task_created"
  | "task_status_updated"
  | "task_submitted"
  | "task_reviewed"
  | "task_updated"
  | "task_deleted"
  | "task_settings_updated"
  | "ai_insight_deleted"
  | "project_created"
  | "project_updated"
  | "project_archived"
  | "project_deleted"
  | "timelog_reviewed"
  | "timesheet_reviewed"
  | "project_settings_updated"
  | "user_invited"
  | "invitation_resent"
  | "invitation_revoked"
  | "invitation_accepted"
  | "document_created"
  | "document_updated"
  | "document_deleted"
  | "meeting_created"
  | "meeting_deleted"
  | "meeting_tasks_created"
  | "settings_updated"
  | "import_completed"
  | "import_undone"
  | "password_reset"
  | "pearity_tag_created"
  | "pearity_key_created"
  | "pearity_key_revoked"
  | "pearity_settings_updated"
  | "training_created"
  | "training_updated"
  | "training_archived"
  | "training_deleted"
  | "training_completed";

/** Mirrors the backend ActivityLog model as returned by the API (Mongoose toJSON). */
export interface ActivityLog {
  _id: string;
  action: ActivityAction;
  /** Actor user id — null for failed logins (no matching user). */
  actor?: string | null;
  /** Snapshots so entries stay readable even after the actor/target is deleted. */
  actorName?: string;
  actorEmail?: string;
  actorRole?: Role;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: string;
}

/** GET /api/activity-logs response. */
export interface ActivityLogListResponse {
  logs: ActivityLog[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

/* ------------------------------------------------------------------ */
/* Leaves                                                              */
/* ------------------------------------------------------------------ */

/** Fixed leave types — mirrors the backend `LeaveType` enum. */
export type LeaveType = "annual" | "sick" | "personal" | "unpaid";

/** Mirrors the backend `LeaveStatus` enum. */
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

/** Status filter used by the admin requests list ("all" = no filter). */
export type LeaveStatusFilter = LeaveStatus | "all";

/** Per-employee annual leave balance for the tracked types (unpaid is not tracked). */
export interface LeaveBalance {
  /** The calendar year this balance applies to. */
  year: number;
  annual: number;
  sick: number;
  personal: number;
}

/** Mirrors the backend Leave model as returned by the API (user populated). */
export interface Leave {
  _id: string;
  user: Pick<User, "_id" | "name" | "email">;
  leaveType: LeaveType;
  /** Date-only strings (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  /** Inclusive calendar days between start and end. */
  days: number;
  reason: string;
  status: LeaveStatus;
  /** Admin / department head who decided it (populated with name in list responses). */
  decidedBy?: Pick<User, "_id" | "name"> | string | null;
  decisionNote?: string;
  decidedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/leaves body. */
export interface LeaveInput {
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  reason: string;
}

/** Admin-tunable per-type limits. */
export interface LeavePolicy {
  _id: string;
  leaveType: LeaveType;
  maxDaysPerRequest: number;
  maxDaysPerYear: number;
}

/** Successful leave responses are wrapped as `{ leave }`. */
export interface LeaveResponse {
  leave: Leave;
}

export interface LeaveListResponse {
  leaves: Leave[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

export interface LeaveBalanceResponse {
  balance: LeaveBalance;
}

/** GET /api/leaves/balances response (admin). */
export interface LeaveBalancesResponse {
  balances: {
    user: Pick<User, "_id" | "name" | "email">;
    balance: LeaveBalance;
  }[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

export interface LeavePolicyResponse {
  policy: LeavePolicy;
}

export interface LeavePolicyListResponse {
  policies: LeavePolicy[];
}

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

/** Mirrors the backend Announcement model as returned by the API (author + department populated). */
export interface Announcement {
  _id: string;
  title: string;
  body: string;
  department: Pick<Department, "_id" | "name">;
  author: Pick<User, "_id" | "name">;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/announcements and PATCH /api/announcements/:id body. */
export interface AnnouncementInput {
  title: string;
  body: string;
  /** Admin-only: the department to post to (heads post to their own). */
  department?: string;
}

/** Successful announcement responses are wrapped as `{ announcement }`. */
export interface AnnouncementResponse {
  announcement: Announcement;
}

export interface AnnouncementListResponse {
  announcements: Announcement[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

/** Fixed feedback categories — mirrors the backend `FeedbackCategory` enum. */
export type FeedbackCategory = "suggestion" | "complaint" | "praise" | "other";

/** Mirrors the backend `FeedbackStatus` enum. */
export type FeedbackStatus = "open" | "resolved";

/** Status filter used by feedback lists ("all" = no filter). */
export type FeedbackStatusFilter = FeedbackStatus | "all";

/** Mirrors the backend Feedback model as returned by the API. */
export interface Feedback {
  _id: string;
  /** Submitter — null for anonymous submissions on admin views (the owner always sees themselves). */
  author: Pick<User, "_id" | "name" | "email"> | null;
  isAnonymous: boolean;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  /** The latest admin response, if any. */
  response?: {
    body: string;
    respondedBy: Pick<User, "_id" | "name"> | null;
    respondedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/feedback body. */
export interface FeedbackInput {
  message: string;
  category: FeedbackCategory;
  /** When true, admins see the submission as "Anonymous". */
  isAnonymous?: boolean;
}

/** PATCH /api/feedback/:id body (admin-only). */
export interface FeedbackUpdateInput {
  response?: string;
  status?: FeedbackStatus;
}

/** Successful feedback responses are wrapped as `{ feedback }`. */
export interface FeedbackResponse {
  feedback: Feedback;
}

export interface FeedbackListResponse {
  feedback: Feedback[];
  /** Total rows matching the filter (before pagination). */
  total: number;
  /** Applied page size — null when the endpoint returned all rows (no limit sent). */
  limit: number | null;
  offset: number;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

/** Fixed notification types — mirrors the backend `NOTIFICATION_TYPES` enum. */
export type NotificationType =
  | "leave_approved"
  | "leave_rejected"
  | "leave_requested"
  | "feedback_responded"
  | "announcement_created"
  | "review_assigned"
  | "review_acknowledged"
  | "task_assigned"
  | "task_completed"
  | "task_approved"
  | "task_rejected"
  | "task_updated"
  | "task_status_changed"
  | "task_comment"
  | "task_mention"
  | "subtask_created"
  | "subtask_assigned"
  | "subtask_completed"
  | "task_note"
  | "task_note_mention"
  | "task_reminder"
  | "task_overdue"
  | "project_member_added"
  | "project_status_changed"
  | "project_deadline"
  | "pitch_milestone_missed"
  | "project_note"
  | "project_file"
  | "timelog_pending"
  | "timelog_approved"
  | "timelog_rejected"
  | "timesheet_submitted"
  | "timesheet_approved"
  | "timesheet_rejected"
  | "time_tracker_reminder"
  | "timer_auto_stopped"
  | "user_joined"
  | "document_expiring"
  | "hr_date_upcoming"
  | "training_assigned"
  | "training_reminder"
  | "project_approval_requested"
  | "project_approved"
  | "project_rejected"
  | "brand_approval_requested"
  | "brand_approved"
  | "brand_rejected"
  | "change_approval_requested"
  | "change_decided"
  | "task_over_scope"
  | "change_exception"
  | "retainer_projects_created";

/** Mirrors the backend Notification model as returned by the API. */
export interface Notification {
  _id: string;
  /** User who receives the notification. */
  recipient: string;
  /** User who triggered the event — null for system notifications. */
  actor?: Pick<User, "_id" | "name"> | null;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  /** Optional frontend route to navigate to on click (`/tasks?task=<id>` for task types). */
  link?: string;
  /** Task id for task notifications, null otherwise. */
  task?: string | null;
  /** Project id for project / time notifications. */
  project?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/notifications response. */
export interface NotificationListResponse {
  notifications: Notification[];
  total: number;
  limit: number | null;
  offset: number;
}

/** GET /api/notifications/unread-count response. */
export interface UnreadCountResponse {
  count: number;
}

/** PATCH /api/notifications/:id/read response. */
export interface NotificationReadResponse {
  notification: Notification;
}

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

/** Fixed attendance statuses — mirrors the backend `ATTENDANCE_STATUSES` enum. */
export type AttendanceStatus =
  "present" | "absent" | "late" | "half_day" | "on_leave";

/** Mirrors the backend Attendance model as returned by the API (user + markedBy populated). */
export interface Attendance {
  _id: string;
  user: Pick<User, "_id" | "name" | "email">;
  /** Date string (YYYY-MM-DD). */
  date: string;
  status: AttendanceStatus;
  /** ISO datetime string or null. */
  checkIn?: string | null;
  /** ISO datetime string or null. */
  checkOut?: string | null;
  markedBy: Pick<User, "_id" | "name">;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/attendance body — mark attendance for one or more employees. */
export interface AttendanceInput {
  date: string;
  records: Array<{
    userId: string;
    status: AttendanceStatus;
    checkIn?: string;
    checkOut?: string;
    notes?: string;
  }>;
}

/** PATCH /api/attendance/:id body. */
export interface AttendanceUpdateInput {
  status?: AttendanceStatus;
  checkIn?: string | null;
  checkOut?: string | null;
  notes?: string;
}

/** Successful attendance responses. */
export interface AttendanceResponse {
  attendance: Attendance;
}

export interface AttendanceMarkResponse {
  attendance: Attendance[];
  count: number;
}

export interface AttendanceListResponse {
  attendance: Attendance[];
  /** For department view: list of department members. */
  members?: Array<Pick<User, "_id" | "name" | "email">>;
  total: number;
  limit: number | null;
  offset: number;
}

/** GET /api/attendance/stats response. */
export interface AttendanceStats {
  totalDays: number;
  summary: {
    present: number;
    absent: number;
    late: number;
    half_day: number;
    on_leave: number;
  };
  /** Attendance rate as a percentage (0–100). */
  rate: number;
  byEmployee: Array<{
    user: Pick<User, "_id" | "name" | "email">;
    present: number;
    absent: number;
    late: number;
    half_day: number;
    on_leave: number;
    rate: number;
  }>;
  dailyTrend: Array<{
    date: string;
    present: number;
    absent: number;
    late: number;
    total: number;
  }>;
}

export interface AttendanceStatsResponse {
  stats: AttendanceStats;
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export interface EmployeePerformanceReport {
  period: { from: string; to: string };
  employees: Array<{
    user: Pick<User, "_id" | "name" | "email"> & { department?: string | null };
    departmentName?: string;
    attendance: {
      present: number;
      absent: number;
      late: number;
      half_day: number;
      on_leave: number;
      rate: number;
    };
    leaves: {
      annual: number;
      sick: number;
      personal: number;
      unpaid: number;
      total: number;
      approved: number;
      approvalRate: number;
    };
  }>;
}

export interface LeaveStatisticsReport {
  period: { from: string; to: string };
  summary: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    cancelled: number;
  };
  byType: Array<{
    type: string;
    count: number;
    approved: number;
    rejected: number;
  }>;
  byDepartment: Array<{
    department: string;
    total: number;
    approved: number;
    rejected: number;
  }>;
  monthlyTrend: Array<{
    month: string;
    total: number;
    approved: number;
    rejected: number;
  }>;
}

export interface DepartmentActivitiesReport {
  period: { from: string; to: string };
  departments: Array<{
    _id: string;
    name: string;
    memberCount: number;
    avgAttendanceRate: number;
    leaveDaysUsed: number;
    recentActivities: number;
  }>;
}

/* ------------------------------------------------------------------ */
/* Performance Reviews                                                 */
/* ------------------------------------------------------------------ */

/** Fixed review statuses — mirrors the backend `REVIEW_STATUSES` enum. */
export type ReviewStatus =
  "draft" | "pending_acknowledgment" | "acknowledged" | "completed";

/** Status filter used by review lists. */
export type ReviewStatusFilter = ReviewStatus | "all";

/** Fixed goal statuses — mirrors the backend `GOAL_STATUSES` enum. */
export type GoalStatus = "not_started" | "in_progress" | "completed";

/** A single category rating within a review. */
export interface ReviewRating {
  category: string;
  score: number;
  comment?: string;
}

/** A single improvement goal within a review. */
export interface ReviewGoal {
  title: string;
  description?: string;
  status: GoalStatus;
  dueDate?: string;
  completedAt?: string;
}

/** Mirrors the backend PerformanceReview model as returned by the API. */
export interface PerformanceReview {
  _id: string;
  employee: Pick<User, "_id" | "name" | "email"> & {
    department?: Pick<Department, "_id" | "name"> | null;
  };
  reviewer: Pick<User, "_id" | "name" | "email">;
  period: string;
  status: ReviewStatus;
  ratings: ReviewRating[];
  overallScore?: number;
  strengths?: string;
  improvements?: string;
  summary?: string;
  goals: ReviewGoal[];
  employeeComments?: string;
  acknowledgedAt?: string;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/performance-reviews body. Reviews are written manually; `aiDraft` is opt-in. */
export interface CreateReviewInput {
  employeeId: string;
  period: string;
  ratings?: Array<{ category: string; score: number; comment?: string }>;
  goals?: Array<{
    title: string;
    description?: string;
    status?: GoalStatus;
    dueDate?: string;
  }>;
  summary?: string;
  strengths?: string;
  improvements?: string;
  /** Ask Gemini to draft the text. Only allowed when the server has AI drafting on. */
  aiDraft?: boolean;
}

/** POST /api/performance-reviews response — `warnings` when AI drafting couldn't start. */
export interface CreateReviewResponse {
  review: PerformanceReview;
  warnings?: string[];
}

/** GET /api/performance-reviews/config. */
export interface ReviewConfig {
  aiDraftsEnabled: boolean;
}

/** PATCH /api/performance-reviews/:id body. */
export interface UpdateReviewInput {
  ratings?: Array<{ category: string; score: number; comment?: string }>;
  goals?: Array<{
    title: string;
    description?: string;
    status?: GoalStatus;
    dueDate?: string;
    completedAt?: string;
  }>;
  status?: ReviewStatus;
  strengths?: string;
  improvements?: string;
  summary?: string;
}

/** POST /api/performance-reviews/:id/acknowledge body. */
export interface AcknowledgeReviewInput {
  comments?: string;
}

/** PATCH /api/performance-reviews/:id/goals/:goalIndex body. */
export interface UpdateGoalInput {
  status?: GoalStatus;
  description?: string;
}

/** Successful review responses are wrapped as `{ review }`. */
export interface ReviewResponse {
  review: PerformanceReview;
}

export interface ReviewListResponse {
  reviews: PerformanceReview[];
  total: number;
  limit: number | null;
  offset: number;
  /** Admin/head list only: whether AI drafting is switched on server-side. */
  aiDraftsEnabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

/** Fixed task statuses — mirrors the backend `TASK_STATUSES` enum. */
export type TaskStatus =
  "todo" | "in_progress" | "in_review" | "completed" | "rejected";

/** Status filter used by task lists. */
export type TaskStatusFilter = TaskStatus | "all";

/** Fixed task priorities — mirrors the backend `TASK_PRIORITIES` enum. */
export type TaskPriority = "low" | "medium" | "high" | "urgent";

/** Which slice of tasks GET /api/tasks returns (`all` = everything the role can see). */
export type TaskScope = "assigned" | "created" | "all" | "approvals";

/** Quick due-date filter. */
export type TaskDueFilter = "overdue" | "today" | "week";

/** Theme colour tokens a label can use (rendered via CSS variables, never hex). */
export type LabelColor =
  | "chart-1"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5"
  | "primary"
  | "secondary"
  | "accent"
  | "muted"
  | "destructive";

/** Minimal populated user reference. */
export interface UserRef {
  _id: string;
  name: string;
  email: string;
}

/** Populated assignee (department is an id, not populated). */
export interface AssigneeRef extends UserRef {
  role: Role;
  department: string | null;
}

export interface Subtask {
  _id: string;
  title: string;
  /** Plain text (may be missing on subtasks created before the full form). */
  description?: string;
  done: boolean;
  /** Written when the rework was ticked off. */
  completionNote?: string;
  /** Null when unassigned (or the assignee was deleted). */
  assignee: UserRef | null;
  startDate?: string | null;
  dueDate: string | null;
  completedAt: string | null;
  /** Actual start / end (ISO date-time); end is set when ticked off. */
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  actualStartSource?: ActualDateSource | null;
  actualEndSource?: ActualDateSource | null;
  /** User id (not populated). */
  createdBy: string;
  /** User id of the last editor. */
  updatedBy?: string | null;
}

export type RecurrenceUnit = "day" | "week" | "month";

export interface Recurrence {
  every: number;
  unit: RecurrenceUnit;
  /** -1 = forever. */
  cycles: number;
  generated: number;
  nextRunAt: string;
}

/** Label as embedded on a task. */
export interface TaskLabelRef {
  _id: string;
  name: string;
  color: LabelColor;
}

/** Where a task's Actual start / Actual end came from. */
export type ActualDateSource = "auto" | "manual" | "import";

/** Mirrors the backend Task model as returned by the API (populated refs). */
export type TaskIteration = "new" | "rework";

export interface TaskTitleParts {
  unit: string;
  quantity: number;
  shortName: string;
}

export interface Task {
  _id: string;
  title: string;
  description?: string;
  assignees: AssigneeRef[];
  /** Creator. */
  assignedBy: UserRef;
  department: Pick<Department, "_id" | "name"> | null;
  category: { _id: string; name: string } | null;
  labels: TaskLabelRef[];
  status: TaskStatus;
  priority: TaskPriority;
  /** Date-only fields come back as UTC midnight ISO strings — render as UTC. */
  startDate: string | null;
  dueDate: string | null;
  /** Order within a board column, ascending. */
  position: number;
  subtasks: Subtask[];
  recurrence: Recurrence | null;
  recurringParent: string | null;
  lastReminderSentOn: string | null;
  lastManualReminderAt: string | null;
  submissionNotes?: string;
  /** Set when closing: generated on Pearity (the production engine) or off it. */
  parity?: "on" | "off";
  /** Rules-era tasks: "new" work or "rework". */
  iteration?: TaskIteration | null;
  /** AI brief check: quality score 0–100 (English, clear, on-brand, links score higher). */
  briefCheck?: { verdict: "ok" | "weak" | "flagged"; score?: number | null; reason?: string; checkedAt?: string } | null;
  /** Rework tasks: the original task (populated). */
  reworkOf?: { _id: string; title: string; shortCode?: string | null; number?: number | null; status: TaskStatus } | null;
  /** Rules-era tasks: the parts the title is composed from. */
  titleParts?: TaskTitleParts | null;
  /** Final deliverable recorded at completion. */
  finalFile?: { fileId?: string | null; url?: string | null; addedAt?: string | null } | null;
  /** How well the outcome note answers the brief and scope (scored on submit / completion). Advice only. */
  outcomeReadiness?: (OutcomeReadiness & { at: string }) | null;
  submittedAt: string | null;
  reviewNotes?: string;
  reviewedAt: string | null;
  reviewedBy: Pick<User, "_id" | "name"> | null;
  completedAt: string | null;
  /** When work actually started / finished (ISO instants; filled automatically, editable). */
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  /** "manual" values are never changed by the automatic rules. */
  actualStartSource?: ActualDateSource | null;
  actualEndSource?: ActualDateSource | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  fileCount: number;
  /** Project the task belongs to (populated), null for standalone tasks. */
  project?: TaskProjectRef | null;
  milestone?: TaskMilestoneRef | null;
  /** e.g. "WEB-12" — only for project tasks. */
  /** <project tag>-<UNIT><QTY> — unique; the Pearity tag name. */
  tag?: string | null;
  shortCode?: string | null;
  /** Global sequence ("#<number>" when there's no short code). Null only before migrate:tables. */
  number?: number | null;
  /** Estimated effort in minutes (0..100000). */
  estimateMinutes?: number | null;
  /** Finished pending + approved time logs (running / rejected excluded). */
  loggedMinutes?: number;
  /** Completed with no time: the assignee is asked for the actual start and time taken (task detail only). */
  needsTimeEntry?: boolean;
  /** Pinned by the caller. */
  pinned?: boolean;
  /** Only on GET /api/tasks?recurring=true: generated copies. */
  copyCount?: number;
  /** Only on GET /api/tasks?assignee=: "read" when the caller can only view the task (view only). */
  access?: TaskAccess;
  /**
   * Meeting the task was created from. Lists carry the meeting id; the task
   * detail (GET /api/tasks/:id) populates `{ _id, title }` and the line's `start`.
   */
  sourceMeeting?: TaskSourceMeeting | null;
  /** Created beyond its project's approved scope: blocked until an admin decides. */
  overScope?: {
    status: "pending" | "approved" | "rejected";
    unit: string;
    allowed: number;
    used: number;
    requested: number;
    reason?: string;
  } | null;
  /** The task's Pearity tag (one per task), null until someone clicks Generate. */
  pearityTag?: PearityTagRef | null;
}

// --- Pearity integration ------------------------------------------------------

export interface PearityTagRef {
  /** Sequential tag number (1, 2, 3, …) — the identifier users see. */
  tagNo: number | null;
  tagId: string;
  tagName: string;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  /** Opens the tag in Pearity (tag link template, else the engine URL); null when off. */
  tagUrl: string | null;
}

export type PearityUsageSource = "utility" | "pearity";

/** DAM / outcome link written back from Pearity under this Utility task + tag. */
export interface PearityOutcomeLink {
  _id: string;
  url: string;
  title: string | null;
  mimeType: string | null;
  damAssetId: string | null;
  damFolderPath: string | null;
  tagNo: number | null;
  jobId: string | null;
  pearityUrl: string | null;
  createdAt: string;
}

/** GET /api/tasks/:id/pearity */
export interface TaskPearityInfo {
  enabled: boolean;
  tag: PearityTagRef | null;
  /** The name the tag gets on first Generate (or the existing name). */
  proposedTagName: string;
  tagUrl: string | null;
  generateUrl: string | null;
  usageCount: number;
  /** Same as usageCount — Pearity tag generation clicks recorded on the tag. */
  generationsCount?: number;
  /** History: times Generate on Pearity ran for this task. */
  tasksGeneratedOnPearity?: number;
  jobsStarted?: number;
  jobsCompleted?: number;
  jobsFailed?: number;
  savedToDam?: number;
  /** Outcome / DAM links written back from Pearity for this task. */
  outcomes?: PearityOutcomeLink[];
  generatedBy: Array<{
    user: { _id: string; name: string };
    count: number;
    lastAt: string;
    sources: PearityUsageSource[];
  }>;
}

/** POST /api/tasks/:id/pearity/generate */
export interface PearityGenerateResponse {
  created: boolean;
  tag: PearityTagRef;
  tagUrl: string | null;
  generateUrl: string | null;
}

export type PearityPlaceholder =
  | "tagNo"
  | "tagId"
  | "tagName"
  | "taskId"
  | "taskCode"
  | "taskNo"
  | "brand"
  | "category"
  | "project";

export interface PearitySettings {
  enabled: boolean;
  engineUrlTemplate: string;
  /** Optional: where a tag opens in Pearity (empty → the engine URL). */
  tagUrlTemplate: string;
  allowedIps: string[];
  updatedAt: string | null;
}

export interface PearitySettingsResponse {
  settings: PearitySettings;
  placeholders: PearityPlaceholder[];
  apiBasePath: string;
}

export type PearityApiScope = "pearity:read" | "pearity:tags" | "pearity:write";

export interface PearityApiKey {
  _id: string;
  name: string;
  /** First 12 characters, e.g. "pty_AbCd1234". */
  prefix: string;
  scopes: PearityApiScope[];
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: { _id: string; name: string } | null;
  revokedAt: string | null;
}

/** POST /api/integrations/pearity/keys — `key` is shown once. */
export interface PearityKeyCreateResponse {
  key: string;
  apiKey: PearityApiKey;
}

export interface TaskSourceMeeting {
  meeting: string | { _id: string; title: string };
  segmentIdx: number | null;
  /** Seconds from the meeting start (detail only). */
  start?: number | null;
}

/** What the current user may do with a task (computed server-side). */
export interface TaskPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canReview: boolean;
  canRemind: boolean;
  /** Add/edit/delete any subtask (task managers + head of the task's department). */
  canManageSubtasks: boolean;
  /** Add subtasks — managers and task assignees (assignees edit/delete only their own). */
  canAddSubtasks?: boolean;
  /** Toggle `done` (non-managers: only subtasks assigned to them or unassigned). */
  canToggleSubtasks: boolean;
  canSubmit: boolean;
  /** Valid targets for /status and /move. */
  allowedStatuses: TaskStatus[];
  /** May copy the task (project tasks: create rights in the project; standalone: heads/admins). */
  canDuplicate?: boolean;
  /** May start a timer / log time on this task. */
  canLogTime?: boolean;
  /** Edit Actual start / end (managers, the department head and assignees). */
  canEditActualDates?: boolean;
  /** Project has requireTaskApproval: false — submitting completes directly. */
  skipsReview?: boolean;
  /** Task of an archived project — everything is read-only. */
  readOnly?: boolean;
}

/**
 * How the caller opened a task: "full" (view access) or "read" — any other
 * signed-in user, view only (every permission off; task notes stay hidden).
 */
export type TaskAccess = "full" | "read";

/** GET /api/tasks/:id and every task mutation. */
export interface TaskDetailResponse {
  task: Task;
  permissions: TaskPermissions;
  access?: TaskAccess;
  /** Non-blocking warnings on create/update (e.g. due date after milestone end). */
  warnings?: string[];
  /** Subtask mutations: the subtask that was added/updated. */
  subtaskId?: string;
}

/** Subtask as sent on create. Dates are "YYYY-MM-DD". */
export interface SubtaskInput {
  title: string;
  description?: string;
  assignee?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  /** Subtask endpoint only: ISO date-time (null = empty). */
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  /** Hold notifications until POST .../notify (after the form uploads files). */
  deferNotifications?: boolean;
}

export interface RecurrenceInput {
  every: number;
  unit: RecurrenceUnit;
  cycles: number;
}

/** POST /api/tasks body. Dates are "YYYY-MM-DD". */
export interface TaskInput {
  /** Controlled name; the server composes the title from it. */
  titleParts?: TaskTitleParts;
  iteration?: TaskIteration;
  /** Rework: the original task's id (same project). */
  reworkOf?: string;
  /** The form will upload attachments right after creation (they count as the brief). */
  hasAttachments?: boolean;
  title: string;
  /** 0..100000 minutes; null clears. */
  estimateMinutes?: number | null;
  description?: string;
  assignees: string[];
  priority?: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  labels?: string[];
  category?: string | null;
  subtasks?: SubtaskInput[];
  recurrence?: RecurrenceInput | null;
  /** Project id (null on update detaches the task). */
  project?: string | null;
  /** Milestone id within the project (null clears). */
  milestone?: string | null;
  /** Update only: ISO date-time; null clears it (back to automatic). */
  actualStartAt?: string | null;
  actualEndAt?: string | null;
}

/** PATCH /api/tasks/:id body — any subset of TaskInput except subtasks. */
export type TaskUpdateInput = Partial<Omit<TaskInput, "subtasks">>;

/** PATCH /api/tasks/:id/subtasks/:subId body. */
export interface SubtaskUpdateInput {
  title?: string;
  description?: string;
  assignee?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  done?: boolean;
  /** What was done (one way to meet the note / file / time rule for ticking rework off). */
  completionNote?: string;
  /** ISO date-time; null clears it (back to automatic). */
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  /** "Start now": sets an empty actual start to the current time. */
  startNow?: boolean;
  deferNotifications?: boolean;
}

/** GET /api/tasks/subtasks/mine row. */
export interface MySubtask {
  _id: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  task: {
    _id: string;
    title: string;
    shortCode: string | null;
    status: TaskStatus;
    project: { _id: string; name: string; code: string } | null;
  };
}

export interface MySubtasksResponse {
  subtasks: MySubtask[];
  total: number;
}

export type TaskNoteVisibility = "task" | "private";

/** Task note (GET /api/tasks/:id/notes) with the caller's rights. */
export interface TaskNote {
  _id: string;
  task: string;
  author: UserRef;
  title: string;
  /** Raw body including `@[Name](userId)` mention tokens. */
  body: string;
  visibility: TaskNoteVisibility;
  mentions: UserRef[];
  pinned: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canPin: boolean;
  canDelete: boolean;
}

export interface TaskNoteListResponse {
  notes: TaskNote[];
  total: number;
}

export interface TaskNoteInput {
  title?: string;
  body?: string;
  visibility?: TaskNoteVisibility;
  pinned?: boolean;
}

/** POST /api/tasks/:id/submit body. */
export interface TaskSubmitInput {
  /** A file uploaded to this task as the final deliverable. */
  finalFileId?: string;
  /** Or a link to it. */
  finalUrl?: string;
  submissionNotes?: string;
  /** Mandatory when closing. */
  parity?: "on" | "off";
}

/** POST /api/tasks/:id/review body. */
export interface TaskReviewInput {
  decision: "approved" | "rejected";
  reviewNotes?: string;
}

export interface TaskListResponse {
  tasks: Task[];
  total: number;
  limit: number | null;
  offset: number;
}

/** GET /api/tasks/calendar row (lean). */
export interface TaskCalendarItem {
  _id: string;
  title: string;
  shortCode: string | null;
  number: number | null;
  status: TaskStatus;
  priority: TaskPriority;
  startDate: string | null;
  dueDate: string;
  completedAt: string | null;
  project: { _id: string; name: string; code: string } | null;
  assignees: Array<{ _id: string; name: string }>;
}

export interface TaskCalendarResponse {
  tasks: TaskCalendarItem[];
  total: number;
  limit: number;
  truncated: boolean;
}

/** POST /api/tasks/bulk and /api/projects/bulk response. */
export interface BulkResult {
  updated: number;
  updatedIds: string[];
  skipped: Array<{ id: string; reason: string }>;
}

export type TaskBulkAction = "status" | "assign" | "delete";
export type ProjectBulkAction = "status" | "archive" | "restore" | "delete";

/** GET /api/tasks/approvals/count. */
export interface TaskApprovalsCount {
  count: number;
  isReviewer: boolean;
}

/** GET /api/tasks?view=board response. */
export interface TaskBoardResponse {
  columns: Record<TaskStatus, Task[]>;
  /** Full count per column (may exceed the 200 returned). */
  totals: Record<TaskStatus, number>;
  limit: number;
}

/** User option from GET /api/tasks/assignable-users. */
export interface AssignableUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  department: Pick<Department, "_id" | "name"> | null;
}

export interface AssignableUsersResponse {
  users: AssignableUser[];
  total: number;
  limit: number | null;
  offset: number;
}

/** User option from GET /api/tasks/:id/mentionable-users. */
export interface MentionableUser extends UserRef {
  role: Role;
}

export interface MentionableUsersResponse {
  users: MentionableUser[];
  total: number;
  limit: null;
  offset: number;
}

export interface TaskComment {
  _id: string;
  task: string;
  author: UserRef;
  /** Raw body including `@[Name](userId)` mention tokens. */
  body: string;
  mentions: UserRef[];
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCommentListResponse {
  comments: TaskComment[];
  total: number;
  limit: number | null;
  offset: number;
}

export interface TaskFile {
  _id: string;
  task: string;
  /** Subtask id for subtask attachments; null/absent for task files. */
  subtask?: string | null;
  uploadedBy: UserRef;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFileListResponse {
  files: TaskFile[];
  total: number;
  limit: number | null;
  offset: number;
}

export type TaskHistoryAction =
  | "created"
  | "updated"
  | "status_changed"
  | "assignees_changed"
  | "subtask_added"
  | "subtask_updated"
  | "subtask_completed"
  | "subtask_reopened"
  | "subtask_removed"
  | "comment_added"
  | "file_added"
  | "file_removed"
  | "note_added"
  | "note_updated"
  | "note_removed"
  | "submitted"
  | "reviewed"
  | "reminder_sent"
  | "created_from_meeting"
  | "actual_dates_updated"
  | "subtask_actual_dates_updated"
  | "pearity_generated"
  | "pearity_job_started"
  | "pearity_job_completed"
  | "pearity_job_failed"
  | "pearity_saved_to_dam"
  | "pearity_review_submitted"
  | "pearity_review_approved"
  | "pearity_review_changes_requested"
  | "pearity_review_rejected"
  | "rework_added";

export interface TaskHistoryEntry {
  _id: string;
  task: string;
  /** null = system (scheduled reminders, recurring copies). */
  actor: UserRef | null;
  action: TaskHistoryAction;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface TaskHistoryResponse {
  history: TaskHistoryEntry[];
  total: number;
  limit: number | null;
  offset: number;
}

export interface TaskLabel {
  _id: string;
  name: string;
  color: LabelColor;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLabelInput {
  name?: string;
  color?: LabelColor;
  description?: string;
}

export interface TaskCategory {
  _id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSettings {
  _id: string;
  /** 0 = off. */
  reminderBeforeDays: number;
  reminderOnDeadline: boolean;
  /** 0 = off. */
  reminderAfterDays: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskSettingsInput = Partial<
  Pick<
    TaskSettings,
    "reminderBeforeDays" | "reminderOnDeadline" | "reminderAfterDays"
  >
>;

/** Payload of the `task-updated` SSE event. */
export interface TaskUpdatedEvent {
  taskId: string;
  title: string;
  status: TaskStatus;
  action:
    | "created"
    | "updated"
    | "status-changed"
    | "moved"
    | "submitted"
    | "reviewed"
    | "reminded"
    | "deleted"
    | "subtask-added"
    | "subtask-updated"
    | "subtask-removed"
    | "comment-added"
    | "comment-updated"
    | "comment-deleted"
    | "file-added"
    | "file-removed"
    | "note-added"
    | "note-updated"
    | "note-deleted";
  previousStatus?: TaskStatus;
  position?: number;
  actorId?: string;
  fields?: string[];
  decision?: "approved" | "rejected";
  reviewedBy?: string;
  submittedBy?: string;
  subtaskId?: string;
  commentId?: string;
  fileId?: string;
  fileIds?: string[];
  noteId?: string;
  projectId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

/** Per-user email switches (in-app notifications are always on). */
export interface EmailPreferences {
  taskAssigned: boolean;
  taskUpdates: boolean;
  taskComments: boolean;
  taskReminders: boolean;
  projectUpdates: boolean;
  timeLogs: boolean;
  /** Admins: someone accepted an invitation. */
  teamUpdates: boolean;
  /** Document expiries, probation / notice / internship end dates. */
  hrReminders: boolean;
  /** Admins / heads: a team member applied for leave. */
  leaveRequests: boolean;
}

export interface SmtpStatus {
  ok: boolean;
  configured: boolean;
  host: string | null;
  from: string | null;
  redirectTo: string | null;
  error?: string;
  hint?: string;
}

export interface SendTestEmailResponse {
  success: true;
  to: string;
  deliveredTo: string;
  status: SmtpStatus;
  /** SMTP server acceptance line (e.g. "250 OK id=…"), when available. */
  smtpResponse?: string | null;
  messageId?: string | null;
}

/* ------------------------------------------------------------------ */
/* AI Insights                                                          */
/* ------------------------------------------------------------------ */

/** Mirrors the backend AiInsight model as returned by the API. */
export interface AiInsight {
  _id: string;
  createdBy: Pick<User, "_id" | "name">;
  scope: "organization" | "department";
  department?: Pick<Department, "_id" | "name"> | null;
  status: "pending" | "generating" | "completed" | "failed";
  title?: string;
  content?: string;
  summary?: string;
  period: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/ai-insights/generate body. */
export interface GenerateInsightInput {
  period: string;
}

/** Successful insight responses are wrapped as `{ insight }`. */
export interface AiInsightResponse {
  insight: AiInsight;
}

export interface AiInsightListResponse {
  insights: AiInsight[];
  total: number;
  limit: number | null;
  offset: number;
}

/* ------------------------------------------------------------------ */
/* SSE — Real-time events                                              */
/* ------------------------------------------------------------------ */

/** All event types that can be pushed via SSE. */
export type SSEEventType =
  | "notification"
  | "task-updated"
  | "leave-updated"
  | "attendance-updated"
  | "announcement-new"
  | "review-updated"
  | "insight-ready"
  | "review-ready"
  | "project-updated"
  | "timer-updated"
  | "timelog-updated"
  | "timesheet-updated";

/** The shape of every SSE event pushed to clients. */
export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/* Dashboard Analytics                                                 */
/* ------------------------------------------------------------------ */

/** Employee dashboard — personal stats for the logged-in user. */
export interface EmployeeDashboardAnalytics {
  scope: "employee";
  attendance: {
    overview: {
      present: number;
      absent: number;
      late: number;
      half_day: number;
      on_leave: number;
    };
    rate: number;
    workingDays: number;
  };
  leaveBalance: Record<
    string,
    { used: number; remaining: number; total: number }
  >;
  tasks: {
    active: Array<{
      _id: string;
      title: string;
      status: string;
      priority: string;
      dueDate?: string | null;
    }>;
    completedCount: number;
  };
  recentActivity: Array<{
    action: string;
    targetName: string;
    createdAt: string;
  }>;
}

export interface DashboardAnalytics {
  scope: "admin";
  summary: {
    totalEmployees: number;
    totalDepartments: number;
    activeTasks: number;
    pendingLeaves: number;
    attendanceRate: number;
    completedTasks: number;
  };
  attendanceOverview: {
    present: number;
    absent: number;
    late: number;
    half_day: number;
    on_leave: number;
  };
  leaveStats: {
    pending: number;
    approved: number;
    rejected: number;
    byType: Array<{ type: string; count: number }>;
  };
  taskStats: {
    todo: number;
    in_progress: number;
    in_review: number;
    completed: number;
    rejected: number;
  };
  departmentStats: Array<{
    name: string;
    memberCount: number;
    attendanceRate: number;
  }>;
  recentActivity: Array<{
    action: string;
    actorName: string;
    targetName: string;
    createdAt: string;
    details?: Record<string, unknown>;
  }>;
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/** Theme-token colour used by project statuses (same palette as task labels). */
export type ColorToken = LabelColor;

/** `Task.project` as populated by the task endpoints. */
export interface TaskProjectRef {
  _id: string;
  name: string;
  code: string;
  archivedAt: string | null;
  requireTaskApproval: boolean;
  /** false = only the timer (and time spent when completing) for non-managers. */
  manualTimeLogs?: boolean;
}

/** `Task.milestone` as populated by the task endpoints. */
export interface TaskMilestoneRef {
  _id: string;
  title: string;
  endDate: string | null;
  status: MilestoneStatus;
}

export interface ProjectStatus {
  _id: string;
  name: string;
  color: ColorToken;
  isDefault: boolean;
  isCompleted: boolean;
  order: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** Only on GET /api/project-meta/statuses. */
  projectCount?: number;
}

export type ProjectStatusRef = Pick<
  ProjectStatus,
  "_id" | "name" | "color" | "isDefault" | "isCompleted" | "order"
>;

export interface ProjectStatusInput {
  name?: string;
  color?: ColorToken;
  isCompleted?: boolean;
  active?: boolean;
}

export interface ProjectCategory {
  _id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCounts {
  todo: number;
  in_progress: number;
  in_review: number;
  completed: number;
  rejected: number;
  total: number;
  open: number;
}

export interface ProjectMember {
  user: {
    _id: string;
    name: string;
    email: string;
    role: Role;
    department: string | null;
  };
  /** Only when permissions.canViewRates, or the row is the caller's own. */
  hourlyRate?: number;
  addedAt: string;
}

export type ProgressMode =
  "manual" | "task_completion" | "total_time" | "deadline";

/** Structured project name parts: `Brand_Type_MonYYYY_Name`. */
export interface ProjectNaming {
  /** Brand id. */
  brand: string;
  type: string;
  /** "YYYY-MM". */
  month: string;
  /** The free "Name" part (≤ 80 characters, no "_"). */
  title: string;
}

/** GET /projects/:id/naming-suggestion — pre-fill for the edit form. */
export interface ProjectNamingSuggestion {
  brand: string | null;
  type: string | null;
  month: string;
  title: string;
  /** true = the project still has a legacy free-text name. */
  legacy: boolean;
  monthSource: "naming" | "name" | "startDate";
  typeDetected: boolean;
}

/** A project name Type (Settings → Projects). */
export interface ProjectTypeOption {
  name: string;
  projectCount: number;
}

export interface Project {
  _id: string;
  /** Composed `Brand_Type_MonYYYY_Name` when `naming` is set; legacy free text otherwise. */
  name: string;
  /** null / absent = legacy name. */
  naming?: ProjectNaming | null;
  code: string;
  /** BRAND-MONTH-TYPE-NAME abbreviation (unique). */
  tag?: string | null;
  /** New-project approval; absent = approved (created before approval existed). */
  approval?: ProjectApprovalView | null;
  /** First "Generate on Pearity" for the project (its tag is frozen from then on). */
  pearityGeneratedAt?: string | null;
  summary?: string;
  /** Manpower plan row key chosen on the project; null = automatic match. */
  manpowerRow?: string | null;
  /** Pitch projects: potential revenue (AED; hidden without rate access) and the tracker's status. */
  pitch?: { revenue: number | null; revenueTbc: boolean; status: string; revenueHidden?: boolean } | null;
  /** Structured scope: deliverables per unit. */
  scopeItems?: ScopeItem[];
  /** The brand's platforms and scope notes, copied onto the project. */
  platforms?: string[];
  scopeNotes?: string[];
  /** The brand's "Other scope" text (not itemised as rows), copied onto the project. */
  scopeText?: string;
  /** New projects (brand rules onwards): no tasks until the project has a scope. Absent on older projects. */
  requiresScope?: boolean;
  category: { _id: string; name: string } | null;
  /** Client brand (populated); null when unset. */
  brand?: ProjectBrandRef | null;
  departments: { _id: string; name: string }[];
  manager: UserRef | null;
  members: ProjectMember[];
  /** Team by role (manpower plan roles + "others"). Absent on older responses. */
  team?: Array<{ role: string; users: Array<{ _id: string; name: string; email?: string }> }>;
  status: ProjectStatusRef;
  startDate: string;
  deadline: string | null;
  progressMode: ProgressMode;
  progress: number;
  hoursAllocated: number | null;
  /** Only when permissions.canViewRates. */
  budget?: number | null;
  isPublic: boolean;
  manualTimeLogs: boolean;
  requireTaskApproval: boolean;
  taskCounter: number;
  createdBy: UserRef;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  isOverdue: boolean;
  taskCounts: TaskCounts;
  loggedMinutes: number;
  /** Last day of the project's month (naming month, else deadline month); null = never closes. */
  closesOn: string | null;
  /** The month has ended: no new tasks (open ones can still be closed). */
  expired: boolean;
}

export interface ProjectPermissions {
  canEdit: boolean;
  canChangeStatus: boolean;
  canManageMembers: boolean;
  canManageMilestones: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canCreateTasks: boolean;
  canUploadFiles: boolean;
  canAddNotes: boolean;
  canViewRates: boolean;
  canLogTime: boolean;
  canApproveTime: boolean;
  isManager: boolean;
  isMember: boolean;
  /** Detail page only: the current user approves this pending project. */
  canApprove?: boolean;
}

export type MilestoneStatus = "incomplete" | "complete";

export interface MilestoneSummary {
  _id: string;
  title: string;
  status: MilestoneStatus;
  startDate: string | null;
  endDate: string | null;
  taskCount: number;
  completedTaskCount: number;
  progress: number;
}

export interface ProjectStats {
  taskCounts: TaskCounts;
  overdueTasks: number;
  loggedMinutes: number;
  approvedMinutes: number;
  pendingMinutes: number;
  allocatedMinutes: number | null;
  earnings: number | null;
  memberCount: number;
  milestones: { total: number; completed: number; items: MilestoneSummary[] };
}

export interface ProjectDetailResponse {
  project: Project;
  permissions: ProjectPermissions;
  stats: ProjectStats;
  /** Set when scope / team changes were sent to leadership instead of saved. */
  pendingApproval?: string;
}

export interface ProjectListResponse {
  projects: Project[];
  total: number;
  limit: number | null;
  offset: number;
}

export interface ProjectInput {
  /** Legacy free-text name (legacy projects only; new projects use `naming`). */
  name?: string;
  /** Structured name parts (required on create); the server composes `name`. */
  naming?: ProjectNaming;
  /** Ignored by the server: codes are generated (fixed, unique). */
  code?: string;
  summary?: string;
  /** Manpower plan row key; null = automatic match. */
  manpowerRow?: string | null;
  /** Structured scope rows. */
  scopeItems?: ScopeItem[];
  category?: string | null;
  /** Brand id; null / "" clears it. */
  brand?: string | null;
  departments?: string[];
  manager?: string | null;
  members?: (string | { user: string; hourlyRate?: number })[];
  status?: string;
  startDate?: string;
  deadline?: string | null;
  progressMode?: ProgressMode;
  progress?: number;
  hoursAllocated?: number | null;
  budget?: number | null;
  isPublic?: boolean;
  manualTimeLogs?: boolean;
  requireTaskApproval?: boolean;
  /** Role-based team (manpower plan roles + "others"); its people become members. */
  team?: Array<{ role: string; users: string[] }>;
  /** true when `code` is the suggested one: if taken, the server adds a number. */
  autoCode?: boolean;
  /** Pitch projects (create): the three dates, lead(s) and potential revenue. */
  pitchDates?: { clientPresentation: string; milestone1: string; milestone2: string };
  pitchLeads?: string[];
  pitchRevenue?: number | null;
  pitchRevenueTbc?: boolean;
}

export type ProjectUpdateInput = Partial<
  Omit<ProjectInput, "status" | "members">
>;

export interface ProjectDuplicateInput {
  name?: string;
  /** Ignored by the server: the copy gets a generated code. */
  code?: string;
  includeTasks?: boolean;
  startDate?: string;
  deadline?: string | null;
}

export interface ProjectAssignableUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  department: string | null;
}

export interface Milestone {
  _id: string;
  project: string;
  title: string;
  summary?: string;
  startDate: string | null;
  endDate: string | null;
  status: MilestoneStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  completedTaskCount: number;
  progress: number;
}

export interface MilestoneInput {
  title?: string;
  summary?: string;
  startDate?: string | null;
  endDate?: string | null;
}

export type NoteVisibility = "members" | "private";

export interface ProjectNote {
  _id: string;
  project: string;
  author: UserRef;
  title: string;
  body: string;
  visibility: NoteVisibility;
  sharedWith: UserRef[];
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

export interface ProjectNoteInput {
  title?: string;
  body?: string;
  visibility?: NoteVisibility;
  sharedWith?: string[];
}

export interface ProjectFile {
  _id: string;
  project: string;
  uploadedBy: UserRef;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  canDelete?: boolean;
}

export type ProjectActivityAction =
  | "created"
  | "updated"
  | "status_changed"
  | "member_added"
  | "member_removed"
  | "member_rate_changed"
  | "manager_changed"
  | "milestone_created"
  | "milestone_updated"
  | "milestone_completed"
  | "milestone_reopened"
  | "milestone_deleted"
  | "file_added"
  | "file_removed"
  | "note_added"
  | "note_updated"
  | "note_deleted"
  | "archived"
  | "restored"
  | "duplicated"
  | "brand_moved";

export interface ProjectActivity {
  _id: string;
  project: string;
  actor: UserRef | null;
  action: ProjectActivityAction;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface ProjectSettings {
  _id: string;
  logTimeFor: "project" | "task";
  approvalRequired: boolean;
  /** New projects need approval before tasks can be added. */
  projectApprovalRequired: boolean;
  /** Approver user ids (empty = aasim@lps-me.com). */
  projectApprovers: string[];
  autoStopTimerAt: string | null;
  trackerReminderAt: string | null;
  deadlineReminderDays: number;
  deadlineReminderTo: ("manager" | "members" | "admins")[];
  dailyTimeLogReport: boolean;
  /** Project name Types (`Brand_Type_MonYYYY_Name`). */
  projectTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectSettingsInput = Partial<
  Omit<ProjectSettings, "_id" | "createdAt" | "updatedAt">
>;

/** Payload of the `project-updated` SSE event. */
export interface ProjectUpdatedEvent {
  projectId: string;
  action: string;
  name?: string;
  actorId?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Time logs                                                           */
/* ------------------------------------------------------------------ */

export type TimeLogStatus = "pending" | "approved" | "rejected";
export type TimeLogSource = "timer" | "manual" | "timesheet";
export type TimeLogScope = "mine" | "team" | "all" | "approvals";

export interface TimeLog {
  _id: string;
  user: { _id: string; name: string; email: string; department: string | null };
  project: { _id: string; name: string; code: string } | null;
  task: { _id: string; title: string; shortCode: string | null } | null;
  startTime: string;
  /** null = timer still running. */
  endTime: string | null;
  breaks: {
    _id: string;
    startTime: string;
    endTime: string | null;
    reason?: string;
  }[];
  durationMinutes: number;
  breakMinutes: number;
  memo: string;
  source: TimeLogSource;
  hourlyRate: number;
  earnings: number;
  status: TimeLogStatus;
  reviewedBy: { _id: string; name: string } | null;
  reviewedAt: string | null;
  rejectReason?: string;
  weeklyTimesheet: string | null;
  addedBy: { _id: string; name: string };
  editedBy: { _id: string; name: string } | null;
  autoStopped: boolean;
  createdAt: string;
  updatedAt: string;
  isRunning: boolean;
  isPaused: boolean;
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    canApprove: boolean;
    canStop: boolean;
  };
}

export interface TimeLogListResponse {
  logs: TimeLog[];
  total: number;
  limit: number | null;
  offset: number;
  totals: { minutes: number; earnings: number; count: number };
}

export interface TimerStartInput {
  project?: string;
  task?: string;
  memo?: string;
}

export interface ManualTimeLogInput {
  project?: string;
  task?: string;
  startTime: string;
  endTime: string;
  memo?: string;
  user?: string;
  /** Time added when completing (or after completing) the task. */
  completion?: boolean;
}

export interface TimeLogUpdateInput {
  memo?: string;
  startTime?: string;
  endTime?: string;
  project?: string | null;
  task?: string | null;
}

/** Payload of the `timer-updated` SSE event. */
export interface TimerUpdatedEvent {
  action: "started" | "paused" | "resumed" | "stopped" | "deleted";
  timer: TimeLog | null;
}

/* ------------------------------------------------------------------ */
/* Weekly timesheets                                                   */
/* ------------------------------------------------------------------ */

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";

export interface TimesheetEntry {
  task: string;
  /** "YYYY-MM-DD" on input; UTC-midnight ISO on output. */
  date: string;
  minutes: number;
}

export interface Timesheet {
  _id: string;
  user: { _id: string; name: string; email: string; department: string | null };
  weekStart: string;
  weekStartKey: string;
  status: TimesheetStatus;
  entries: TimesheetEntry[];
  submittedAt: string | null;
  reviewedBy: { _id: string; name: string } | null;
  reviewedAt: string | null;
  rejectReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimesheetTask {
  _id: string;
  title: string;
  shortCode: string | null;
  status: string;
  project: { _id: string; name: string; code: string } | null;
}

export interface TimesheetView {
  timesheet: Timesheet;
  tasks: TimesheetTask[];
  /** 7 × "YYYY-MM-DD", Mon..Sun. */
  days: string[];
  totals: {
    byDay: Record<string, number>;
    byTask: Record<string, number>;
    total: number;
  };
  permissions: { canEdit: boolean; canSubmit: boolean; canReview: boolean };
}

export interface PendingTimesheet extends Timesheet {
  totalMinutes: number;
}

/* ------------------------------------------------------------------ */
/* Work reports                                                        */
/* ------------------------------------------------------------------ */

export type TimeReportGroupBy =
  "user" | "project" | "task" | "day" | "breakdown";

export interface TimeBreakdownRow {
  key: string | null;
  label: string;
  sublabel: string | null;
  minutes: number;
  hours: number;
  earnings: number;
  count: number;
}
/** A task with the hours one employee logged on it, plus the task's own details. */
export interface TimeBreakdownTask extends TimeBreakdownRow {
  status: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  estimateMinutes: number | null;
  client: string | null;
}
export interface TimeBreakdownProject extends TimeBreakdownRow {
  client: string | null;
  tasks: TimeBreakdownTask[];
}
export interface TimeBreakdownEmployee extends TimeBreakdownRow {
  projects: TimeBreakdownProject[];
}
export interface TimeBreakdownResponse {
  from: string | null;
  to: string | null;
  employees: TimeBreakdownEmployee[];
  totals: {
    minutes: number;
    hours: number;
    earnings: number;
    count: number;
    employees: number;
  };
}

export interface TimeReportRow {
  key: string | null;
  label: string;
  sublabel: string | null;
  minutes: number;
  hours: number;
  earnings: number;
  count: number;
}

export interface TimeReportSummary {
  from: string | null;
  to: string | null;
  groupBy: TimeReportGroupBy;
  rows: TimeReportRow[];
  totals: { minutes: number; hours: number; earnings: number; count: number };
}

export interface TaskReportSummary {
  from: string | null;
  to: string | null;
  totals: {
    total: number;
    completed: number;
    open: number;
    overdue: number;
    completionRate: number;
    onTime: number;
    late: number;
  };
  byStatus: { status: TaskStatus; count: number }[];
  byPriority: { priority: TaskPriority; count: number }[];
  byEmployee: {
    userId: string;
    name: string;
    email: string;
    total: number;
    completed: number;
    overdue: number;
    onTime: number;
    late: number;
  }[];
  byProject: {
    projectId: string | null;
    name: string;
    code: string | null;
    total: number;
    completed: number;
    overdue: number;
  }[];
  overdue: {
    _id: string;
    title: string;
    shortCode: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    dueDate: string;
    daysOverdue: number;
    assignees: { _id: string; name: string }[];
    project: { _id: string; name: string; code: string } | null;
  }[];
}

export interface TimesheetReportRow extends Omit<
  Timesheet,
  "entries" | "user"
> {
  user: {
    _id: string;
    name: string;
    email: string;
    department: { _id: string; name: string } | null;
  };
  totalMinutes: number;
  entryCount: number;
  canReview: boolean;
}

export interface TimesheetReportResponse {
  timesheets: TimesheetReportRow[];
  total: number;
  limit: number | null;
  offset: number;
}

/** Shared `{ <items>, total, limit, offset }` list envelope. */
export type Paginated<K extends string, T> = { [P in K]: T[] } & {
  total: number;
  limit: number | null;
  offset: number;
};

/* ------------------------------------------------------------------ */
/* Invitations                                                         */
/* ------------------------------------------------------------------ */

/** Stored status plus the derived "expired" (pending past its expiry). */
export type InvitationState = "pending" | "accepted" | "expired" | "revoked";

/** Mirrors the backend Invitation model (populated) as returned by the admin API. */
export interface Invitation {
  _id: string;
  email: string;
  role: Role;
  department: Pick<Department, "_id" | "name"> | null;
  projects: Array<{
    _id: string;
    name: string;
    code: string;
    archivedAt?: string | null;
  }>;
  message?: string;
  status: "pending" | "accepted" | "revoked";
  state: InvitationState;
  expiresAt: string;
  invitedBy: Pick<User, "_id" | "name" | "email"> | null;
  lastSentAt: string;
  sendCount: number;
  acceptedAt?: string | null;
  acceptedUser?: Pick<User, "_id" | "name" | "email"> | null;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvitationListResponse {
  invitations: Invitation[];
  total: number;
  limit: number | null;
  offset: number;
  counts: Record<InvitationState, number>;
}

export interface CreateInvitationsInput {
  emails: string[];
  role: Role;
  department?: string | null;
  projects?: string[];
  message?: string;
}

export type InviteResultStatus =
  "invited" | "resent" | "already_user" | "invalid";

export interface InviteResult {
  email: string;
  status: InviteResultStatus;
  invitation?: Invitation | null;
  /** Returned once per send so the admin can share the link if email fails. */
  acceptUrl?: string;
}

export interface InvitationSendResponse {
  invitation: Invitation;
  acceptUrl: string;
}

/** Public preview of an invite (GET /invitations/accept/:token). */
export interface InvitationPreview {
  email: string;
  role: Role;
  department: { name: string } | null;
  invitedBy: { name: string };
  expiresAt: string;
}

export interface AcceptInvitationResponse {
  user: User;
  /** e.g. "You joined as an employee because …" */
  notices: string[];
}

/* ------------------------------------------------------------------ */
/* My dashboard (GET /api/dashboard/me*)                               */
/* ------------------------------------------------------------------ */

/** Colleague reference on the personal dashboard (designation is "" when unset). */
export interface PersonRef {
  _id: string;
  name: string;
  designation: string;
}

/** Whose restricted HR data the viewer receives. */
export type HrScope = "self" | "department" | "all";

export interface WeekTimelogDay {
  /** "YYYY-MM-DD". */
  date: string;
  minutes: number;
  breakMinutes: number;
}

export interface WeekTimelogs {
  /** Only on GET /dashboard/me/timelogs. */
  today?: string;
  weekStart: string;
  weekEnd: string;
  days: WeekTimelogDay[];
  totalMinutes: number;
  totalBreakMinutes: number;
}

export interface MyDashboardTask {
  _id: string;
  code: string;
  title: string;
  labels: TaskLabelRef[];
  status: Exclude<TaskStatus, "completed">;
  dueDate: string | null;
  priority: TaskPriority;
  project: { _id: string; name: string; code: string } | null;
  overdue: boolean;
}

export interface MyDashboardHrDate {
  user: PersonRef;
  date: string;
  inDays: number;
}

/** My dashboard period: the last N days ending today (app timezone), or all time. */
export type MyDashboardPeriod = "7d" | "30d" | "90d" | "120d" | "365d" | "all";

export interface MyDashboard {
  /** "YYYY-MM-DD" in the server's APP_TIMEZONE. */
  today: string;
  /** The period the counts were computed for (`from` is null for "all"). */
  period: { key: MyDashboardPeriod; from: string | null; to: string };
  hrScope: HrScope;
  profile: {
    _id: string;
    name: string;
    email: string;
    role: Role;
    designation: string;
    employeeId: string | null;
    department: { _id: string; name: string } | null;
    avatarInitials: string;
    joiningDate: string | null;
  };
  counts: {
    openTasks: number;
    pendingTasks: number;
    overdueTasks: number;
    projects: number;
    projectsInProgress: number;
    projectsOverdue: number;
  };
  /** Completed by me in the period; `previous` = the previous equal period (null for "all"). */
  completedTasks: {
    count: number;
    onTimePct: number | null;
    previous: number | null;
  };
  /** My projects moved to a completed status in the period. */
  completedProjects: { count: number; previous: number | null };
  /** Minutes of finished time logs started in the period. */
  loggedMinutes: number;
  myTasks: MyDashboardTask[];
  onLeaveToday: { user: PersonRef; until: string }[];
  birthdays: { user: PersonRef; day: number; month: number; inDays: number }[];
  joiningsAndAnniversaries: {
    user: PersonRef;
    kind: "joining" | "anniversary";
    years: number;
    date: string;
  }[];
  probation: MyDashboardHrDate[];
  notice: (MyDashboardHrDate & { startDate: string | null })[];
  internship: MyDashboardHrDate[];
  documentExpiries: {
    _id: string;
    name: string;
    type: DocumentType;
    user: { _id: string; name: string };
    expiryDate: string;
    inDays: number;
  }[];
  totals: {
    onLeaveToday: number;
    birthdays: number;
    joiningsAndAnniversaries: number;
    probation: number;
    notice: number;
    internship: number;
    documentExpiries: number;
  };
  weekTimelogs: WeekTimelogs;
}

export type MyCalendarItemKind =
  "task" | "subtask" | "leave" | "project_deadline";

export interface MyCalendarItem {
  /** "<kind>:<id>", unique. */
  id: string;
  kind: MyCalendarItemKind;
  title: string;
  /** "YYYY-MM-DD" (inclusive). */
  start: string;
  /** "YYYY-MM-DD" (inclusive). */
  end: string;
  status: string;
  priority?: TaskPriority;
  code?: string;
  taskId?: string;
  subtaskId?: string;
  leaveId?: string;
  leaveType?: LeaveType;
  project?: { _id: string; name: string; code: string } | null;
}

export interface MyCalendarResponse {
  from: string;
  to: string;
  items: MyCalendarItem[];
  total: number;
  limit: number;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Employee documents (/api/documents)                                 */
/* ------------------------------------------------------------------ */

export type DocumentType =
  | "passport"
  | "visa"
  | "work_permit"
  | "national_id"
  | "driving_license"
  | "contract"
  | "certificate"
  | "insurance"
  | "other";

export interface EmployeeDocument {
  _id: string;
  user: {
    _id: string;
    name: string;
    email: string;
    designation: string;
    employeeId: string | null;
    department: { _id: string; name: string } | null;
  } | null;
  type: DocumentType;
  name: string;
  issueDate: string | null;
  /** null = never expires. */
  expiryDate: string | null;
  notes: string;
  file: { filename: string; mimeType: string; size: number } | null;
  uploadedBy: { _id: string; name: string; email: string } | null;
  /** Days until expiry (negative = expired), null without expiry. */
  inDays: number | null;
  permissions: { edit: boolean; delete: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListResponse {
  documents: EmployeeDocument[];
  total: number;
  limit: number | null;
  offset: number;
}

export interface DocumentResponse {
  document: EmployeeDocument;
}

/** POST / PATCH /api/documents body (sent as multipart when a file is attached). */
export interface DocumentInput {
  type?: DocumentType;
  name?: string;
  /** "YYYY-MM-DD" or "" for none. */
  issueDate?: string;
  expiryDate?: string;
  notes?: string;
  /** Owner id (admins only, create). */
  user?: string;
  file?: File | null;
  /** PATCH: drop the stored file. */
  removeFile?: boolean;
}

// ---------------------------------------------------------------------------
// Meetings (transcripts → action items → tasks) — see backend/API-CONTRACT-meetings.md
// ---------------------------------------------------------------------------

/** `Meeting.project` as populated by the meeting endpoints. */
export interface MeetingProjectRef {
  _id: string;
  name: string;
  code: string;
  archivedAt: string | null;
}

export type MeetingSource = "upload" | "paste";

export interface TranscriptSegment {
  /** 0-based, stable — used by `?seg=<idx>`. */
  idx: number;
  /** Seconds from the meeting start. */
  start: number | null;
  end: number | null;
  /** Name as written in the transcript. */
  speaker: string | null;
  /** Plain text — always rendered escaped. */
  text: string;
}

/** Speaker → LPS user mapping (`user: null` = "Not in LPS"). */
export interface MeetingSpeaker {
  name: string;
  user: UserRef | null;
}

export type ActionItemOrigin = "hint" | "ai" | "manual";
export type ActionItemStatus = "suggested" | "task_created" | "dismissed";

export interface ActionItemTaskRef {
  _id: string;
  title: string;
  status: TaskStatus;
  shortCode: string | null;
  number: number | null;
  dueDate: string | null;
}

export interface MeetingActionItem {
  _id: string;
  /** Sorted segment indexes. */
  segmentIdxs: number[];
  quote: string;
  title: string;
  assignee: UserRef | null;
  /** Owner as named in the transcript (kept when not an LPS user). */
  assigneeName: string | null;
  /** "YYYY-MM-DD". */
  dueDate: string | null;
  priority: TaskPriority;
  origin: ActionItemOrigin;
  status: ActionItemStatus;
  task: ActionItemTaskRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingFile {
  filename: string;
  mimeType: string;
  size: number;
}

export interface MeetingDetail {
  _id: string;
  title: string;
  /** "YYYY-MM-DD". */
  meetingDate: string;
  project: MeetingProjectRef | null;
  source: MeetingSource;
  file: MeetingFile | null;
  segments: TranscriptSegment[];
  speakers: MeetingSpeaker[];
  notes: string;
  actionItems: MeetingActionItem[];
  aiExtractedAt: string | null;
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
  /** Segments the smart-hint rules flag. */
  hintSegmentIdxs: number[];
}

export interface MeetingPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canCreateTasks: boolean;
}

/** GET /api/meetings/:id and every mutation that returns the detail. */
export interface MeetingDetailResponse {
  meeting: MeetingDetail;
  permissions: MeetingPermissions;
  aiEnabled: boolean;
}

export interface MeetingListItem {
  _id: string;
  title: string;
  meetingDate: string;
  project: MeetingProjectRef | null;
  source: MeetingSource;
  file: MeetingFile | null;
  speakers: MeetingSpeaker[];
  createdBy: UserRef;
  aiExtractedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: {
    segments: number;
    suggested: number;
    tasksCreated: number;
    dismissed: number;
  };
}

export interface MeetingListResponse {
  meetings: MeetingListItem[];
  total: number;
  limit: number | null;
  offset: number;
}

/** POST /api/meetings/preview. */
export interface MeetingPreviewResponse {
  source: MeetingSource;
  filename: string | null;
  /** First 50 segments. */
  segments: TranscriptSegment[];
  segmentCount: number;
  speakers: { name: string; matchedUser: UserRef | null }[];
  warnings: string[];
  /** Users the caller may map speakers to. */
  candidates: UserRef[];
}

/** Transcript input shared by preview and create. */
export type TranscriptInput =
  { file: File; text?: never } | { text: string; file?: never };

export interface MeetingCreateInput {
  transcript: TranscriptInput;
  title?: string;
  meetingDate?: string;
  project?: string;
  speakers?: { name: string; user: string | null }[];
  notes?: string;
}

export interface MeetingUpdateInput {
  title?: string;
  meetingDate?: string;
  project?: string | null;
  notes?: string | null;
  speakers?: { name: string; user: string | null }[];
}

export interface ActionItemInput {
  segmentIdxs?: number[];
  title?: string;
  assignee?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority;
}

export interface ActionItemUpdateInput extends ActionItemInput {
  status?: "suggested" | "dismissed";
}

/** One entry of POST /api/meetings/:id/tasks. */
export interface MeetingTaskDraft {
  itemId?: string;
  segmentIdxs?: number[];
  title?: string;
  description?: string;
  assignees?: string[];
  dueDate?: string | null;
  priority?: TaskPriority;
  project?: string | null;
  milestone?: string | null;
  labels?: string[];
}

export interface MeetingTasksResponse {
  created: { itemId: string; task: Task & { warnings?: string[] } }[];
  skipped: { itemId: string | null; reason: string }[];
}

/* ------------------------------------------------------------------ */
/* Company / app settings (/api/settings)                              */
/* ------------------------------------------------------------------ */

export type DateFormat = "DD-MM-YYYY" | "MM-DD-YYYY" | "YYYY-MM-DD";
export type TimeFormat = "12h" | "24h";
export type WeekStart = "monday" | "sunday";

export interface CurrencySetting {
  code: string;
  symbol: string;
}

/** GET /settings/public — unauthenticated; drives branding and display formats. */
export interface PublicSettings {
  name: string;
  logoUrl: string | null;
  /** Versioned logo path relative to the API base. */
  logoPath: string | null;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  timezone: string;
  currency: CurrencySetting;
}

export interface CompanyAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/** GET/PATCH /settings/company (admin). Empty strings mean "not set". */
export interface CompanySettings {
  id: string | null;
  name: string;
  email: string;
  phone: string;
  website: string;
  logo: null | {
    mimeType: "image/png" | "image/jpeg" | "image/svg+xml";
    size: number;
    url: string;
    path: string;
  };
  address: CompanyAddress;
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  currency: CurrencySetting;
  appUrl: string;
  effective: { timezone: string; appUrl: string };
  envFallback: { timezone: string; appUrl: string };
  updatedAt: string | null;
}

export type CompanySettingsInput = Partial<{
  name: string;
  email: string;
  phone: string | null;
  website: string | null;
  appUrl: string | null;
  address: Partial<CompanyAddress> | null;
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  currency: Partial<CurrencySetting>;
}>;

/* ------------------------------------------------------------------ */
/* Imports (Excel / CSV) — see backend/API-CONTRACT-imports.md          */
/* ------------------------------------------------------------------ */

export type ImportType = "projects" | "tasks";
export type ImportJobStatus =
  "previewed" | "running" | "completed" | "failed" | "undone";
/** validate: ready | warning | error; run: created | updated | skipped | error. */
export type ImportRowStatus =
  "ready" | "warning" | "error" | "created" | "updated" | "skipped";

export interface ImportField {
  key: string;
  label: string;
  /** "create" = needed only for new records (project start date). */
  required: boolean | "create";
  accepts: string;
  example: string | number;
}

export interface ImportOptions {
  /** Projects: what to do when the code already exists (default "skip"). */
  onExisting?: "skip" | "update";
  /** Tasks: project _id for rows without a project value. */
  defaultProject?: string | null;
  /** Default false → in-app notifications only. */
  sendEmails?: boolean;
  /** Unknown people become warnings instead of row errors. */
  skipUnknownPeople?: boolean;
}

/** Column index (as a string) → field key. */
export type ImportMapping = Record<string, string>;

export interface ImportRow {
  row: number;
  status: ImportRowStatus;
  action: "create" | "update" | "skip" | null;
  messages: string[];
  recordId: string | null;
  recordRef: string | null;
}

export interface ImportTotals {
  rows: number;
  ready: number;
  warnings: number;
  errors: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface ImportJob {
  id: string;
  type: ImportType;
  status: ImportJobStatus;
  fileName: string;
  fileSize: number;
  fileAvailable: boolean;
  fileExpiresAt: string | null;
  sheets: string[];
  sheet: string | null;
  headerRow: boolean;
  columns: { index: number; header: string }[];
  rowCount: number;
  mapping: ImportMapping;
  options: ImportOptions;
  resultsOf: "validate" | "run" | null;
  totals: ImportTotals;
  progress: { processed: number; total: number };
  createdCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  undoUntil: string | null;
  canUndo: boolean;
  undoneAt: string | null;
  undoResult: {
    deleted: number;
    skipped: { id: string; ref: string | null; reason: string }[];
  } | null;
  error: string | null;
  hasErrorReport: boolean;
  createdBy: { id: string; name: string | null };
  createdAt: string;
  updatedAt: string;
  rows?: ImportRow[];
}

export interface ImportColumn {
  index: number;
  header: string;
  /** First 3 values. */
  samples: string[];
}

/** POST /api/imports/:type/preview response. */
export interface ImportPreviewResponse {
  jobId: string;
  job: ImportJob;
  fileName: string;
  format: "xlsx" | "csv";
  sheets: string[];
  sheet: string | null;
  headerRow: boolean;
  rowCount: number;
  columns: ImportColumn[];
  sampleRows: { row: number; cells: string[] }[];
  suggestedMapping: ImportMapping;
  fields: ImportField[];
  limits: { maxBytes: number; maxRows: number; inlineRows: number };
}

export interface ImportListResponse {
  imports: ImportJob[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Brands + Delivery Pulse (see backend/API-CONTRACT-pulse.md)
// ---------------------------------------------------------------------------

export type BrandColor = LabelColor;

export interface Brand {
  _id: string;
  name: string;
  shortName: string;
  /** Client group label ("Ajmal" for Ajmal GCC / Ajmal UK); "" = none. */
  organisation?: string;
  color: BrandColor;
  active: boolean;
  /** Absent on older brands (= approved). Pending / rejected brands can't be used yet. */
  status?: "approved" | "pending" | "rejected";
  projectCount: number;
  /** Brand flow: a pitch (has potential revenue) or a direct client. */
  isPitch?: boolean;
  revenue?: number | null;
  revenueTbc?: boolean;
  /** Scope read from the brand's files; non-empty = its projects' scope is locked to it. */
  scopeItems?: BrandScopeItem[];
  platforms?: string[];
  scopeNotes?: string[];
  /** "Other scope": the agreement's scope text not itemised as rows. */
  scopeText?: string;
  scopeFiles?: Array<{ filename: string; mimeType: string; size: number }>;
  leads?: string[];
  /** On the 1st of each month the brand gets that month's project automatically. */
  monthlyRetainer?: boolean;
  /** A brand-flow setup (project, lead tasks, team) waits for this brand's approval. */
  setupWaiting?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Brands section (/brands): GET /brands/overview and /brands/:id/detail
// ---------------------------------------------------------------------------

export interface BrandPersonRef {
  _id: string;
  name: string;
}

export interface BrandChecks {
  scope: boolean;
  docs: boolean;
  plan: boolean;
  lead: boolean;
}

export interface BrandCurrentProject {
  _id: string;
  name: string;
  code: string;
  startDate: string | null;
  deadline: string | null;
  /** Scope as text ("" = none). */
  scope: string;
  planLine: { key: string; name: string } | null;
}

export interface BrandSummary {
  _id: string;
  name: string;
  organisation: string;
  status: "approved" | "pending" | "rejected";
  isPitch: boolean;
  /** On the 1st of each month the brand gets that month's project automatically. */
  monthlyRetainer?: boolean;
  /** Has current projects or a line in the month's plan. */
  active: boolean;
  checks: BrandChecks;
  scopeItems: Array<BrandScopeItem & { what: string; languageList: string[] }>;
  /** How close the scope is to its agreement (advice only); null = not compared yet. */
  scopeMatch: StoredScopeMatch | null;
  /** Documents on the brand. */
  scopeFiles: number;
  /** Files on the brand's projects. */
  projectFiles: number;
  planLines: Array<{ key: string; name: string; section: ManpowerSection }>;
  /** Plan role → people on the brand's plan lines. */
  roles: Record<string, BrandPersonRef[]>;
  /** Roles marked "not needed" on the brand's lines. */
  notNeeded: string[];
  /** The team as proposed by the month's plan version waiting for approval (null: none pending). */
  pending?: { roles: Record<string, BrandPersonRef[]>; notNeeded: string[] } | null;
  leads: BrandPersonRef[];
  /** Number of people (plan lines + current projects' teams). */
  people: number;
  projectCount: number;
  current: BrandCurrentProject[];
}

export interface BrandPersonLoad {
  name: string;
  /** The month's projects the person is on (team-load). */
  projects: number;
  /** Brands the person is on this month. */
  brands: number;
}

/** The month's manpower plan version waiting for leadership approval. */
export interface PendingPlanInfo {
  version: number;
  by: BrandPersonRef | null;
  at: string;
  note: string;
  /** The approval request to open (null when there is none). */
  changeRequestId: string | null;
}

interface BrandDashboardBase {
  month: string;
  planVersion: number | null;
  pendingPlan?: PendingPlanInfo | null;
  /** The viewer's plan saves are approved at once (leadership); else they wait for approval. */
  planSavesApproved?: boolean;
  /** Names of everyone referenced (plan, pending plan, leads, teams). */
  names?: Record<string, string>;
  max: number;
  roles: Array<{ key: string; label: string }>;
  canCreate: boolean;
  canManage: boolean;
  /** Admins only (not the brand creators): rename the brand, applied at once. */
  canRename?: boolean;
  canEditPlan: boolean;
  canApprove: boolean;
  canSeeUtilisation: boolean;
  people: Record<string, BrandPersonLoad>;
  /** Plan role → people holding it somewhere in the month's plan. */
  pool: Record<string, string[]>;
}

export interface BrandOverviewResponse extends BrandDashboardBase {
  brands: BrandSummary[];
}

export interface BrandUtilisationRow {
  user: BrandPersonRef;
  roles: string[];
  projects: number;
  max: number;
  brands: number;
  /** Hours logged this month (approved + pending), all work / on this brand. */
  hours: number;
  brandHours: number;
}

export interface BrandDetail extends BrandSummary {
  shortName: string;
  revenue: number | null;
  revenueTbc: boolean;
  platforms: string[];
  scopeNotes: string[];
  /** "Other scope": the agreement's scope text not itemised as rows. */
  scopeText: string;
  /** The agreement's stated total (null = none). */
  scopeTotal: StatedTotal | null;
  setupWaiting: boolean;
  files: Array<{ _id: string; filename: string; mimeType: string; size: number }>;
  /** Open projects of the brand (for the split). */
  projects: Array<{ _id: string; name: string; code: string; current: boolean }>;
}

export interface BrandDetailResponse extends BrandDashboardBase {
  brand: BrandDetail;
  utilisation: BrandUtilisationRow[] | null;
  /** A scope change waiting for approval. */
  pendingScope?: BrandScopeRequest & { canWithdraw: boolean };
  /** The last scope change, rejected (until dismissed or resent). */
  lastRejectedScope?: BrandScopeRequest & { decidedBy: { _id: string; name: string } | null; decidedAt: string | null; reason: string; canDismiss: boolean };
}

/** A brand scope row: a project scope row plus what it is and the file it came from. */
export interface BrandScopeItem extends ScopeItem {
  what?: string;
  source?: string;
}

/** POST /brands/:id/move-projects(/preview) — what moving projects to another brand does. */
export interface BrandMoveItem {
  projectId: string;
  code: string;
  oldName: string;
  newName: string;
  type: string | null;
  month: string | null;
  /** The target brand's scope replaces the project's, or the project keeps its own. */
  scope: "replace" | "keep";
  line: { action: "relink" | "move" | "new" | "none"; key: string | null; name: string | null; from: string | null };
}

export interface BrandMovePreview {
  from: { _id: string; name: string };
  to: { _id: string; name: string; hasScope: boolean };
  items: BrandMoveItem[];
  notes: string[];
  /** true = leadership: the move applies at once; false = it goes for approval. */
  applies: boolean;
}

export interface BrandMoveResult {
  moved?: number;
  items: BrandMoveItem[];
  notes: string[];
  errors?: string[];
  plans?: Array<{ month: string; version: number; pendingApproval?: string }>;
  pendingApproval?: string;
}

export interface BrandInput {
  name?: string;
  shortName?: string;
  color?: BrandColor;
  active?: boolean;
  scopeItems?: BrandScopeItem[];
  /** "Other scope" text (same approval rules as the rows). */
  scopeText?: string;
}

/** POST /brands/scope-match — the scope rows against the agreement (advice only). */
export interface ScopeMatchResult {
  score: number;
  matched: string[];
  missingFromScope: string[];
  extraInScope: string[];
  changedQty: Array<{ unit: string; what: string; agreement: number; entered: number }>;
  source: "ai" | "rules";
}

/** The match stored on a brand. */
/** An agreement's stated total: the rows' quantities are checked against it (advice only). */
export interface StatedTotal {
  quantity: number;
  per: "month" | null;
  text: string;
  /** "Total: N" per phase (counts per phase); rows of a phase end with " — <phase>". */
  phases?: Array<{ phase: string; quantity: number }>;
}

/** A brand scope change request still waiting (pendingScope) or rejected (lastRejectedScope). */
export interface BrandScopeRequest {
  _id: string;
  requestedBy: { _id: string; name: string } | null;
  createdAt: string;
  /** The proposed scope (parts the request doesn't change are the current ones). */
  scopeItems: BrandScopeItem[];
  scopeText: string;
  scopeTotal: StatedTotal | null;
  rowsChanged: boolean;
  textChanged: boolean;
  totalChanged: boolean;
  scopeMatch: StoredScopeMatch | null;
  /** The requester, or anyone who may manage the brand scope: edit and resend. */
  canEdit: boolean;
}

export interface StoredScopeMatch {
  score: number;
  missing: string[];
  extra: string[];
  changed: ScopeMatchResult["changedQty"];
  source: "ai" | "rules";
  at: string;
}

/** A scope row as compared / diffed (brand rows have `what`, project rows don't). */
export interface DiffRow {
  unit: string;
  what?: string;
  quantity: number;
  languages?: number;
  languageList?: string[];
  sizes?: number;
}

export interface ScopeDiffSide {
  quantity: number;
  languages: string;
  sizes: number;
}

/** A scope against the previous one: rows added, removed and changed. */
export interface ScopeDiff {
  added: DiffRow[];
  removed: DiffRow[];
  changed: Array<{ unit: string; what: string; fromWhat?: string; from: ScopeDiffSide; to: ScopeDiffSide }>;
  same: number;
}

/** GET /brands/:id/scope-versions — one version of a brand's scope. */
export interface BrandScopeVersion {
  version: number;
  source: "create" | "upload" | "edit" | "approval";
  by: { _id: string; name: string } | null;
  approvedBy: { _id: string; name: string } | null;
  at: string;
  items: Array<BrandScopeItem & { what: string }>;
  files: string[];
  platforms: string[];
  notes: string[];
  /** "Other scope" text at this version. */
  scopeText: string;
  scopeMatch: { score: number } | null;
  diff: ScopeDiff;
  /** "Other scope" before / after, when it changed against the version before. */
  textDiff: { from: string; to: string } | null;
}

/** A lead name read from the documents, matched to a user (or not). */
export interface LeadMatch {
  name: string;
  source: string;
  user: { _id: string; name: string; email: string } | null;
}

/** POST /brands/scope-extract — what was read from the brief / SOW. */
export interface ScopeExtraction {
  texts: Array<{ source: string; text: string; read: boolean }>;
  projectName: string | null;
  platforms: string[];
  revenue: number | null;
  dates: {
    clientPresentation: string | null;
    milestone1: string | null;
    milestone2: string | null;
    /** The work period (project start / end), when the files state it. */
    startDate: string | null;
    endDate: string | null;
  };
  scope: Array<{ unit: string; what: string; quantity: number; languageList: string[]; sizes: number; source: string }>;
  notes: string[];
  /** The total the agreement states ("96 content pieces per month"): a check for the rows, never a row. */
  statedTotal?: StatedTotal | null;
  /** The rest of the scope text, not itemised as rows or notes (one tidied text). */
  otherScope?: string;
  /** Lead names read from the documents ("Account Lead: …"), matched to users. */
  leadMatches?: LeadMatch[];
  usedAI: boolean;
}

/** A pitch-tracker date cell: the date, or a month only (its last day), plus the text as written. */
export interface PitchSheetDate {
  date: string | null;
  monthOnly: boolean;
  text: string;
}

/** POST /brands/pitch-sheet — one row of the pitch tracker. */
export interface PitchSheetRow {
  client: string;
  campaign: string;
  revenue: number | null;
  revenueTbc: boolean;
  clientPresentation: PitchSheetDate;
  milestone1: PitchSheetDate;
  milestone2: PitchSheetDate;
  status: string;
  lead: string;
}

/** Brand as populated on a project. */
export interface ProjectBrandRef {
  _id: string;
  name: string;
  shortName: string;
  color: BrandColor;
  active: boolean;
}

export interface OutcomeReadiness {
  score: number;
  verdict: "good" | "partial" | "weak";
  covered: string[];
  missing: string[];
  reply: string;
  source: "ai" | "rules";
}

export interface DeliverySettings {
  trafficManagers: string[];
  dashboardTeams: string[] | null;
  reworkKeywords: string[];
  reworkCategories: string[];
  briefingWeekday: number;
  minLeadDays: number;
  sameDayBrands: string[];
  finalAssetDomains: string[];
  briefMinLength: number;
  minCompletedToRank: number;
  staleDays: number;
  /** Outcome readiness advice when closing tasks (default on). */
  outcomeReadiness: boolean;
  brandTeamMap: { brand: string; users: string[] }[];
  teamMapStartDate: string;
  updatedAt: string | null;
}

export type DeliverySettingsInput = Partial<
  Omit<DeliverySettings, "updatedAt">
>;

export interface DeliverySettingsResponse {
  settings: DeliverySettings;
  defaults: {
    reworkKeywords: string[];
    reworkCategoryNames: string[];
    briefingWeekday: number;
    minLeadDays: number;
    finalAssetDomains: string[];
    briefMinLength: number;
    minCompletedToRank: number;
    staleDays: number;
    outcomeReadiness?: boolean;
  };
  changed?: string[];
}

export type DeliveryPeriod = "7d" | "30d" | "90d" | "12m" | "all" | "custom";

export interface DeliveryFilters {
  period: DeliveryPeriod;
  team: string;
  brand: string;
  person: string;
  /** Custom period only: "YYYY-MM-DD" (inclusive). */
  from?: string;
  to?: string;
}

export interface DeliveryMeta {
  period: DeliveryPeriod;
  days: number;
  today: string;
  range: { start: string; end: string };
  previous: { start: string; end: string } | null;
  asOf: string;
  timezone: string;
  filters: { team: string | null; brand: string | null; person: string | null };
  scope: {
    kind: "all" | "department";
    departmentId: string | null;
    departmentName: string | null;
    noDepartment: boolean;
  };
}

export interface DeliveryStats {
  created: number;
  completed: number;
  completedWithDue: number;
  completedNoDue: number;
  onTimePct: number | null;
  meanDays: number | null;
  /** Mean days from the actual start to done (completed in the period with an actual start). */
  startToDoneDays: number | null;
  startedCompleted: number;
  /** Actual starts after the planned start date, of those with both. */
  lateStartPct: number | null;
  lateStarts: number;
  startsWithPlan: number;
  rework: number;
  reworkPct: number | null;
  open: number;
  overdue: number;
}

export interface DeliveryDelta {
  current: number | null;
  previous: number | null;
  change: number | null;
  direction: "up" | "down" | "flat" | null;
  good: boolean | null;
  betterWhen: "higher" | "lower" | "neutral";
  noPreviousData: boolean;
}

export interface DeliveryUserRef {
  id: string | null;
  name: string;
  former: boolean;
}

export interface DeliveryBrandRef {
  id: string;
  name: string;
  shortName: string;
  color: string;
  active: boolean;
  noBrand: boolean;
}

export type DeliveryTaskStatus =
  "todo" | "in_progress" | "in_review" | "completed" | "rejected";

export interface DeliveryTaskRow {
  id: string;
  code: string;
  title: string;
  status: DeliveryTaskStatus;
  brand: DeliveryBrandRef;
  project: { id: string; code: string; name: string } | null;
  doers: DeliveryUserRef[];
  briefer: DeliveryUserRef;
  createdDate: string;
  dueDate: string | null;
  daysLate: number | null;
}

export interface DeliverySummaryResponse {
  meta: DeliveryMeta;
  kpis: DeliveryStats;
  previous: DeliveryStats | null;
  deltas: {
    created: DeliveryDelta;
    completed: DeliveryDelta;
    onTimePct: DeliveryDelta;
    meanDays: DeliveryDelta;
    startToDoneDays: DeliveryDelta;
    lateStartPct: DeliveryDelta;
    reworkPct: DeliveryDelta;
    open: DeliveryDelta;
    overdue: DeliveryDelta;
  };
  /** Tasks briefed (created) in the last 7 days, vs the 7 days before. */
  addedThisWeek: { count: number; delta: DeliveryDelta };
}

export interface DeliveryWeekRow {
  weekStart: string;
  weekEnd: string;
  created: number;
  completed: number;
  onTimePct: number | null;
  meanDays: number | null;
  startToDoneDays: number | null;
  open: number;
  overdue: number;
  overduePct: number | null;
  rework: number;
  reworkPct: number | null;
}

export interface DeliveryWeeklyResponse {
  meta: DeliveryMeta;
  capped: boolean;
  maxWeeks: number;
  weeks: DeliveryWeekRow[];
}

export interface DeliveryPerformer {
  person: DeliveryUserRef;
  /** Short reason, e.g. "92% on time · 1.4d mean". */
  why: string;
}

export type DeliveryTeamRow = DeliveryStats & {
  team: { id: string; name: string };
  volume: number;
  /** People in the team with work in the period. */
  people: number;
  /** Mean days brief → done, tasks completed in the last 30 days. */
  meanDays30: number | null;
  /** null = fewer than 2 people with enough completed tasks. */
  best: DeliveryPerformer | null;
  bottom: DeliveryPerformer | null;
};

export interface DeliveryTeamsResponse {
  meta: DeliveryMeta;
  minCompletedToRank: number;
  rows: DeliveryTeamRow[];
}

export type DeliveryBrandDeltaKey =
  "created" | "completed" | "onTimePct" | "meanDays" | "reworkPct" | "overdue";

export type DeliveryBrandRow = DeliveryStats & {
  brand: DeliveryBrandRef;
  previous: DeliveryStats | null;
  deltas: Record<DeliveryBrandDeltaKey, DeliveryDelta> | null;
  /** Mean LPS brief score (0–100) of the brand's tasks created in the period. */
  briefScore: number | null;
  briefsScored: number;
  /** Warning signs vs the previous period (null without one). */
  warnings: { count: number; flags: ("reworkUp" | "onTimeDown" | "overdueUp")[] } | null;
};

export interface DeliveryBrandsResponse {
  meta: DeliveryMeta;
  rows: DeliveryBrandRow[];
}

export type DeliveryDelayedRow = DeliveryTaskRow & {
  stale: boolean;
  rejected: boolean;
};

export interface DeliveryDelayedResponse {
  meta: DeliveryMeta;
  staleDays: number;
  includeStale: boolean;
  total: number;
  hiddenStale: number;
  truncated: boolean;
  rows: DeliveryDelayedRow[];
}

export type DeliveryBriefRuleKey =
  | "brief_attached"
  | "written_brief"
  | "monday"
  | "lead_time"
  | "not_same_day"
  | "on_map"
  | "final_asset";

export interface DeliveryRuleDef {
  key: DeliveryBriefRuleKey;
  label: string;
}

export interface DeliveryRuleRate {
  passed: number;
  applicable: number;
  pct: number | null;
}

/** Lowest-scoring briefs of the period (LPS rules). */
export type DeliveryWeakBrief = DeliveryTaskRow & {
  score: number;
  passed: number;
  applicable: number;
  failed: DeliveryBriefRuleKey[];
  snippet: string;
};

export interface DeliveryBriefSummary {
  briefs: number;
  /** Mean LPS brief score (0–100). */
  score: number | null;
  checks: Record<DeliveryBriefRuleKey, DeliveryRuleRate>;
  /** Tasks with a description or an attachment. */
  covered: number;
  coveragePct: number | null;
  /** AI brief check verdicts among the briefs that have been checked. */
  ai: { checked: number; ok: number; weak: number; flagged: number; okPct: number | null; avgScore?: number | null };
  rework: number;
  reworkPct: number | null;
}

export interface DeliveryBriefAttention extends DeliveryTaskRow {
  issue: "flagged" | "missing" | "weak";
  reason: string;
}

/** GET /analytics/delivery/briefs — coverage + AI quality by briefer. */
export interface DeliveryBriefsResponse {
  meta: DeliveryMeta;
  aiConfigured: boolean;
  aiModel: string | null;
  rules: DeliveryRuleDef[];
  totals: DeliveryBriefSummary;
  byBriefer: ({ briefer: DeliveryUserRef } & DeliveryBriefSummary)[];
  weakest: DeliveryWeakBrief[];
  attentionWindowDays: number;
  attention: DeliveryBriefAttention[];
}

export interface DeliveryPerson extends DeliveryUserRef {
  designation: string;
  role: string | null;
  department: { id: string; name: string } | null;
  team: { id: string; name: string };
  isTrafficManager: boolean;
}

export type DeliveryPersonStats = DeliveryStats & {
  brandCount: number;
  ranked: boolean;
  /** Completed in the last 7 / 30 days (whatever the period). */
  completedThisWeek: number;
  completed30d: number;
};

export interface DeliveryPeopleResponse {
  meta: DeliveryMeta;
  minCompletedToRank: number;
  rows: (DeliveryPersonStats & { person: DeliveryPerson })[];
}

export interface DeliveryPersonResponse {
  meta: DeliveryMeta;
  person: DeliveryPerson;
  minCompletedToRank: number;
  stats: DeliveryPersonStats;
  brands: (DeliveryStats & { brand: DeliveryBrandRef })[];
  weekly: { capped: boolean; weeks: DeliveryWeekRow[] };
  /** Calendar months in the period, newest first. */
  monthly: { month: string; completed: number; meanDays: number | null; onTimePct: number | null; completedWithDue: number }[];
  openWork: DeliveryTaskRow[];
}

export interface DeliveryStructureCounts {
  total: number;
  open: number;
  completed: number;
  overdue: number;
}
export interface DeliveryStructurePerson extends DeliveryStructureCounts {
  person: DeliveryUserRef;
}
export interface DeliveryStructureTask {
  id: string;
  code: string;
  title: string;
  status: string;
  dueDate: string | null;
  overdue: boolean;
  assignees: DeliveryUserRef[];
}
export interface DeliveryStructureProject extends DeliveryStructureCounts {
  project: { id: string | null; code: string; name: string };
  people: DeliveryStructurePerson[];
  tasks: DeliveryStructureTask[];
  moreTasks: number;
}
export interface DeliveryStructureBrand extends DeliveryStructureCounts {
  brand: DeliveryBrandRef;
  people: DeliveryStructurePerson[];
  projects: DeliveryStructureProject[];
}
/** GET /analytics/delivery/brand-structure — brand › project › tasks + assignees, active in the period. */
export interface DeliveryBrandStructureResponse {
  meta: DeliveryMeta;
  totals: { brands: number; projects: number; tasks: number; open: number };
  brands: DeliveryStructureBrand[];
}

export interface DeliveryTeamMapWorker {
  person: DeliveryUserRef;
  count: number;
}
export interface DeliveryTeamMapRow {
  brand: DeliveryBrandRef;
  /** People on the brand's map (configured, or derived from its projects' members). */
  mapped: DeliveryUserRef[];
  derived: boolean;
  /** Months whose manpower plan supplied the map for this brand's tasks. */
  planMonths: string[];
  /** Tasks created or completed since the start date. */
  tasks: number;
  /** Tasks done entirely by people off the map; null when the brand has no map. */
  offMapTasks: number | null;
  offMapPct: number | null;
  onMapWorking: DeliveryTeamMapWorker[];
  offMapWorking: DeliveryTeamMapWorker[];
  mappedUnused: DeliveryUserRef[];
}
/** GET /analytics/delivery/team-map — per-brand coverage table since the tracking start date. */
export interface DeliveryTeamMapResponse {
  meta: DeliveryMeta;
  startDate: string;
  mappedBrands: number;
  derivedBrands: number;
  /** Months in the tracking window that have a manpower plan. */
  planMonths: string[];
  totals: { tasks: number; offMapTasks: number };
  rows: DeliveryTeamMapRow[];
}

/* ------------------------------------------------------------------ */
/* Forgot password (POST /api/auth/password-reset/request|verify|complete) */
/* ------------------------------------------------------------------ */

/** POST /auth/password-reset/request — always the same generic answer. */
export interface PasswordResetRequestResponse {
  message: string;
  resendAfterSeconds: number;
}

/** POST /auth/password-reset/verify — a correct code returns a short-lived reset token. */
export interface PasswordResetVerifyResponse {
  resetToken: string;
  expiresInSeconds: number;
}

/* ------------------------------------------------------------------ */
/* Set-password links (POST /api/users/:id/password-link, /password-setup/:token) */
/* ------------------------------------------------------------------ */

/** Why a set-password link can no longer be used (410 `reason`). */
export type PasswordSetupGoneReason = "used" | "expired" | "revoked";

/** Public preview of a set-password link (GET /password-setup/:token). */
export interface PasswordSetupPreview {
  name: string;
  email: string;
  expiresAt: string;
}

/** POST /users/:id/password-link response. A new link revokes older unused ones. */
export interface PasswordLinkResponse {
  setupUrl: string;
  expiresAt: string;
  /** False when SMTP isn't configured or `sendEmail` was false — share the link manually. */
  emailed: boolean;
  passwordSetupRequired: boolean;
  mustChangePassword?: boolean;
}

export type PasswordLinkResultStatus = "created" | "not_found" | "invalid";

export interface PasswordLinkResult {
  userId: string;
  status: PasswordLinkResultStatus;
  setupUrl?: string;
  expiresAt?: string;
  emailed?: boolean;
}

/** POST /users/password-links response. */
export interface PasswordLinksResponse {
  results: PasswordLinkResult[];
  emailConfigured: boolean;
}

// ---------------------------------------------------------------------------
// HR trainings
// ---------------------------------------------------------------------------

export type TrainingStatus = "not_started" | "in_progress" | "completed";

export interface TrainingSummary {
  _id: string;
  title: string;
  description: string;
  slideCount: number;
  dueDate: string | null;
  version: number;
  archived: boolean;
  /** Pops up at sign-in until completed. */
  mandatory: boolean;
  completeWithinDays: number;
  sourceFile: { filename: string; size: number };
  assignAll: boolean;
  departments: string[];
  users: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TrainingProgressSummary {
  viewedCount: number;
  /** Slide numbers not read yet (empty once completed). */
  missing?: number[];
  startedAt: string | null;
  completedAt: string | null;
  status: TrainingStatus;
}

export interface MyTraining extends TrainingSummary {
  progress: TrainingProgressSummary;
}

export interface TrainingDetailResponse {
  training: TrainingSummary;
  assigned: boolean;
  progress: TrainingProgressSummary & { viewed: number[] };
}

export interface AdminTraining extends TrainingSummary {
  stats: { assigned: number; started: number; completed: number };
}

export interface TrainingProgressRow extends TrainingProgressSummary {
  user: {
    _id: string;
    name: string;
    email: string;
    designation: string;
    department: Pick<Department, "_id" | "name"> | null;
  };
  /** When HR was emailed about the completion, and to whom. */
  hrNotifiedAt?: string | null;
  hrNotifiedTo?: string[];
}

export interface TrainingInput {
  title: string;
  description: string;
  dueDate: string;
  assignAll: boolean;
  departments: string[];
  users: string[];
  file?: File | null;
  resetProgress?: boolean;
  archived?: boolean;
  mandatory?: boolean;
  completeWithinDays?: number;
}

/** GET /trainings/required — mandatory trainings the person hasn't completed. */
export interface RequiredTraining extends TrainingSummary {
  firstSeenAt: string;
  deadline: string;
  overdue: boolean;
  viewedCount: number;
}

/* ------------------------------------------------------------------ */
/* Manpower plan (/api/manpower)                                       */
/* ------------------------------------------------------------------ */

export interface ManpowerRoleDef {
  key: string;
  label: string;
}

export type ManpowerSection = "active" | "pitch";

export interface ManpowerPersonRef {
  _id: string;
  name: string;
  designation?: string;
}

export interface ManpowerCell {
  role: string;
  users: ManpowerPersonRef[];
  placeholders: string[];
  notNeeded: boolean;
  note: string;
}

export interface ManpowerRow {
  key: string;
  section: ManpowerSection;
  brand: { _id: string; name: string; shortName?: string; color?: string; active?: boolean } | null;
  type: string | null;
  name: string;
  cells: ManpowerCell[];
}

export type ManpowerVersionStatus = "approved" | "pending" | "rejected" | "superseded";

export interface ManpowerVersionSummary {
  version: number;
  note: string;
  source: "import" | "edit" | "copy";
  /** Leadership approval (saves by non-leadership editors wait for it). */
  status?: ManpowerVersionStatus;
  createdAt: string;
  createdBy: { _id: string; name: string } | null;
  rowCount: number;
}

export interface ManpowerPersonAllocation {
  user: ManpowerPersonRef;
  rows: Array<{ key: string; name: string; section: ManpowerSection; roles: string[] }>;
  activeRows: number;
  pitchRows: number;
  leaveDays: number;
  overAllocated: boolean;
}

/** GET /manpower — months with a plan, and the role columns. */
export interface ManpowerMonthsResponse {
  roles: ManpowerRoleDef[];
  limits: { maxRows: number; defaultMaxProjectsPerPerson: number; maxProjectsPerPersonMax: number };
  /** Whether the signed-in user may change the plan (leadership and Nazeer). */
  canEdit?: boolean;
  months: Array<{ month: string; latestVersion: number; versions: number; updatedAt: string }>;
}

/** GET /manpower/:month?version=N */
export interface ManpowerPlanResponse {
  month: string;
  version: number;
  /** Latest approved version (edits start from it); null while only a pending one exists. */
  latestVersion: number | null;
  /** A version waiting for leadership approval, if any. */
  pendingVersion?: number | null;
  /** The viewer's saves are approved at once (leadership); else they wait for approval. */
  savesApproved?: boolean;
  /** Status of the version shown. */
  status?: ManpowerVersionStatus;
  versions: ManpowerVersionSummary[];
  plan: {
    _id: string;
    month: string;
    version: number;
    rows: ManpowerRow[];
    note: string;
    maxProjectsPerPerson: number;
    source: "import" | "edit" | "copy";
    createdAt: string;
    createdBy: { _id: string; name: string } | null;
  };
  /** Projects of the month linked to each row (by row key). */
  links: Record<string, Array<{ _id: string; code: string; name: string }>>;
  /** The month's projects that match no row. */
  unlinkedProjects?: Array<{ _id: string; code: string; name: string }>;
  /** Each line's scope (linked projects' scope rows added up per unit). */
  scope?: Record<string, Array<{ unit: string; total: number }>>;
  people: ManpowerPersonAllocation[];
  available: Array<ManpowerPersonRef & { leaveDays: number }>;
}

/** Row as sent to POST /manpower/:month (ids instead of refs). */
export interface ManpowerRowInput {
  key: string;
  section: ManpowerSection;
  brand: string | null;
  type: string | null;
  name: string;
  cells: Array<{ role: string; users: string[]; placeholders: string[]; notNeeded: boolean; note: string }>;
}

export interface ManpowerSaveInput {
  month: string;
  baseVersion: number | null;
  rows: ManpowerRowInput[];
  note: string;
  maxProjectsPerPerson?: number;
  source?: "edit" | "copy";
}

/** GET /manpower/suggest — the plan row a project matches, as a team by role. */
export interface ManpowerTeamSuggestion {
  row: { key: string; name: string; version: number; month: string } | null;
  team: Array<{ role: string; users: Array<{ _id: string; name: string }> }>;
}

/* ------------------------------------------------------------------ */
/* Project approval                                                    */
/* ------------------------------------------------------------------ */

export interface ProjectApprovalView {
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  /** Populated on the detail page; a plain id in lists. */
  requestedBy: { _id: string; name: string | null } | string | null;
  decidedAt: string | null;
  decidedBy: { _id: string; name: string | null } | string | null;
  reason: string;
}

/** GET /project-approval/:token (public). */
export interface ProjectApprovalLinkResponse {
  approver: { name: string };
  project: {
    _id: string;
    name: string;
    code: string;
    tag: string | null;
    brand: string | null;
    type: string | null;
    month: string | null;
    manager: string | null;
    requestedBy: string | null;
    summary: string;
    team: string[];
    approval: ProjectApprovalView | null;
  };
}

/** GET /projects/approvals — the approver's queue. */
export interface BrandApprovalItem {
  _id: string;
  name: string;
  shortName: string;
  status: "approved" | "pending" | "rejected";
  requestedBy: { _id: string; name: string; email?: string } | null;
  decidedBy: { _id: string; name: string } | null;
  decidedAt: string | null;
  rejectReason: string;
  createdAt: string;
}

export interface ProjectApprovalQueue {
  isApprover: boolean;
  pending: ProjectApprovalLinkResponse["project"][];
  recent: ProjectApprovalLinkResponse["project"][];
  /** New brands waiting for leadership (same approvers). */
  brands?: { pending: BrandApprovalItem[]; recent: BrandApprovalItem[] };
  /** Scope / team, brand and manpower plan changes waiting for leadership. */
  changes?: { pending: ChangeRequestItem[]; recent: ChangeRequestItem[] };
}

/** A change waiting for (or decided by) leadership. */
export interface ChangeRequestItem {
  _id: string;
  kind: "project_change" | "brand_edit" | "manpower_plan" | "project_move";
  status: "pending" | "approved" | "rejected" | "superseded" | "withdrawn";
  title: string;
  brand: { _id: string; name: string } | null;
  project: { _id: string; name: string; code: string } | null;
  month: string | null;
  version: number | null;
  changes: Array<{ label: string; before: string; after: string }>;
  requestedBy: { _id: string; name: string; email?: string } | null;
  decidedBy: { _id: string; name: string } | null;
  decidedAt: string | null;
  reason: string;
  createdAt: string;
}

/** GET /analytics/delivery/traffic — the traffic desk. */
export interface DeliveryTrafficResponse {
  meta: DeliveryMeta;
  configured: boolean;
  managers: Array<{ person: DeliveryUserRef; waiting: number; routed: number; avgHours: number | null; medianHours: number | null }>;
  waiting: Array<{
    id: string;
    code: string;
    title: string;
    manager: DeliveryUserRef;
    project: string | null;
    waitingDays: number;
    dueDate: string | null;
  }>;
  totals: { waiting: number; routed: number; avgHours: number | null; medianHours: number | null };
}

/** A project scope row: quantity × languages × sizes of one unit. */
export interface ScopeItem {
  unit: string;
  quantity: number;
  /** Multiplier (= languageList.length when languages are picked). */
  languages: number;
  /** The languages picked ("English", "Arabic" …). */
  languageList?: string[];
  sizes: number;
}

/** POST /brands/pitch-import/preview — what one tracker row creates. */
export interface PitchImportRow {
  client: string;
  brand: { _id: string; name: string; status: string } | null;
  title: string;
  month: string;
  projectName: string;
  revenue: number | null;
  revenueTbc: boolean;
  status: string;
  leadText: string;
  leads: string[];
  tasks: Array<{ title: string; dueDate: string | null }>;
  warnings: string[];
  exists: boolean;
}

export interface PitchImportResult {
  client: string;
  title: string;
  status: "created" | "skipped" | "failed";
  message: string;
  projectId?: string;
  tasks?: number;
}
// ---------------------------------------------------------------------------
// Brands → Pitch plan (GET /api/brands/pitches)
// ---------------------------------------------------------------------------

export type PitchStepKey = "milestone1" | "milestone2" | "clientPresentation";
export type PitchTone = "ok" | "soon" | "missed" | "done" | "none";

export interface PitchStatus {
  text: string;
  tone: PitchTone;
  next?: { key: PitchStepKey; title: string; due: string | null };
  missed: Array<{ key: PitchStepKey; title: string; due: string; emailed: boolean }>;
}

export interface PitchStepState {
  key: PitchStepKey;
  title: string;
  due: string | null;
  done: boolean;
  taskId: string | null;
  assignees: string[];
  notified: boolean;
}

export interface PitchRow {
  id: string;
  name: string;
  code: string;
  brand: { id: string; name: string; organisation: string } | null;
  title: string;
  month: string | null;
  /** "YYYY-MM" plan group; null = "Dates not set". */
  group: string | null;
  revenue: number | null;
  revenueTbc: boolean;
  revenueHidden: boolean;
  clientPresentation: string | null;
  milestone1: string | null;
  milestone2: string | null;
  deadline: string | null;
  steps: PitchStepState[];
  status: PitchStatus;
  onTime: "on_time" | "late" | "na";
  openTasks: number;
  note: string;
  leads: Array<{ id: string; name: string }>;
  managerId: string | null;
  canEdit: boolean;
}

export interface PitchesResponse {
  quarter: string;
  label: string;
  rows: PitchRow[];
  /** Dubai calendar date the statuses were computed for. */
  today: string;
  totals: { count: number; revenue: number; tbc: number };
}
