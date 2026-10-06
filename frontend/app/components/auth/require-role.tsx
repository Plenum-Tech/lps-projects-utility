import type { ReactNode } from "react";

import { AccessDenied } from "@/components/globals/query-states";
import { useCurrentUser } from "@/hooks/use-auth";
import type { Role } from "@/types";

/**
 * Role gate for pages: renders `children` only for the given roles, otherwise
 * the shared "Admins only" empty state (before any page queries run).
 * `RequireAuth` has already loaded the user higher up.
 */
export function RequireRole({
  roles,
  title = "Admins only",
  description = "This page is only available to administrators.",
  children,
}: {
  roles: readonly Role[];
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (!roles.includes(user.role)) return <AccessDenied title={title} description={description} />;
  return <>{children}</>;
}

/**
 * Route `handle` read by the admin layout: which roles may open the page
 * (default admins only) and an optional message for everyone else.
 */
export interface RoleHandle {
  roles?: readonly Role[];
  deniedTitle?: string;
  deniedDescription?: string;
}
