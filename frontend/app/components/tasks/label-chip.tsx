import { LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { LabelColor } from "@/types";

/** Small tinted chip for a task label — colour comes from a theme token. */
export function LabelChip({
  name,
  color,
  className,
}: {
  name: string;
  color: LabelColor;
  className?: string;
}) {
  const meta = LABEL_COLOR_META[color] ?? LABEL_COLOR_META.primary;
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-40 items-center gap-1 rounded-full border px-2 text-[0.7rem] font-medium text-foreground",
        meta.chip,
        className
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Colour swatch used in pickers and lists. */
export function LabelColorDot({ color, className }: { color: LabelColor; className?: string }) {
  const meta = LABEL_COLOR_META[color] ?? LABEL_COLOR_META.primary;
  return <span aria-hidden className={cn("inline-block size-3 rounded-full", meta.dot, className)} />;
}
