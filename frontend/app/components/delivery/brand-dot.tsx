import { LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { LabelColor } from "@/types";

/** Theme-token classes for a brand colour (unknown → muted). */
export function brandColorMeta(color: string | null | undefined) {
  return LABEL_COLOR_META[(color ?? "muted") as LabelColor] ?? LABEL_COLOR_META.muted;
}

/** Small colour dot for a brand. */
export function BrandDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", brandColorMeta(color).dot, className)} />
  );
}

/** Dot + name; muted italic for "No brand"; "(inactive)" suffix for deactivated brands. */
export function BrandName({
  name,
  color,
  noBrand,
  active = true,
  className,
}: {
  name: string;
  color: string | null | undefined;
  noBrand?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <BrandDot color={noBrand ? "muted" : color} />
      <span className={cn("truncate", noBrand && "text-muted-foreground italic")}>{name}</span>
      {!active && !noBrand && <span className="shrink-0 text-xs text-muted-foreground">(inactive)</span>}
    </span>
  );
}
