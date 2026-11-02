import { Navigate, useSearchParams } from "react-router";

import { BrandsAllocation, BrandsOverview, MonthPicker, NewBrandButton, thisMonth, useBrandsMonth } from "@/components/brands/brands-dashboard";
import { MonthMigrationButton } from "@/components/brands/month-migration-dialog";
import { PageHeader } from "@/components/globals/query-states";
import { ManpowerPage } from "@/components/manpower/manpower-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/brands";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Brands | LPS" }];
}

/**
 * Brands: the overview (scope, documents, plan, lead per brand), the Allocation grid
 * (brands × plan roles, editing the month's manpower plan) and, for heads and
 * admins, the Manpower plan — the same plan page as before (`?section=manpower`; the plan keeps its own `?tab=`).
 * The Pitch plan moved to its own page, Pitch & Growth (/pitches); old `?section=pitches` links redirect there.
 */
export default function Brands() {
  const { data: user } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(searchParams.get("month") ?? "") ? searchParams.get("month")! : thisMonth();
  const canSeePlan = user ? user.role !== "employee" : false;
  const wanted = searchParams.get("section");
  const tab = canSeePlan && (wanted === "manpower" || wanted === "allocation") ? wanted : "brands";
  const overview = useBrandsMonth(month);

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }
  if (wanted === "pitches") {
    const next = new URLSearchParams(searchParams);
    next.delete("section");
    next.delete("month");
    const query = next.toString();
    return <Navigate to={`/pitches${query ? `?${query}` : ""}`} replace />;
  }
  if (!user) return null;
  const shared = { month, data: overview.data, isPending: overview.isPending, error: overview.error, refetch: () => void overview.refetch() };

  return (
    <Tabs value={tab} onValueChange={(value) => setParam("section", String(value) === "brands" ? null : String(value))} className="w-full">
      <div className="px-4 pt-4 md:px-6">
        <TabsList>
          <TabsTrigger value="brands">Overview</TabsTrigger>
          {canSeePlan && <TabsTrigger value="allocation">Allocation</TabsTrigger>}
          {canSeePlan && <TabsTrigger value="manpower">Manpower plan</TabsTrigger>}
        </TabsList>
      </div>
      {tab !== "manpower" && (
        <div className="mx-auto w-full max-w-[96rem] px-4 pt-4 md:px-6">
          <PageHeader
            title="Brands"
            description="Scope, documents, team and lead per brand. New projects need a brand with a scope, a plan line and a lead."
            actions={
              <>
                <MonthPicker month={month} onChange={(m) => setParam("month", m === thisMonth() ? null : m)} />
                <MonthMigrationButton />
                <NewBrandButton />
              </>
            }
          />
        </div>
      )}
      <TabsContent value="brands">
        <div className="mx-auto w-full max-w-[96rem] p-4 md:p-6">
          <BrandsOverview {...shared} />
        </div>
      </TabsContent>
      {canSeePlan && (
        <TabsContent value="allocation">
          <div className="mx-auto w-full max-w-[96rem] p-4 md:p-6">
            <BrandsAllocation {...shared} />
          </div>
        </TabsContent>
      )}
      {canSeePlan && (
        <TabsContent value="manpower">
          <ManpowerPage />
        </TabsContent>
      )}
    </Tabs>
  );
}
