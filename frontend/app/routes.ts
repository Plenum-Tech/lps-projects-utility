import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // Public: accept an email invitation (outside the auth guard).
  route("invite/:token", "routes/invite.$token.tsx"),
  // Public: set a password from an admin-issued link (imported accounts, resets).
  route("set-password/:token", "routes/set-password.$token.tsx"),
  // Public: forgot password (email → 6-digit code → new password).
  route("forgot-password", "routes/forgot-password.tsx"),
  // Public: approve / reject a new project from the emailed link.
  route("project-approval/:token", "routes/project-approval.$token.tsx"),
  layout("routes/protected.tsx", [
    route("dashboard", "routes/dashboard.tsx"),
    route("profile", "routes/profile.tsx"),
    route("leaves", "routes/leaves.tsx"),
    route("announcements", "routes/announcements.tsx"),
    route("training", "routes/training.tsx"),
    route("training/:id", "routes/training.$id.tsx"),
    route("feedback", "routes/feedback.tsx"),
    route("attendance", "routes/attendance.tsx"),
    route("performance-reviews", "routes/performance-reviews.tsx"),
    route("tasks", "routes/tasks.tsx"),
    route("tasks/recurring", "routes/tasks.recurring.tsx"),
    route("brands", "routes/brands.tsx"),
    route("brands/:id", "routes/brands.$id.tsx"),
    route("projects", "routes/projects.tsx"),
    route("pitches", "routes/pitches.tsx"),
    route("projects/:id", "routes/projects.$id.tsx"),
    route("meetings", "routes/meetings.tsx"),
    route("meetings/:id", "routes/meetings.$id.tsx"),
    route("manpower", "routes/manpower.tsx"),
    route("approvals", "routes/approvals.tsx"),
    route("approvals/project/:id", "routes/approvals.project.tsx"),
    route("approvals/:id", "routes/approvals.change.tsx"),
    route("timesheet", "routes/timesheet.tsx"),
    route("timelogs", "routes/timelogs.tsx"),
    route("reports/delivery", "routes/reports.delivery.tsx"),
    route("reports/tasks", "routes/reports.tasks.tsx"),
    route("reports/time", "routes/reports.time.tsx"),
    route("reports/timesheets", "routes/reports.timesheets.tsx"),
    route("ai-insights", "routes/ai-insights.tsx"),
    route("documents", "routes/documents.tsx"),
    route("settings/:section?", "routes/settings.tsx"),
    // Admin pages: one role guard (admins only unless a page's `handle` widens it).
    layout("routes/admin/layout.tsx", [
      ...prefix("admin", [
        route("users", "routes/admin/users.tsx"),
        route("departments", "routes/admin/departments.tsx"),
        route("leaves", "routes/admin/leaves.tsx"),
        route("feedback", "routes/admin/feedback.tsx"),
        route("activity-log", "routes/admin/activity-log.tsx"),
        route("performance-reviews", "routes/admin/performance-reviews.tsx"),
        route("tasks", "routes/admin/tasks.tsx"),
        route("task-settings", "routes/admin/task-settings.tsx"),
        route("project-settings", "routes/admin/project-settings.tsx"),
        route("ai-insights", "routes/admin/ai-insights.tsx"),
      ]),
    ]),
  ]),
] satisfies RouteConfig;
