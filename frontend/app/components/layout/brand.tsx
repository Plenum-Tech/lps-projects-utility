import { useState } from "react";
import { Building2 } from "lucide-react";

import { logoSrc, usePublicSettings } from "@/hooks/use-settings";
import { cn } from "@/lib/utils";

/**
 * Rounded brand mark — the company logo from Settings → Company when one is
 * uploaded, otherwise the EMS building icon. Used on the login page and in
 * the app sidebar.
 */
export function BrandMark({ className, src }: { className?: string; src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showLogo = Boolean(src) && failed !== src;
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary-foreground text-primary shadow-sm ring-1 ring-foreground/10",
        className
      )}
    >
      {showLogo ? (
        <img
          src={src as string}
          alt=""
          className="size-full object-contain p-1"
          onError={() => setFailed(src ?? null)}
        />
      ) : (
        <Building2 className="size-5" />
      )}
    </span>
  );
}

/** Company name + logo from the public settings ("EMS" until set). */
export function useBrand() {
  const { data } = usePublicSettings();
  return { name: data?.name || "EMS", logo: logoSrc(data) };
}

/** Brand mark + wordmark. Inherits text color from its parent. */
export function BrandHeader({ className }: { className?: string }) {
  const brand = useBrand();
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <BrandMark src={brand.logo} />
      <div className="min-w-0 leading-tight">
        <p className="truncate font-heading text-base font-semibold">{brand.name}</p>
        <p className="text-xs opacity-70">Employee Management System</p>
      </div>
    </div>
  );
}
