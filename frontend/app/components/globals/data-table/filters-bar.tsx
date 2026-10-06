import { useEffect, useId, useState, type ReactNode } from "react";
import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { LuCalendarRange, LuChevronDown, LuFilterX, LuSlidersHorizontal, LuX } from "react-icons/lu";

import { weekStartsOn } from "@/lib/format";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDMY } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const ACTIVE_TRIGGER = "border-ring/60 bg-primary/5";

/**
 * Filter row: inline filters (children), search on the right, a "Filters"
 * button for the side sheet (with an active-count badge) and "Clear all".
 */
export function FiltersBar({
  children,
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  sheetCount,
  onOpenSheet,
  canClear,
  onClearAll,
  chips,
  className,
}: {
  children?: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  /** Active advanced filters — omit `onOpenSheet` to hide the button. */
  sheetCount?: number;
  onOpenSheet?: () => void;
  canClear: boolean;
  onClearAll: () => void;
  /** Removable chips for filters that aren't otherwise visible (e.g. "Copies of …"). */
  chips?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {children}
          {onOpenSheet && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSheet}
              className={cn(sheetCount ? ACTIVE_TRIGGER : undefined)}
              aria-label={sheetCount ? `More filters (${sheetCount} active)` : "More filters"}
            >
              <LuSlidersHorizontal aria-hidden />
              Filters
              {sheetCount ? (
                <span className="min-w-4 rounded-full bg-primary px-1 text-[0.65rem] leading-4 font-semibold text-primary-foreground tabular-nums">
                  {sheetCount}
                </span>
              ) : null}
            </Button>
          )}
          {canClear && (
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              <LuFilterX aria-hidden />
              Clear all
            </Button>
          )}
        </div>
        <DataTableSearch
          value={search}
          onValueChange={(value) => {
            if (value !== search) onSearchChange(value);
          }}
          placeholder={searchPlaceholder}
          className="lg:w-64"
        />
      </div>
      {chips && <div className="flex flex-wrap items-center gap-2">{chips}</div>}
    </div>
  );
}

/** Removable chip for a filter that has no inline control. */
export function FilterChip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full border border-ring/60 bg-primary/5 pr-1 pl-3 text-xs font-medium text-foreground">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove filter"
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LuX aria-hidden className="size-3" />
      </button>
    </span>
  );
}

const key = (date: Date) => format(date, "yyyy-MM-dd");

function presets(): { label: string; from: string; to: string }[] {
  const today = new Date();
  return [
    { label: "This week", from: key(startOfWeek(today, { weekStartsOn: weekStartsOn() })), to: key(endOfWeek(today, { weekStartsOn: weekStartsOn() })) },
    { label: "Next 7 days", from: key(today), to: key(addDays(today, 6)) },
    { label: "This month", from: key(startOfMonth(today)), to: key(endOfMonth(today)) },
    { label: "Last month", from: key(startOfMonth(subMonths(today, 1))), to: key(endOfMonth(subMonths(today, 1))) },
  ];
}

/** "Duration" — a from/to date range in a popover, with quick presets. */
export function DateRangeFilter({
  label = "Duration",
  from,
  to,
  onChange,
  description,
}: {
  label?: string;
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  /** Explains what the range matches (e.g. "Due date in range"). */
  description?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  useEffect(() => {
    if (open) {
      setDraftFrom(from);
      setDraftTo(to);
    }
  }, [open, from, to]);

  const active = Boolean(from || to);
  const invalid = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const summary = active
    ? from && to
      ? `${formatDMY(from)} → ${formatDMY(to)}`
      : from
        ? `From ${formatDMY(from)}`
        : `Until ${formatDMY(to)}`
    : "Any";

  function apply(range: { from: string; to: string }) {
    onChange(range);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn("max-w-full", active && ACTIVE_TRIGGER)}
            aria-label={`${label}: ${summary}`}
          />
        }
      >
        <LuCalendarRange aria-hidden />
        <span className="truncate">
          {label}: {summary}
        </span>
        <LuChevronDown aria-hidden className="text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">{label}</p>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {presets().map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => apply({ from: preset.from, to: preset.to })}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`} className="text-xs">
                From
              </Label>
              <Input
                id={`${id}-from`}
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(event) => setDraftFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`} className="text-xs">
                To
              </Label>
              <Input
                id={`${id}-to`}
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(event) => setDraftTo(event.target.value)}
                aria-invalid={invalid || undefined}
              />
            </div>
          </div>
          {invalid && <p className="text-xs text-destructive">“To” must be on or after “From”.</p>}
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => apply({ from: "", to: "" })}
              disabled={!active && !draftFrom && !draftTo}
            >
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={invalid}
              onClick={() => apply({ from: draftFrom, to: draftTo })}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Multi-select filter as a dropdown of checkboxes; value is a comma-joined list. */
export function MultiFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const selected = value ? value.split(",").filter(Boolean) : [];
  const summary =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? (options.find((option) => option.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  function toggle(option: string, checked: boolean) {
    const next = checked
      ? options.map((item) => item.value).filter((item) => item === option || selected.includes(item))
      : selected.filter((item) => item !== option);
    onChange(next.join(","));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(selected.length > 0 && ACTIVE_TRIGGER)}
            aria-label={`Filter by ${label.toLowerCase()}: ${summary}`}
          />
        }
      >
        {label}: {summary}
        <LuChevronDown aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={selected.includes(option.value)}
              onCheckedChange={(checked) => toggle(option.value, Boolean(checked))}
              closeOnClick={false}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange("")}>Clear</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
