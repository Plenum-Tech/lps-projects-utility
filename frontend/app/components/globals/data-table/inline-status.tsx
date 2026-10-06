import { useEffect, useState } from "react";
import { LuChevronDown, LuLoaderCircle } from "react-icons/lu";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface StatusOption {
  value: string;
  label: string;
  /** Theme-token background class for the dot, e.g. "bg-chart-2". */
  dot: string;
}

/**
 * Coloured dot + label that opens a menu of the statuses the caller may move
 * to. The change shows immediately and rolls back when `onChange` rejects
 * (the caller's mutation shows the error toast). Static when nothing is allowed.
 */
export function InlineStatus({
  value,
  options,
  allowed,
  onChange,
  loadingAllowed,
  onOpenChange,
  label = "Change status",
  className,
}: {
  value: string;
  options: StatusOption[];
  /** Target statuses (the current one is ignored); `undefined` while unknown. */
  allowed: string[] | undefined;
  onChange: (value: string) => Promise<unknown>;
  /** Permissions are still loading (shown inside the open menu). */
  loadingAllowed?: boolean;
  /** Lets the caller lazy-load permissions when the menu opens. */
  onOpenChange?: (open: boolean) => void;
  label?: string;
  className?: string;
}) {
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The server value caught up (or changed elsewhere) — drop the optimistic one.
  useEffect(() => {
    setOptimistic(null);
  }, [value]);

  const shown = optimistic ?? value;
  const current = options.find((option) => option.value === shown) ?? {
    value: shown,
    label: shown,
    dot: "bg-muted-foreground",
  };
  const targets = options.filter(
    (option) => option.value !== shown && (allowed ?? []).includes(option.value)
  );
  const interactive = loadingAllowed || allowed === undefined || targets.length > 0;

  const pill = (
    <>
      {saving ? (
        <LuLoaderCircle aria-hidden className="size-3 animate-spin text-muted-foreground" />
      ) : (
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", current.dot)} />
      )}
      <span className="truncate">{current.label}</span>
    </>
  );

  if (!interactive) {
    return (
      <span
        className={cn(
          "inline-flex h-7 max-w-44 items-center gap-1.5 px-1 text-xs font-medium text-foreground",
          className
        )}
      >
        {pill}
      </span>
    );
  }

  async function select(next: string) {
    setOptimistic(next);
    setSaving(true);
    try {
      await onChange(next);
    } catch {
      setOptimistic(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <DropdownMenu onOpenChange={(open) => onOpenChange?.(open)}>
      <DropdownMenuTrigger
        disabled={saving}
        aria-label={`${label}: ${current.label}`}
        className={cn(
          "inline-flex h-7 max-w-44 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out outline-none hover:border-border hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:border-border aria-expanded:bg-muted/60 disabled:opacity-70",
          className
        )}
      >
        {pill}
        <LuChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Move to</DropdownMenuLabel>
          {loadingAllowed && targets.length === 0 ? (
            <div className="flex items-center gap-2 px-1.5 py-1.5 text-xs text-muted-foreground">
              <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" />
              Checking what you can do…
            </div>
          ) : targets.length === 0 ? (
            <p className="px-1.5 py-1.5 text-xs text-muted-foreground">
              No status changes available to you.
            </p>
          ) : (
            targets.map((option) => (
              <DropdownMenuItem key={option.value} onClick={() => void select(option.value)}>
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", option.dot)} />
                {option.label}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
