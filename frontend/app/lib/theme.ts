import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Colour theme: System (follow the OS), Light, Dark or Black (pure black,
// for OLED screens). Stored per device in localStorage and applied as
// classes on <html>: `.dark` for Dark / Black, plus `.black` for Black.
// THEME_BOOT_SCRIPT applies it before the first paint (no white flash).
// ---------------------------------------------------------------------------

export const THEMES = ["system", "light", "dark", "black"] as const;
export type ThemeChoice = (typeof THEMES)[number];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  black: "Black",
};

const STORAGE_KEY = "lps-theme";

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return (THEMES as readonly string[]).includes(value ?? "") ? (value as ThemeChoice) : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** Puts the theme's classes on <html> (and the browser's colour scheme). */
export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === "dark" || choice === "black" || (choice === "system" && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("black", choice === "black");
  root.style.colorScheme = dark ? "dark" : "light";
}

/** Inline <head> script: applies the stored theme before the page paints. Keep in step with applyTheme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}")||"system";var d=t==="dark"||t==="black"||(t==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");if(t==="black")r.classList.add("black");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

/** The current theme choice and a setter (saves it and applies it at once). */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => (typeof window === "undefined" ? "system" : readTheme()));

  // "System" follows the OS setting live.
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
  }, [choice]);

  const set = useCallback((next: ThemeChoice) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable: still applies for this page view
    }
    setChoice(next);
  }, []);

  return [choice, set];
}
