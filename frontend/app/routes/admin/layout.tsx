import { Outlet, useMatches } from "react-router";

import { RequireRole, type RoleHandle } from "@/components/auth/require-role";
import type { Role } from "@/types";

const ADMIN_ONLY: readonly Role[] = ["admin"];

/**
 * Pathless layout around every /admin/* page: admins only, unless the page's
 * `handle` (RoleHandle) widens it — e.g. performance reviews / AI insights,
 * which department heads may use too (mirrors the API's role guards).
 */
export default function AdminLayout() {
  const matches = useMatches();
  const handle = [...matches]
    .reverse()
    .map((match) => match.handle as RoleHandle | undefined)
    .find((h) => h?.roles);

  return (
    <RequireRole
      roles={handle?.roles ?? ADMIN_ONLY}
      title={handle?.deniedTitle}
      description={handle?.deniedDescription}
    >
      <Outlet />
    </RequireRole>
  );
}
