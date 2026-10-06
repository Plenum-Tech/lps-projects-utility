import { ManageFeedbackView } from "@/components/feedback/manage-feedback-view";
import { MyFeedbackView } from "@/components/feedback/my-feedback-view";
import { ModuleTabsPage } from "@/components/layout/module-tabs-page";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/feedback";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Feedback | LPS" }];
}

/**
 * HR → Feedback. Everyone can submit and follow their own feedback; admins
 * also get the inbox of all feedback (`?tab=all`, the old /admin/feedback).
 */
export default function FeedbackPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role !== "admin") return <MyFeedbackView />;

  return (
    <ModuleTabsPage
      title="Feedback"
      description="Respond to feedback from employees, and share your own."
      defaultTab="mine"
      tabs={[
        { value: "all", label: "All feedback", content: <ManageFeedbackView embedded /> },
        { value: "mine", label: "My feedback", content: <MyFeedbackView embedded /> },
      ]}
    />
  );
}
