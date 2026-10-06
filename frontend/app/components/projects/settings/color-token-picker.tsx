import { LabelColorDot } from "@/components/tasks/label-chip";
import { LABEL_COLORS, LABEL_COLOR_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ColorToken } from "@/types";

/** Radio group of theme-token swatches (arrow keys move the selection). */
export function ColorTokenPicker({
  value,
  onChange,
  label = "Colour",
  disabled,
}: {
  value: ColorToken;
  onChange: (color: ColorToken) => void;
  label?: string;
  disabled?: boolean;
}) {
  function move(container: HTMLElement, delta: number) {
    const index = LABEL_COLORS.indexOf(value);
    const nextIndex = (index + delta + LABEL_COLORS.length) % LABEL_COLORS.length;
    onChange(LABEL_COLORS[nextIndex]);
    container.querySelectorAll<HTMLButtonElement>("button[role=radio]")[nextIndex]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(event.currentTarget, 1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(event.currentTarget, -1);
        }
      }}
    >
      {LABEL_COLORS.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={LABEL_COLOR_META[color].name}
            title={LABEL_COLOR_META[color].name}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(color)}
            className={cn(
              "flex size-7 items-center justify-center rounded-full border transition-shadow duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
              selected ? "border-ring ring-2 ring-ring/40" : "border-border hover:border-ring/50"
            )}
          >
            <LabelColorDot color={color} className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
