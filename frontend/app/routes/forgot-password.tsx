import { ForgotPasswordPage } from "@/components/auth/forgot-password-page";

import type { Route } from "./+types/forgot-password";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Reset your password | LPS" },
    { name: "robots", content: "noindex" },
  ];
}

/** Public forgot-password page (email → 6-digit code → new password), outside the protected layout. */
export default function ForgotPassword() {
  return <ForgotPasswordPage />;
}
