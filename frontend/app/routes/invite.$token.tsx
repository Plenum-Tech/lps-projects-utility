import { InvitePage } from "@/components/auth/invite-page";

import type { Route } from "./+types/invite.$token";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Join | LPS" },
    { name: "robots", content: "noindex" },
  ];
}

/** Public invite acceptance page, outside the protected layout. */
export default function Invite({ params }: Route.ComponentProps) {
  return <InvitePage key={params.token} token={params.token} />;
}
