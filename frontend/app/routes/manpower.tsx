import { AccessDenied } from "@/components/globals/query-states";
import { ManpowerPage } from "@/components/manpower/manpower-page";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/manpower";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Manpower plan | LPS" }];
}

/** Heads and admins read the plan; admins edit it. */
export default function ManpowerRoute() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") {
    return (
      <AccessDenied
        title="Managers only"
        description="The manpower plan is available to department heads and administrators."
      />
    );
  }
  return <ManpowerPage role={user.role} />;
}
