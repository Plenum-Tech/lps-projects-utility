import { AccessDenied } from "@/components/globals/query-states";
import { TimeReport } from "@/components/reports/time-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.time";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Time Log Report | LPS" }];
}

/** Admins, heads (their department, server-side) and Finance. */
export default function TimeReportPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  // Admins, heads and Finance (computed by the server).
  if (!(user.access?.timeReport ?? user.role !== "employee")) {
    return (
      <AccessDenied
        title="Not available"
        description="The time log report is available to administrators, heads of department and Finance."
      />
    );
  }
  return <TimeReport role={user.role === "employee" ? "admin" : user.role} />;
}
