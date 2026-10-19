import { useState } from "react";
import { Link } from "react-router";
import { LuTriangleAlert } from "react-icons/lu";
import { BrandFlowDialog } from "@/components/brands/brand-flow-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-auth";

/**
 * Shown where a new project would be made for a brand without a scope (project
 * form, "Continue in next month", Duplicate): new projects take their scope from
 * the brand, so the brand needs one first — or a new brand made with its scope.
 * Only brand creators (Nazeer) can start the New brand flow.
 */
export function BrandNoScopePanel({
  brand,
  onLeave,
  children,
}: {
  brand: { _id: string; name: string };
  /** Called before "Add scope" leaves for the brand page (close the dialog). */
  onLeave?: () => void;
  /** Extra line under the buttons (e.g. "It's a pitch?"). */
  children?: React.ReactNode;
}) {
  const { data: user } = useCurrentUser();
  const brandCreator = Boolean(user?.access?.brandCreator);
  const [flowOpen, setFlowOpen] = useState(false);
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <LuTriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        {brand.name} has no scope yet
      </p>
      <p className="text-muted-foreground">
        A new project takes its scope from its brand. Add the brand&apos;s scope first, or create a new brand with its scope.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/brands/${brand._id}`} onClick={() => onLeave?.()} className={buttonVariants({ size: "sm" })}>
          Add scope to {brand.name}
        </Link>
        {brandCreator ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setFlowOpen(true)}>
            Create new brand
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Ask Nazeer to create the brand.</span>
        )}
      </div>
      {children}
      {brandCreator && <BrandFlowDialog open={flowOpen} onOpenChange={setFlowOpen} />}
    </div>
  );
}
