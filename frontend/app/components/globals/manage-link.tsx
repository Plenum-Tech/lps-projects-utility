import { useEffect } from "react";
import { LuPlus } from "react-icons/lu";

/**
 * Small "+ Manage …" link under a select. Opens the settings page in a new tab
 * so a half-filled dialog isn't lost; pair it with `useRefetchOnFocus` so the
 * select picks up new options when the user comes back.
 */
export function ManageLink({ to, children }: { to: string; children: string }) {
  return (
    <a
      href={to}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LuPlus className="size-3" aria-hidden />
      {children}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** Calls `refetch` whenever the window regains focus while `enabled`. */
export function useRefetchOnFocus(refetch: () => unknown, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch, enabled]);
}
