import type { ReactNode } from "react";
import { LuBriefcaseBusiness } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyProfile } from "@/hooks/use-users";
import { formatPlainDate } from "@/lib/time";

/** Profile → read-only employment details (HR fields are admin-managed). */
export function EmploymentCard() {
  const profile = useMyProfile();
  const user = profile.data;

  const rows: { label: string; value: ReactNode; show: boolean }[] = user
    ? [
        { label: "Designation", value: user.designation || "—", show: true },
        {
          label: "Employee ID",
          value: user.employeeId ? <span className="font-mono">{user.employeeId}</span> : "—",
          show: true,
        },
        { label: "Department", value: user.department?.name ?? "Unassigned", show: true },
        { label: "Joining date", value: formatPlainDate(user.joiningDate), show: true },
        { label: "Date of birth", value: formatPlainDate(user.dateOfBirth), show: true },
        {
          label: "Probation ends",
          value: formatPlainDate(user.probationEndDate),
          show: Boolean(user.probationEndDate),
        },
        {
          label: "Notice period",
          value: user.noticePeriodStart
            ? `${formatPlainDate(user.noticePeriodStart)} – ${formatPlainDate(user.noticePeriodEnd)}`
            : `Ends ${formatPlainDate(user.noticePeriodEnd)}`,
          show: Boolean(user.noticePeriodStart || user.noticePeriodEnd),
        },
        {
          label: "Internship ends",
          value: formatPlainDate(user.internshipEndDate),
          show: Boolean(user.internshipEndDate),
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuBriefcaseBusiness aria-hidden className="size-4 text-muted-foreground" />
          Employment
        </CardTitle>
        <CardDescription>Managed by your administrator — contact them if anything is wrong.</CardDescription>
      </CardHeader>
      <CardContent>
        {profile.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Loading employment details">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        ) : profile.isError ? (
          <QueryError
            title="Couldn't load employment details"
            error={profile.error}
            onRetry={() => void profile.refetch()}
            retrying={profile.isRefetching}
          />
        ) : (
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {rows
              .filter((row) => row.show)
              .map((row) => (
                <div key={row.label} className="min-w-0">
                  <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {row.label}
                  </dt>
                  <dd className="mt-1 truncate text-sm text-foreground">{row.value}</dd>
                </div>
              ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
