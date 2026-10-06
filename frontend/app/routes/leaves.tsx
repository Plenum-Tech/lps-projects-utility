import { ModuleTabsPage } from "@/components/layout/module-tabs-page";
import { BalancesTab, PoliciesTab, RequestsTab } from "@/components/leaves/manage-leaves";
import { MyLeaveRequests } from "@/components/leaves/my-leave-requests";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/leaves";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Leaves | Employee Management System" }];
}

/**
 * HR → Leaves (`?tab=` mine | team | balances | policies).
 * - Employees: their own requests.
 * - Heads: My requests | Team requests (their department's employees; the API
 *   scopes and authorizes every decision). Their own requests go to an admin.
 * - Admins: My requests | Team requests (everyone) | Balances | Leave policies.
 */
export default function LeavesPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;

  if (user.role === "head") {
    return (
      <ModuleTabsPage
        title="Leaves"
        description="Apply for time off and review your department's leave requests."
        defaultTab="mine"
        tabs={[
          { value: "mine", label: "My requests", content: <MyLeaveRequests embedded /> },
          { value: "team", label: "Team requests", content: <RequestsTab /> },
        ]}
      />
    );
  }

  if (user.role !== "admin") return <MyLeaveRequests />;

  return (
    <ModuleTabsPage
      title="Leaves"
      description="Apply for time off, review your team's requests, and manage balances and policies."
      defaultTab="mine"
      tabs={[
        { value: "mine", label: "My requests", content: <MyLeaveRequests embedded /> },
        { value: "team", label: "Team requests", content: <RequestsTab /> },
        { value: "balances", label: "Balances", content: <BalancesTab /> },
        { value: "policies", label: "Leave policies", content: <PoliciesTab /> },
      ]}
    />
  );
}
