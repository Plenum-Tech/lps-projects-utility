import type { RoleHandle } from "@/components/auth/require-role";
import { RedirectTo } from "@/components/layout/redirect-to";

/** Heads may open this too (the API allows admin + head); see routes/admin/layout.tsx. */
export const handle: RoleHandle = {
  roles: ["admin", "head"],
  deniedTitle: "Admins and department heads only",
  deniedDescription: "Performance reviews are managed by administrators and department heads.",
};

/** Moved: the review manager is the "Team reviews" tab of /performance-reviews. Kept for old links. */
export default function AdminPerformanceReviewsRedirect() {
  return <RedirectTo to="/performance-reviews" search={{ tab: "team" }} />;
}
