import { RedirectTo } from "@/components/layout/redirect-to";

/** Moved: My Profile now lives at Settings → Profile. Kept for old links and emails. */
export default function ProfileRedirect() {
  return <RedirectTo to="/settings/profile" />;
}
