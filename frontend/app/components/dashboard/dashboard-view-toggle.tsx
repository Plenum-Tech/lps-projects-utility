import { useCallback, useEffect, useState } from "react";
import { LuBuilding2, LuUserRound } from "react-icons/lu";

import { cn } from "@/lib/utils";

export type DashboardView = "my" | "organisation";

const STORAGE_KEY = "ems.dashboard.view";

/** Remembered My dashboard / Organisation choice (admins and heads). */
function readStoredView(): DashboardView | null {
  try {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "my" || stored === "organisation" ? stored : null;
  } catch {
    return null; // Storage unavailable — default to My dashboard.
  }
}

export function useDashboardView() {
  // Lazy read avoids fetching the wrong view first; the effect covers SSR.
  const [view, setViewState] = useState<DashboardView>(() => readStoredView() ?? "my");

  useEffect(() => {
    const stored = readStoredView();
    if (stored) setViewState(stored);
  }, []);

  const setView = useCallback((next: DashboardView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice still applies for this visit.
    }
  }, []);

  return [view, setView] as const;
}

const OPTIONS: { value: DashboardView; label: string; icon: typeof LuUserRound }[] = [
  { value: "my", label: "My dashboard", icon: LuUserRound },
  { value: "organisation", label: "Organisation", icon: LuBuilding2 },
];

/** Segmented "My dashboard | Organisation" switch. */
export function DashboardViewToggle({
  value,
  onChange,
}: {
  value: DashboardView;
  onChange: (value: DashboardView) => void;
}) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = value === "my" ? "organisation" : "my";
    onChange(event.key === "Home" ? "my" : event.key === "End" ? "organisation" : next);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons[OPTIONS.findIndex((option) => option.value === next)]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Dashboard view"
      onKeyDown={onKeyDown}
      className="inline-flex rounded-lg border bg-card p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              active && "bg-primary/10 text-primary hover:text-primary"
            )}
          >
            <Icon aria-hidden className="size-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
