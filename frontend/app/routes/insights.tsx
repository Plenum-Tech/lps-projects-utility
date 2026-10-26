import { LuLock } from "react-icons/lu";

import { EmptyState } from "@/components/globals/query-states";
import { InsightsWorkspace } from "@/components/insights/workspace";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/insights";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Insights | LPS" }];
}

/** Leadership Insights (`/insights?board=<id>`) — leadership only (the API answers 403 to everyone else). */
export default function InsightsRoute() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (!user.leadership) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState icon={LuLock} title="Insights are for leadership" description="Ask leadership if you need a report from here." />
      </div>
    );
  }
  return <InsightsWorkspace />;
}
