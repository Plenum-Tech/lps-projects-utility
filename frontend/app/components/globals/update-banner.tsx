import { useEffect, useState } from "react";
import { LuRefreshCw } from "react-icons/lu";

import { Button } from "@/components/ui/button";

const CHECK_EVERY_MS = 3 * 60_000;
const MANIFEST = /\/assets\/manifest-[A-Za-z0-9_-]+\.js/;

/** The build this tab is running (its route manifest file; absent in dev). */
function currentBuild(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[href*="/assets/manifest-"]');
  return link?.getAttribute("href")?.match(MANIFEST)?.[0] ?? null;
}

/**
 * "A new version is available" banner: every few minutes (and when the tab
 * regains focus) compares this tab's build with the one the server now serves.
 */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = currentBuild();
    if (!mine) return;
    let cancelled = false;
    async function check() {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const live = html.match(MANIFEST)?.[0];
        if (!cancelled && live && live !== mine) setStale(true);
      } catch {
        // offline or server restarting: try again later
      }
    }
    const timer = setInterval(check, CHECK_EVERY_MS);
    const onFocus = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onFocus);
    void check();
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[calc(100%-2rem)] max-w-xl items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg"
    >
      <LuRefreshCw aria-hidden className="size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-sm">
        A new version of Projects Utility is available. Refresh to get the latest changes.
      </p>
      <Button size="sm" onClick={() => window.location.reload()}>
        Refresh
      </Button>
    </div>
  );
}
