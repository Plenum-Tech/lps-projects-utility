import { useState, type ReactNode } from "react";

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Secondary text shown in the dropdown (e.g. email). */
  description?: string;
  /** Optional leading visual (e.g. a colour dot). */
  icon?: ReactNode;
}

/**
 * Searchable multi-select with removable chips (Base UI combobox). Values are
 * plain ids; options carry the labels.
 */
export function MultiSelect({
  id,
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  emptyText = "No matches.",
  disabled,
  invalid,
  max,
  "aria-describedby": describedBy,
}: {
  id?: string;
  options: MultiSelectOption[];
  value: string[];
  onValueChange: (value: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  max?: number;
  "aria-describedby"?: string;
}) {
  const anchor = useComboboxAnchor();
  // The list closes once something is picked (click the box again to add more).
  const [open, setOpen] = useState(false);
  const selected = value
    .map((id) => options.find((option) => option.value === id))
    .filter((option): option is MultiSelectOption => Boolean(option));

  return (
    <Combobox
      multiple
      autoHighlight
      // Clicking the box lists everyone (typing narrows it).
      openOnInputClick
      open={open}
      onOpenChange={setOpen}
      items={options}
      value={selected}
      onValueChange={(next: MultiSelectOption[]) => {
        const ids = next.map((option) => option.value);
        if (ids.length > value.length) setOpen(false);
        onValueChange(max ? ids.slice(0, max) : ids);
      }}
      isItemEqualToValue={(item: MultiSelectOption, current: MultiSelectOption) =>
        item.value === current.value
      }
      disabled={disabled}
    >
      <ComboboxChips ref={anchor} className="w-full">
        <ComboboxValue>
          {(values: MultiSelectOption[]) => (
            <>
              {values.map((option) => (
                <ComboboxChip key={option.value}>
                  {option.icon}
                  {option.label}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                id={id}
                placeholder={values.length === 0 ? placeholder : ""}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(option: MultiSelectOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.icon}
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
