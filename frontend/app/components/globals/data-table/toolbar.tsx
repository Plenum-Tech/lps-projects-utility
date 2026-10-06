import type { ReactNode } from "react";
import type { IconType } from "react-icons";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Toolbar row above a data table: primary + secondary actions on the left,
 * a view toggle (or anything else) on the right.
 */
export function DataTableToolbar({
  actions,
  end,
  className,
}: {
  actions?: ReactNode;
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
      {end && <div className="flex flex-wrap items-center gap-2">{end}</div>}
    </div>
  );
}

export interface ViewOption<V extends string> {
  value: V;
  label: string;
  icon: IconType;
  /** Small count badge (e.g. tasks waiting for approval). */
  badge?: number;
}

/**
 * Segmented icon buttons with tooltips (List · Board · Calendar …). A radio
 * group for assistive tech; arrow keys move between views.
 */
export function ViewToggle<V extends string>({
  value,
  onChange,
  options,
  label = "View",
}: {
  value: V;
  onChange: (value: V) => void;
  options: ViewOption<V>[];
  label?: string;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    let next = index;
    if (event.key === "ArrowLeft") next = (index - 1 + options.length) % options.length;
    if (event.key === "ArrowRight") next = (index + 1) % options.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = options.length - 1;
    onChange(options[next].value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex items-center rounded-lg border bg-background p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={
                    option.badge ? `${option.label} (${option.badge})` : option.label
                  }
                  tabIndex={active ? 0 : -1}
                  onClick={() => onChange(option.value)}
                  className={cn(
                    "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 ease-out outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                    active && "bg-primary/10 text-primary hover:text-primary"
                  )}
                />
              }
            >
              <Icon aria-hidden className="size-4" />
              {option.badge ? (
                <span className="min-w-4 rounded-full bg-primary px-1 text-[0.65rem] leading-4 font-semibold text-primary-foreground tabular-nums">
                  {option.badge > 99 ? "99+" : option.badge}
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipContent>{option.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
