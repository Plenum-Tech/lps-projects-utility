import { SetPasswordPage } from "@/components/auth/set-password-page";

import type { Route } from "./+types/set-password.$token";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Set your password | LPS" },
    { name: "robots", content: "noindex" },
    // Keep the one-time token out of Referer headers sent to other origins.
    { name: "referrer", content: "no-referrer" },
  ];
}

/** Public set-password page for imported accounts, outside the protected layout. */
export default function SetPassword({ params }: Route.ComponentProps) {
  return <SetPasswordPage key={params.token} token={params.token} />;
}
