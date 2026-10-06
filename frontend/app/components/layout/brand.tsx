import { useState } from "react";

import { logoSrc, usePublicSettings } from "@/hooks/use-settings";
import {
  customCompanyName,
  DEFAULT_LOGO_SRC,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  PRODUCT_TAGLINE,
} from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Crisp vector "LPS" wordmark tile (dark mark, green accent) drawn from theme
 * tokens. Used where the raster logo would blur — the collapsed sidebar and
 * as a fallback when an image fails to load.
 */
export function LpsMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn("size-10 shrink-0 rounded-[25%] ring-1 ring-foreground/10", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect width="40" height="40" rx="10" className="fill-brand" />
      <path d="M26 5h8l-4.5 6.5h-8z" className="fill-brand-accent" />
      <text
        x="20"
        y="27"
        textAnchor="middle"
        fontSize="13"
        fontWeight="800"
        letterSpacing="-0.4"
        fontFamily="inherit"
        className="fill-brand-foreground"
      >
        {PRODUCT_SHORT_NAME}
      </text>
    </svg>
  );
}

/**
 * Square brand mark — the company logo from Settings → Company when one is
 * uploaded, otherwise the vector LPS mark.
 */
export function BrandMark({ className, src }: { className?: string; src?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <LpsMark className={className} />;
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-surface shadow-sm ring-1 ring-foreground/10",
        className
      )}
    >
      <img
        src={src}
        alt=""
        className="size-full object-contain p-1"
        onError={() => setFailed(src)}
      />
    </span>
  );
}

/**
 * Wide logo on a light plate: the uploaded company logo, otherwise the default
 * LPS logo (mark + letters). Falls back to the vector mark if the image fails.
 */
export function BrandLogo({ className, src }: { className?: string; src?: string | null }) {
  const image = src || DEFAULT_LOGO_SRC;
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === image) return <LpsMark className={cn("size-10", className)} />;
  return (
    <span
      className={cn(
        "inline-flex h-10 w-fit max-w-full shrink-0 items-center rounded-lg bg-brand-surface px-2 py-1 shadow-sm ring-1 ring-foreground/10",
        className
      )}
    >
      <img
        src={image}
        alt=""
        className="h-full w-auto max-w-40 object-contain"
        onError={() => setFailed(image)}
      />
    </span>
  );
}

/**
 * Brand from the public settings: `company` is the admin-set company name
 * (null until set), `logo` the uploaded logo (null → default LPS logo).
 */
export function useBrand() {
  const { data } = usePublicSettings();
  const company = customCompanyName(data?.name);
  return { name: company ?? PRODUCT_NAME, company, logo: logoSrc(data) };
}

/** Logo + "Projects Utility" + company subtitle. Inherits text color from its parent. */
export function BrandHeader({ className }: { className?: string }) {
  const brand = useBrand();
  return (
    <div className={cn("flex flex-col items-start gap-3", className)}>
      <BrandLogo src={brand.logo} className="h-11" />
      <div className="min-w-0 leading-tight">
        <p className="font-heading text-base font-semibold">
          <span className="sr-only">{PRODUCT_SHORT_NAME} – </span>
          {PRODUCT_TAGLINE}
        </p>
        {brand.company && <p className="truncate text-xs opacity-70">{brand.company}</p>}
      </div>
    </div>
  );
}
