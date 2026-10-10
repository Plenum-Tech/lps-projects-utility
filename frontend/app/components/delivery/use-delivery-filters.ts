import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

import {
  DEFAULT_PERIOD,
  isPeriod,
} from "@/components/delivery/delivery-format";
import type { DeliveryFilters } from "@/types";

const KEYS = ["period", "team", "brand", "person", "from", "to"] as const;

/**
 * Dashboard filters kept in the URL query (?period=90d&brand=…), so they
 * survive a reload and can be shared. The default period is left out of the URL.
 * Also holds `?task=<id>` for the task sheet.
 */
export function useDeliveryFilters() {
  const [params, setParams] = useSearchParams();

  const filters = useMemo<DeliveryFilters>(() => {
    const period = params.get("period");
    return {
      period: isPeriod(period) ? period : DEFAULT_PERIOD,
      team: params.get("team") ?? "",
      brand: params.get("brand") ?? "",
      person: params.get("person") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
    };
  }, [params]);

  const setFilters = useCallback(
    (patch: Partial<DeliveryFilters>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const key of KEYS) {
            if (!(key in patch)) continue;
            const value = patch[key];
            if (!value || (key === "period" && value === DEFAULT_PERIOD))
              next.delete(key);
            else next.set(key, value);
          }
          // The from/to dates only belong to the custom period.
          if (next.get("period") !== "custom") {
            next.delete("from");
            next.delete("to");
          }
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  const taskId = params.get("task");
  const openTask = useCallback(
    (id: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (id) next.set("task", id);
          else next.delete("task");
          return next;
        },
        { preventScrollReset: true },
      );
    },
    [setParams],
  );

  const filtered = Boolean(filters.team || filters.brand || filters.person);

  return { filters, setFilters, filtered, taskId, openTask };
}
