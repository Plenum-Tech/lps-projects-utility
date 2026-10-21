import { firstName } from "@/lib/manpower";
import { cn } from "@/lib/utils";
import type { BrandPersonRef } from "@/types";

// ---------------------------------------------------------------------------
// A brand's three leads from the month's manpower plan (Program · Creative ·
// Production). Pearity reads the same ones (GET /api/integrations/pearity/v1/brands).
// A missing one shows "not set" in red — advice only, nothing is blocked.
// ---------------------------------------------------------------------------

/** Lead label → plan role key (the Production Lead is the plan's "producer" column). */
export const PLAN_LEADS = [
  { key: "programLead", label: "Program" },
  { key: "creativeLead", label: "Creative" },
  { key: "producer", label: "Production" },
] as const;

/** "Program: Ajmal · Creative: not set · Production: Sara"; `short`: first names only. */
export function PlanLeads({ roles, short, className }: { roles: Record<string, BrandPersonRef[]>; short?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs", className)}>
      {PLAN_LEADS.map((l, i) => {
        const people = roles[l.key] ?? [];
        return (
          <span key={l.key} className="whitespace-nowrap">
            {i > 0 && <span className="mr-2 text-muted-foreground" aria-hidden>·</span>}
            <span className="text-muted-foreground">{l.label}:</span>{" "}
            {people.length ? (
              <span className="font-medium" title={people.map((p) => p.name).join(", ")}>
                {people.map((p) => (short ? firstName(p.name) : p.name)).join(", ")}
              </span>
            ) : (
              <span className="font-medium text-red-700 dark:text-red-400">not set</span>
            )}
          </span>
        );
      })}
    </span>
  );
}
