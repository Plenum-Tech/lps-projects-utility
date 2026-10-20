import { useState } from "react";
import { Link } from "react-router";
import { LuTriangleAlert } from "react-icons/lu";
import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-auth";
import { readinessReasonText, type BrandNotReadyReason } from "@/hooks/use-brands";

/**
 * Shown where a new project would be made for a brand that isn't ready (project form,
 * "Continue in next month", Duplicate). A new project needs a brand with a scope (it
 * takes its scope from the brand), a line in the current month's manpower plan and a
 * lead. The panel links to what fixes each reason: the brand page (scope, lead),
 * Brands → Allocation (plan line), or a new brand made with its scope. Only brand
 * creators (Nazeer) can start the New brand flow.
 */
export function BrandNoScopePanel({
  brand,
  reasons = ["no_scope"],
  month,
  onLeave,
  children,
}: {
  brand: { _id: string; name: string };
  /** Why the brand isn't ready (default: no scope). */
  reasons?: BrandNotReadyReason[];
  /** The plan's month ("YYYY-MM") for the "not in October's plan" reason. */
  month?: string;
  /** Called before a link leaves for another page (close the dialog). */
  onLeave?: () => void;
  /** Extra line under the buttons (e.g. "It's a pitch?"). */
  children?: React.ReactNode;
}) {
  const { data: user } = useCurrentUser();
  const brandCreator = Boolean(user?.access?.brandCreator);
  const canSeePlan = user ? user.role !== "employee" : false;
  const [flowOpen, setFlowOpen] = useState(false);
  const planMonth = month ?? new Date().toISOString().slice(0, 7);
  const noScope = reasons.includes("no_scope");
  const notInPlan = reasons.includes("not_in_plan");
  const noLead = reasons.includes("no_lead");
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <LuTriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        {reasons.length === 1 && noScope
          ? `${brand.name} has no scope yet`
          : `${brand.name} isn't ready for new projects: ${reasons.map((r) => readinessReasonText(r, planMonth)).join(", ")}`}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {noScope && <li>A new project takes its scope from its brand. Add the brand&apos;s scope first, or create a new brand with its scope.</li>}
        {notInPlan && <li>The brand needs a line in this month&apos;s approved manpower plan (Brands → Allocation).</li>}
        {noLead && <li>The brand needs a lead (set on the brand page).</li>}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {noScope && (
          <Link to={`/brands/${brand._id}#scope`} onClick={() => onLeave?.()} className={buttonVariants({ size: "sm" })}>
            Add scope to {brand.name}
          </Link>
        )}
        {notInPlan &&
          (canSeePlan ? (
            <Link to={`/brands?section=allocation&month=${planMonth}`} onClick={() => onLeave?.()} className={buttonVariants({ size: "sm", variant: noScope ? "outline" : "default" })}>
              Add to the plan (Allocation)
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">Ask your head to add it to the plan.</span>
          ))}
        {noLead && (
          <Link to={`/brands/${brand._id}`} onClick={() => onLeave?.()} className={buttonVariants({ size: "sm", variant: noScope || notInPlan ? "outline" : "default" })}>
            Set a lead for {brand.name}
          </Link>
        )}
        {noScope &&
          (brandCreator ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setFlowOpen(true)}>
              Create new brand
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Ask Nazeer or leadership to create the brand.</span>
          ))}
        {!noScope && !brandCreator && noLead && <span className="text-xs text-muted-foreground">Or ask Nazeer to set the lead.</span>}
      </div>
      {children}
      {brandCreator && <BrandFlowDialog open={flowOpen} onOpenChange={setFlowOpen} />}
    </div>
  );
}
