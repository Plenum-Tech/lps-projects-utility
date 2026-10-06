import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsFieldError } from "@/hooks/use-settings";

/**
 * Local draft of a flat settings object: seeded from the server value, with a
 * dirty flag, a reset, and the list of changed keys (to PATCH only those).
 * Re-seeds whenever the server value changes (e.g. after a save).
 */
export function useSettingsForm<T extends { [K in keyof T]: string }>(source: T | undefined) {
  const [values, setValues] = useState<T | undefined>(source);

  useEffect(() => {
    setValues(source);
  }, [source]);

  const changed = useMemo(() => {
    if (!source || !values) return [] as (keyof T)[];
    return (Object.keys(source) as (keyof T)[]).filter((key) => values[key] !== source[key]);
  }, [source, values]);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((previous) => (previous ? { ...previous, [key]: value } : previous));
  }, []);

  const reset = useCallback(() => setValues(source), [source]);

  return { values, set, reset, changed, dirty: changed.length > 0 };
}

/** The server's `field` for a failed PATCH (e.g. "website", "address.city"). */
export function errorField(error: unknown): string | null {
  return error instanceof SettingsFieldError ? error.field : null;
}

export function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}
