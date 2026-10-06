import { useRef, useState, type KeyboardEvent } from "react";
import { LuStar } from "react-icons/lu";

import { cn } from "@/lib/utils";
import { SCORE_LABELS } from "./review-meta";

const MAX = 5;

/** Read-only star row. Announced as "n out of 5". */
export function StarRating({
  score,
  className,
  size = "md",
}: {
  score: number;
  className?: string;
  size?: "sm" | "md";
}) {
  const rounded = Math.round(score);
  return (
    <span
      role="img"
      aria-label={`${score} out of ${MAX}`}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {Array.from({ length: MAX }).map((_, i) => (
        <LuStar
          key={i}
          aria-hidden
          className={cn(
            size === "sm" ? "size-3.5" : "size-4",
            i < rounded
              ? "fill-primary text-primary"
              : "fill-transparent text-muted-foreground/40"
          )}
        />
      ))}
    </span>
  );
}

/**
 * Accessible 1–5 star picker with radio-group semantics: one tab stop,
 * Arrow keys move the selection, Home/End jump to 1/5, Space/Enter select.
 */
export function StarRatingInput({
  value,
  onChange,
  label,
  invalid,
  describedBy,
  disabled,
}: {
  /** 0 = not rated yet. */
  value: number;
  onChange: (value: number) => void;
  /** Accessible name, e.g. the category. */
  label: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = hover || value;

  function select(next: number) {
    const clamped = Math.min(MAX, Math.max(1, next));
    onChange(clamped);
    refs.current[clamped - 1]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, star: number) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        select((value || star - 1) + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        select((value || star + 1) - 1);
        break;
      case "Home":
        e.preventDefault();
        select(1);
        break;
      case "End":
        e.preventDefault();
        select(MAX);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        select(star);
        break;
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div
        role="radiogroup"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          "inline-flex items-center rounded-md",
          invalid && "ring-2 ring-destructive/40"
        )}
        onMouseLeave={() => setHover(0)}
      >
        {Array.from({ length: MAX }).map((_, i) => {
          const star = i + 1;
          const checked = value === star;
          // Roving tabindex: the selected star, or the first when unrated.
          const tabbable = value ? checked : star === 1;
          return (
            <button
              key={star}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={`${star} ${star === 1 ? "star" : "stars"} — ${SCORE_LABELS[star]}`}
              tabIndex={tabbable ? 0 : -1}
              disabled={disabled}
              onClick={() => select(star)}
              onKeyDown={(e) => onKeyDown(e, star)}
              onMouseEnter={() => setHover(star)}
              className="rounded-sm p-0.5 outline-none transition-transform duration-150 ease-out hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LuStar
                aria-hidden
                className={cn(
                  "size-5 transition-colors duration-150",
                  star <= shown
                    ? "fill-primary text-primary"
                    : "fill-transparent text-muted-foreground/50"
                )}
              />
            </button>
          );
        })}
      </div>
      <span className="text-xs text-muted-foreground" aria-hidden>
        {shown ? `${shown}/5 · ${SCORE_LABELS[shown]}` : "Not rated"}
      </span>
    </div>
  );
}
