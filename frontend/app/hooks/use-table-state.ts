import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

export type SortDir = "asc" | "desc";

export const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;

/** Filter values are plain strings ("" = not set); multi-selects are comma-joined. */
export type FilterValues = Record<string, string>;

export interface TableStateOptions<F extends FilterValues> {
  /** Namespaces the remembered page size (`ems.table.<key>.pageSize`). */
  storageKey: string;
  /** Every filter key with its default value. Values equal to the default stay out of the URL. */
  defaults: F;
  /**
   * `url` (default): filters, sort and page live in the query string, so they can be
   * shared and survive a reload. `memory`: component state (embedded tables).
   */
  mode?: "url" | "memory";
}

/** Reserved query keys owned by the table itself. */
const SORT_KEY = "sort";
const DIR_KEY = "dir";
const PAGE_KEY = "page";

function readPageSize(storageKey: string): number | null {
  try {
    const raw = Number(window.localStorage.getItem(`ems.table.${storageKey}.pageSize`));
    return (PAGE_SIZES as readonly number[]).includes(raw) ? raw : null;
  } catch {
    return null;
  }
}

function storePageSize(storageKey: string, size: number) {
  try {
    window.localStorage.setItem(`ems.table.${storageKey}.pageSize`, String(size));
  } catch {
    // Storage unavailable — the choice still applies for this visit.
  }
}

/** Query-string backed store, or an in-memory one with the same shape. */
function useParamStore(mode: "url" | "memory") {
  const [searchParams, setSearchParams] = useSearchParams();
  const [memory, setMemory] = useState(() => new URLSearchParams());
  const current = mode === "url" ? searchParams : memory;

  // Rapid successive updates (double-clicking a sort header) must build on the
  // previous write, not on the not-yet-rendered URL.
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  }, [current]);

  const update = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(latest.current);
      mutate(next);
      latest.current = next;
      if (mode === "url") {
        setSearchParams(next, { replace: true, preventScrollReset: true });
      } else {
        setMemory(next);
      }
    },
    [mode, setSearchParams]
  );

  return [current, update] as const;
}

/**
 * Filters, sorting and pagination for a server-side data table. Any filter
 * change resets to page 1; the page size is remembered per table in
 * localStorage.
 */
export function useTableState<F extends FilterValues>({
  storageKey,
  defaults,
  mode = "url",
}: TableStateOptions<F>) {
  const [params, update] = useParamStore(mode);

  // Stable across renders even when callers pass an inline object.
  const defaultsKey = JSON.stringify(defaults);
  const stableDefaults = useMemo(() => JSON.parse(defaultsKey) as F, [defaultsKey]);

  const filters = useMemo(() => {
    const out = { ...stableDefaults };
    for (const key of Object.keys(stableDefaults) as (keyof F & string)[]) {
      const value = params.get(key);
      if (value !== null) (out as FilterValues)[key] = value;
    }
    return out;
  }, [params, stableDefaults]);

  const setFilters = useCallback(
    (patch: Partial<F>) => {
      update((next) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === stableDefaults[key]) next.delete(key);
          else next.set(key, value as string);
        }
        next.delete(PAGE_KEY);
      });
    },
    [update, stableDefaults]
  );

  /** Resets the given keys (default: every filter) to their defaults. */
  const clearFilters = useCallback(
    (keys?: (keyof F & string)[]) => {
      update((next) => {
        for (const key of keys ?? (Object.keys(stableDefaults) as (keyof F & string)[])) {
          next.delete(key);
        }
        next.delete(PAGE_KEY);
      });
    },
    [update, stableDefaults]
  );

  const sort = params.get(SORT_KEY) ?? "";
  const dir: SortDir = params.get(DIR_KEY) === "desc" ? "desc" : "asc";

  /** Cycles a column: ascending → descending → back to the default order. */
  const toggleSort = useCallback(
    (field: string) => {
      update((next) => {
        const currentSort = next.get(SORT_KEY);
        const currentDir = next.get(DIR_KEY) === "desc" ? "desc" : "asc";
        if (currentSort !== field) {
          next.set(SORT_KEY, field);
          next.set(DIR_KEY, "asc");
        } else if (currentDir === "asc") {
          next.set(DIR_KEY, "desc");
        } else {
          next.delete(SORT_KEY);
          next.delete(DIR_KEY);
        }
        next.delete(PAGE_KEY);
      });
    },
    [update]
  );

  const rawPage = Number(params.get(PAGE_KEY));
  const page = Number.isInteger(rawPage) && rawPage > 1 ? rawPage : 1;

  const setPage = useCallback(
    (nextPage: number) => {
      update((next) => {
        if (nextPage <= 1) next.delete(PAGE_KEY);
        else next.set(PAGE_KEY, String(nextPage));
      });
    },
    [update]
  );

  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE);
  useEffect(() => {
    const stored = readPageSize(storageKey);
    if (stored) setPageSizeState(stored);
  }, [storageKey]);

  const setPageSize = useCallback(
    (size: number) => {
      setPageSizeState(size);
      storePageSize(storageKey, size);
      update((next) => next.delete(PAGE_KEY));
    },
    [storageKey, update]
  );

  /** Call with the server total: jumps back when the page is past the end. */
  const clampPage = useCallback(
    (total: number) => {
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      if (page > lastPage) setPage(lastPage);
    },
    [page, pageSize, setPage]
  );

  /** How many of `keys` differ from their defaults (for "Filters (3)" badges). */
  const countActive = useCallback(
    (keys: (keyof F & string)[]) =>
      keys.filter((key) => filters[key] !== stableDefaults[key]).length,
    [filters, stableDefaults]
  );

  return {
    filters,
    setFilters,
    clearFilters,
    countActive,
    sort,
    dir,
    toggleSort,
    page,
    setPage,
    pageSize,
    setPageSize,
    offset: (page - 1) * pageSize,
    clampPage,
  };
}

export type TableState<F extends FilterValues> = ReturnType<typeof useTableState<F>>;

/** Row selection that survives pagination (ids), cleared by the caller on filter changes. */
export function useRowSelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string, checked?: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const on = checked ?? !next.has(id);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  return { selected, ids: [...selected], count: selected.size, toggle, setMany, clear };
}

export type RowSelection = ReturnType<typeof useRowSelection>;
