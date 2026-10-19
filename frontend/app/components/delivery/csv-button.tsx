import { LuDownload, LuLoaderCircle } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { deliveryParams, useDeliveryCsv, type DeliveryCsvTable } from "@/hooks/use-delivery";
import type { DeliveryFilters } from "@/types";

/** Downloads the server CSV for a delivery table with the current filters. */
export function CsvButton({
  table,
  filters,
  extra,
  disabled,
}: {
  table: DeliveryCsvTable;
  filters: DeliveryFilters;
  extra?: Record<string, string>;
  disabled?: boolean;
}) {
  const csv = useDeliveryCsv();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled || csv.isPending}
      onClick={() => csv.mutate({ table, params: deliveryParams(filters, extra) })}
    >
      {csv.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
      Excel
      <span className="sr-only"> export of {table}</span>
    </Button>
  );
}
