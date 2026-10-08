import { ModuleTabsPage } from "@/components/layout/module-tabs-page";
import { ManageTrainings } from "@/components/training/manage-trainings";
import { MyTrainings } from "@/components/training/my-trainings";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/training";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Training | LPS" }];
}

/**
 * HR → Training (`?tab=` mine | manage).
 * - Everyone: the trainings assigned to them.
 * - Admins: also Manage (upload decks, assign, track completion).
 */
export default function TrainingPage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;

  const tabs = [
    { value: "mine", label: "My trainings", content: <MyTrainings /> },
  ];
  if (user.role === "admin") {
    tabs.push({
      value: "manage",
      label: "Manage",
      content: <ManageTrainings />,
    });
  }

  return (
    <ModuleTabsPage
      title="Training"
      description="Read the slide decks assigned to you and confirm when you've completed them."
      defaultTab="mine"
      tabs={tabs}
    />
  );
}
