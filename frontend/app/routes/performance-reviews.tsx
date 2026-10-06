import { ModuleTabsPage } from "@/components/layout/module-tabs-page";
import { MyReviewsView } from "@/components/performance-reviews/my-reviews-view";
import { TeamReviewsView } from "@/components/performance-reviews/team-reviews-view";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/performance-reviews";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Performance Reviews | LPS" }];
}

/**
 * HR → Performance Reviews. Employees see the reviews sent to them; heads and
 * admins also get the team view where reviews are written and sent
 * (`?tab=team`, the old /admin/performance-reviews).
 */
export default function PerformanceReviewsPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") return <MyReviewsView />;

  return (
    <ModuleTabsPage
      title="Performance Reviews"
      description="Write and send reviews for your team, and read the ones sent to you."
      defaultTab="mine"
      tabs={[
        { value: "team", label: "Team reviews", content: <TeamReviewsView embedded /> },
        { value: "mine", label: "My reviews", content: <MyReviewsView embedded /> },
      ]}
    />
  );
}
