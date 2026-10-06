import { RedirectTo } from "@/components/layout/redirect-to";

/** Moved: Project Settings now live at Settings → Project Settings. Kept for old links. */
export default function ProjectSettingsRedirect() {
  return <RedirectTo to="/settings/projects" />;
}
