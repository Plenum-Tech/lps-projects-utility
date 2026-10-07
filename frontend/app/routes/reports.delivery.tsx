import { DeliveryPulse } from "@/components/delivery/delivery-pulse";
import { AccessDenied } from "@/components/globals/query-states";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.delivery";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Delivery Pulse | LPS" }];
}

/** Head/admin only — heads are limited to their department's doers server-side. */
export default function DeliveryPulsePage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  if (user.role === "employee") {
    return (
      <AccessDenied
        title="Managers only"
        description="Delivery Pulse is available to department heads and administrators."
      />
    );
  }
  return <DeliveryPulse me={{ _id: user._id, role: user.role }} />;
}
