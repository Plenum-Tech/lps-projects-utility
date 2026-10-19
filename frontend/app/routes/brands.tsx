import { useSearchParams } from "react-router";

import { BrandsSection } from "@/components/delivery/settings/brands-section";
import { ManpowerPage } from "@/components/manpower/manpower-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/brands";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Brands | LPS" }];
}

/**
 * Brands: the brand list (New brand, scope, leads) and, for heads and admins, the
 * Manpower plan — the same plan as before, now under Brands (`?tab=manpower`).
 */
export default function Brands() {
  const { data: user } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  if (!user) return null;
  const canSeePlan = user.role !== "employee";
  const tab = canSeePlan && searchParams.get("tab") === "manpower" ? "manpower" : "brands";

  function select(value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === "brands") next.delete("tab");
        else next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <Tabs value={tab} onValueChange={(value) => select(String(value))} className="w-full">
      <div className="px-4 pt-4 md:px-6">
        <TabsList>
          <TabsTrigger value="brands">Brands</TabsTrigger>
          {canSeePlan && <TabsTrigger value="manpower">Manpower plan</TabsTrigger>}
        </TabsList>
      </div>
      <TabsContent value="brands">
        <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
          <BrandsSection />
        </div>
      </TabsContent>
      {canSeePlan && (
        <TabsContent value="manpower">
          <ManpowerPage />
        </TabsContent>
      )}
    </Tabs>
  );
}
