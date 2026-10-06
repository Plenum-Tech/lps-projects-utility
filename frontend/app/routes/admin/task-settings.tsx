import { RedirectTo } from "@/components/layout/redirect-to";

/** Moved: Task Settings now live at Settings → Task Settings. Kept for old links. */
export default function TaskSettingsRedirect() {
  return <RedirectTo to="/settings/tasks" />;
}
