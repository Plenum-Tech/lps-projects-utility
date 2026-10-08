import { useCallback, useEffect, useState } from "react";
import { LuColumns3 } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface OptionalColumn {
  id: string;
  label: string;
}

function storageKey(table: string, userId: string): string {
  return `ems.table.${table}.columns.${userId}`;
}

function read(table: string, userId: string): string[] | null {
  try {
    const raw = window.localStorage.getItem(storageKey(table, userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Optional (hidden by default) columns the viewer turned on, remembered per
 * user and table in localStorage.
 */
export function useColumnVisibility(table: string, userId: string, defaults: string[] = []) {
  const [visible, setVisible] = useState<string[]>(defaults);

  useEffect(() => {
    setVisible(read(table, userId) ?? defaults);
    // `defaults` is a literal per call site; only re-read when the table or user changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, userId]);

  const toggle = useCallback(
    (id: string, on: boolean) => {
      setVisible((current) => {
        const next = on ? [...new Set([...current, id])] : current.filter((c) => c !== id);
        try {
          window.localStorage.setItem(storageKey(table, userId), JSON.stringify(next));
        } catch {
          // Storage unavailable (private mode): the choice lasts for this page only.
        }
        return next;
      });
    },
    [table, userId]
  );

  return { visible, isVisible: (id: string) => visible.includes(id), toggle };
}

/** "Columns" menu: checkboxes for the optional columns. */
export function ColumnVisibilityMenu({
  columns,
  isVisible,
  onToggle,
}: {
  columns: OptionalColumn[];
  isVisible: (id: string) => boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Show or hide columns" title="Columns" />}
      >
        <LuColumns3 aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Optional columns</DropdownMenuLabel>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={isVisible(column.id)}
              onCheckedChange={(checked) => onToggle(column.id, Boolean(checked))}
              closeOnClick={false}
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
