import { DeliveryPulse } from "@/components/delivery/delivery-pulse";
import { useCurrentUser } from "@/hooks/use-auth";

import type { Route } from "./+types/reports.delivery";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Delivery Pulse | LPS" }];
}

/** View-only, open to everyone (the whole company). */
export default function DeliveryPulsePage() {
  const { data: user } = useCurrentUser();
  if (!user) return null;
  return <DeliveryPulse me={{ _id: user._id, role: user.role }} />;
}
