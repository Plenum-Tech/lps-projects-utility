import { AccessDenied } from "@/components/globals/query-states";
import { TimeReport } from "@/components/reports/time-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.time";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Time Log Report | Employee Management System" }];
}

/** Head/admin only — heads are limited to their department server-side. */
export default function TimeReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") {
    return (
      <AccessDenied
        title="Managers only"
        description="The time log report is available to department heads and administrators."
      />
    );
  }
  return <TimeReport role={user.role} />;
}
