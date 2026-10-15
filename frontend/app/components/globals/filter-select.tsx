import { useMemo } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ANY = "all";

interface FilterOption {
  value: string;
  label: string;
}

/**
 * Compact "Label: Value" filter select. `""` means "any". Used by the task
 * toolbar, projects, time logs and the work reports. `searchable` adds a search
 * box above the options (long lists such as people).
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  className,
  searchable,
  searchPlaceholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  /** Text for the "any" option (defaults to "Any <label>"). */
  anyLabel?: string;
  className?: string;
  /** Type to narrow the options (Base UI combobox with the input in the popup). */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  if (searchable) {
    return (
      <SearchableFilterSelect
        label={label}
        value={value}
        onChange={onChange}
        options={options}
        anyLabel={anyLabel}
        className={className}
        searchPlaceholder={searchPlaceholder}
      />
    );
  }

  const items: Record<string, string> = { [ANY]: `${label}: Any` };
  for (const option of options) items[option.value] = `${label}: ${option.label}`;
  const current = value === "" || value === "all" ? ANY : value;

  return (
    <Select
      value={current}
      onValueChange={(next) => onChange(!next || next === ANY ? "" : String(next))}
      items={items}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={[current !== ANY ? "border-ring/60 bg-primary/5" : "", className ?? ""]
          .join(" ")
          .trim()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{anyLabel ?? `Any ${label.toLowerCase()}`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Same trigger look as the small SelectTrigger, so both kinds sit together in a toolbar. */
const TRIGGER_CLASS =
  "flex h-7 w-fit min-w-0 items-center justify-between gap-1.5 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50";

function SearchableFilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  className,
  searchPlaceholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  anyLabel?: string;
  className?: string;
  searchPlaceholder?: string;
}) {
  const items = useMemo<FilterOption[]>(
    () => [{ value: ANY, label: anyLabel ?? `Any ${label.toLowerCase()}` }, ...options],
    [options, anyLabel, label]
  );
  const current = value === "" || value === ANY ? ANY : value;
  const selected = items.find((option) => option.value === current) ?? items[0]!;
  const active = current !== ANY;

  return (
    <Combobox
      items={items}
      value={selected}
      onValueChange={(item: FilterOption | null) => onChange(!item || item.value === ANY ? "" : item.value)}
      isItemEqualToValue={(item: FilterOption, other: FilterOption) => item.value === other.value}
      itemToStringLabel={(item: FilterOption) => item.label}
      autoHighlight
    >
      <ComboboxTrigger
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={cn(TRIGGER_CLASS, active && "border-ring/60 bg-primary/5", className)}
      >
        <span className="truncate">
          {label}: {active ? selected.label : "Any"}
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="min-w-60">
        <ComboboxInput
          showTrigger={false}
          placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
          aria-label={`Search ${label.toLowerCase()}`}
        />
        <ComboboxEmpty>No matches.</ComboboxEmpty>
        <ComboboxList>
          {(option: FilterOption) => (
            <ComboboxItem key={option.value} value={option}>
              <span className={cn("truncate", option.value === ANY && "text-muted-foreground")}>
                {option.label}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
