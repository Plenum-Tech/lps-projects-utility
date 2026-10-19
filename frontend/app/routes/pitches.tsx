import { useSearchParams } from "react-router";

import { isQuarter, PitchPlan, thisQuarter } from "@/components/brands/pitch-plan";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/pitches";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Pitch & Growth | LPS" }];
}

/**
 * Pitch & Growth Tracker (`/pitches?quarter=2026-Q4`, everyone): pitches by month with
 * automatic status, edited in place. Admins also import the pitch sheet here.
 * Formerly Brands → Pitch plan (`/brands?section=pitches` redirects here).
 */
export default function Pitches() {
  const { data: user } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const quarter = isQuarter(searchParams.get("quarter")) ? searchParams.get("quarter")! : thisQuarter();
  if (!user) return null;
  return (
    <PitchPlan
      quarter={quarter}
      canImport={user.role === "admin"}
      onQuarterChange={(q) =>
        setSearchParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (q === thisQuarter()) next.delete("quarter");
            else next.set("quarter", q);
            return next;
          },
          { replace: true },
        )
      }
    />
  );
}
