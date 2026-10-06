import { useMemo } from "react";

import { UserAvatar } from "@/components/tasks/task-badges";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import type { UserRef } from "@/types";

const NONE = "__none";

interface PickerOption {
  value: string;
  label: string;
  email: string;
}

/**
 * Searchable single-user picker with an explicit "none" option ("Unassigned",
 * "Not in EMS" …). `extra` keeps a current value selectable when it isn't in
 * `users` (e.g. a former project member).
 */
export function UserPicker({
  id,
  users,
  value,
  onChange,
  noneLabel = "Unassigned",
  placeholder,
  extra,
  disabled,
  loading,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  users: UserRef[];
  value: string | null;
  onChange: (value: string | null) => void;
  noneLabel?: string;
  placeholder?: string;
  extra?: (UserRef | null | undefined)[];
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const options = useMemo<PickerOption[]>(() => {
    const out: PickerOption[] = [{ value: NONE, label: noneLabel, email: "" }];
    const seen = new Set<string>();
    for (const user of [...(extra ?? []), ...users]) {
      if (!user || seen.has(user._id)) continue;
      seen.add(user._id);
      out.push({ value: user._id, label: user.name, email: user.email });
    }
    return out;
  }, [users, extra, noneLabel]);

  const selected = options.find((option) => option.value === (value ?? NONE)) ?? options[0];

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(item: PickerOption | null) =>
        onChange(!item || item.value === NONE ? null : item.value)
      }
      isItemEqualToValue={(item: PickerOption, current: PickerOption) => item.value === current.value}
      itemToStringLabel={(item: PickerOption) => (item.value === NONE ? "" : item.label)}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        aria-label={ariaLabel}
        placeholder={loading ? "Loading people…" : (placeholder ?? `${noneLabel} — search people…`)}
        className={cn("w-full", className)}
        disabled={disabled}
      />
      <ComboboxContent sideOffset={4}>
        <ComboboxEmpty>No one matches.</ComboboxEmpty>
        <ComboboxList>
          {(option: PickerOption) => (
            <ComboboxItem key={option.value} value={option}>
              {option.value === NONE ? (
                <span className="text-muted-foreground">{option.label}</span>
              ) : (
                <>
                  <UserAvatar user={{ name: option.label }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{option.label}</span>
                    <span className="truncate text-xs text-muted-foreground">{option.email}</span>
                  </span>
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
