# Leave approvals by department heads

## Goal

Department heads view and approve/reject leave requests of the employees in their own department. Admins keep full access; employees are unchanged. Leave policies and balances stay admin-only.

## Rules

- Head scope = users with `department === head.department` **and** `role === "employee"` (never the head's own requests, other heads' or admins'). A head without a department sees nothing.
- A head's own request is decided by an admin.
- Enforced server-side on `GET /api/leaves` (list/search scoped) and `PATCH /api/leaves/:id/decide` (403 outside scope). There is no single-leave GET and no cancel-on-behalf endpoint.
- Approval deducts the balance exactly once: the `pending → decided` transition is an atomic `findOneAndUpdate({ status: "pending" })`, so concurrent decisions by a head and an admin can't both succeed.
- Activity log: actor = approver (+ `employee`, `decidedByRole` in details). The employee's notification and email name who decided ("… approved by Jane Doe", "Approved by" row).
- Lists populate `decidedBy` (`{ _id, name }`).

## Notifications

- New type `leave_requested`: on submit, admins + the applicant's department heads (employees only; heads' requests go to admins) get an in-app notification linking to `/leaves?tab=team` and an email gated by the new email preference `leaveRequests` (admins & heads, default on).
- `leave-updated` SSE goes to the owner, the decider and every reviewer of the owner (instead of all admins/heads).

## Frontend

- `/leaves` for heads: tabs My requests | Team requests (department-scoped, approve/reject). Admin view unchanged. Sidebar "Leaves" for heads opens `?tab=team`.
- A head's own pending requests show "Awaiting admin approval"; decided rows show "by <name>".
- Profile/Settings email preferences list "Leave requests" for admins & heads.

## Done when

Backend + frontend typecheck and frontend build pass; head A approves a dept-A employee, gets 403 for dept B / own / another head's request; admin approves a head's request; balance deducted once; notifications name the approver.
