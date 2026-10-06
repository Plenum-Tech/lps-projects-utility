import { LuFileClock } from "react-icons/lu";

import { CardEmpty, DashboardCard } from "@/components/dashboard/my-dashboard/dashboard-card";
import {
  DOCUMENT_TYPE_LABELS,
  EXPIRY_DOT,
  EXPIRY_TEXT,
  expiryPhrase,
  expiryUrgency,
} from "@/lib/documents";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { MyDashboard } from "@/types";

/** Documents expiring in the next 60 days (and expired), with urgency colours. */
export function DocumentExpiriesCard({
  items,
  total,
  showOwner,
}: {
  items: MyDashboard["documentExpiries"];
  total: number;
  /** Admins and heads see whose document it is. */
  showOwner: boolean;
}) {
  return (
    <DashboardCard
      title="Document expiries"
      icon={LuFileClock}
      badge={total}
      viewAll={{ to: "/documents?expiring=60" }}
    >
      {items.length === 0 ? (
        <CardEmpty icon={LuFileClock} text="No upcoming document expiries" />
      ) : (
        <ul className="divide-y">
          {items.map((doc) => {
            const urgency = expiryUrgency(doc.inDays);
            return (
              <li key={doc._id} className="flex items-center gap-3 px-4 py-2.5">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", EXPIRY_DOT[urgency])} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {DOCUMENT_TYPE_LABELS[doc.type]}
                    {showOwner && <> · {doc.user.name}</>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn("text-xs font-medium tabular-nums", EXPIRY_TEXT[urgency])}>
                    {formatPlainDate(doc.expiryDate)}
                  </p>
                  <p className={cn("text-xs", urgency === "later" ? "text-muted-foreground" : EXPIRY_TEXT[urgency])}>
                    {expiryPhrase(doc.inDays)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardCard>
  );
}
