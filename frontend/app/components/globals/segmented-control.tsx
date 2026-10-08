import type { KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Short visible label ("30d"). */
  label: string;
  /** Full name for the tooltip and screen readers ("Last 30 days"). */
  title: string;
}

/**
 * Segmented control (radiogroup) — the Delivery Pulse / My dashboard period
 * picker. Arrow keys move the choice; only the selected segment is tabbable.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  label: string;
  className?: string;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === value);
    const next = (index + delta + options.length) % options.length;
    onChange(options[next].value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex h-8 items-center rounded-lg bg-muted p-0.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs font-medium tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
            <span className="sr-only">: {option.title}</span>
          </button>
        );
      })}
    </div>
  );
}
