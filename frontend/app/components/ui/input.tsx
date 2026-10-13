import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/** Date / time inputs: clicking anywhere opens the browser's picker. */
const PICKER_TYPES = new Set(["date", "datetime-local", "month", "time", "week"])

function Input({ className, type, onClick, ...props }: React.ComponentProps<"input">) {
  const isPicker = type !== undefined && PICKER_TYPES.has(type)
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      onClick={(event: React.MouseEvent<HTMLInputElement>) => {
        onClick?.(event)
        if (!isPicker || event.defaultPrevented || props.disabled || props.readOnly) return
        // Some browsers (e.g. Chrome on macOS) show the calendar icon faintly or
        // only on hover — open the picker on any click in the field.
        try {
          event.currentTarget.showPicker?.()
        } catch {
          // showPicker can throw outside a user gesture / in iframes: ignore
        }
      }}
      className={cn(
        isPicker &&
          "cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-70 hover:[&::-webkit-calendar-picker-indicator]:opacity-100 dark:[&::-webkit-calendar-picker-indicator]:invert",
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
