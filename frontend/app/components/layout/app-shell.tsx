import { Fragment } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { Outlet } from "react-router";

import { AppSidebar } from "@/components/layout/app-sidebar";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { TimerWidget } from "@/components/timer/timer-widget";
import { VoiceAssistant } from "@/components/voice/voice-assistant";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useNotificationSSE } from "@/hooks/use-notifications";
import { usePublicSettings } from "@/hooks/use-settings";
import { useTimeRealtime } from "@/hooks/use-timelogs";
import { displaySettingsKey, setDisplaySettings } from "@/lib/format";

/**
 * Chrome around every protected page: collapsible sidebar (icon rail on
 * desktop, Sheet on mobile) + a slim header with the sidebar trigger.
 * Pages render their own content below the header.
 */
export function AppShell() {
  // Initialize SSE connection for real-time notifications.
  useNotificationSSE();
  // Keeps the global timer and time-log lists in sync across tabs.
  useTimeRealtime();
  // Date/time formats and week start (Settings → App). Pages wait for them so
  // the first paint already uses the right formats; a change remounts the page.
  const publicSettings = usePublicSettings();
  if (publicSettings.data) setDisplaySettings(publicSettings.data);
  const displayKey = displaySettingsKey();

  return (
    <SidebarProvider>
      <AppSidebar />
      {/* min-w-0: wide tables scroll inside their card instead of stretching the page. */}
      <SidebarInset className="min-w-0">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <div className="ml-auto flex items-center gap-2">
            <TimerWidget />
            <NotificationBell />
          </div>
        </header>
        {/* Bottom padding: the last row of a page isn't hidden under the voice button. */}
        <div className="flex-1 pb-20">
          {publicSettings.isPending ? (
            <div className="flex justify-center py-24" role="status" aria-label="Loading">
              <LuLoaderCircle aria-hidden className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Fragment key={displayKey}>
              <Outlet />
            </Fragment>
          )}
        </div>
      </SidebarInset>
      {/* Floating mic: create / close a task or log time by voice (staff only). */}
      <VoiceAssistant />
    </SidebarProvider>
  );
}
