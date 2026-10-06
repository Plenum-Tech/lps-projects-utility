import { Fragment } from "react";
import type { IconType } from "react-icons";
import { LuEllipsisVertical, LuLoaderCircle } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RowAction {
  label: string;
  icon: IconType;
  onSelect: () => void;
  variant?: "default" | "destructive";
  disabled?: boolean;
  /** Starts a new group (separator above). */
  separated?: boolean;
}

/**
 * The row ⋮ menu. `onOpenChange` lets callers lazy-load permissions; while
 * `loading`, a spinner row is shown under the items already known.
 */
export function RowActions({
  label,
  actions,
  loading,
  onOpenChange,
}: {
  /** e.g. "Actions for PEAR-12". */
  label: string;
  actions: RowAction[];
  loading?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => onOpenChange?.(open)}>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} />}
      >
        <LuEllipsisVertical aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-44">
        <DropdownMenuGroup>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Fragment key={action.label}>
                {action.separated && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant={action.variant}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                >
                  <Icon aria-hidden />
                  {action.label}
                </DropdownMenuItem>
              </Fragment>
            );
          })}
          {loading && (
            <div className="flex items-center gap-2 px-1.5 py-1.5 text-xs text-muted-foreground">
              <LuLoaderCircle aria-hidden className="size-3.5 animate-spin" />
              Checking permissions…
            </div>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
