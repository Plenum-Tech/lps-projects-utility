import { LuLock } from "react-icons/lu";

import { EmptyState } from "@/components/globals/query-states";
import { ScopeCreepReport } from "@/components/reports/scope-creep-report";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.scope-creep";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Scope Creep | LPS" }];
}

/** Scope creep per brand per month — leadership only (the API answers 403 to everyone else). */
export default function ScopeCreepRoute() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (!user.leadership) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState icon={LuLock} title="Scope creep is for leadership" description="Ask leadership if you need this report." />
      </div>
    );
  }
  return <ScopeCreepReport />;
}
