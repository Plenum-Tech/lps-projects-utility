import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LuTags, LuTriangleAlert } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import { api } from "@/lib/api";
import { formatDateOnly, todayKey } from "@/lib/tasks";

interface UnbrandedResponse {
  deadline: string;
  total: number;
  projects: Array<{ _id: string; code: string; name: string }>;
}

const SNOOZE_KEY = "brand-mapping-snoozed-on";

function snoozedToday(): boolean {
  try {
    return window.sessionStorage.getItem(SNOOZE_KEY) === todayKey();
  } catch {
    return false;
  }
}

/**
 * Warning at sign-in while projects the user manages have no brand: they must
 * be mapped to a brand by the deadline. "Map brands now" opens the projects
 * list filtered to "No brand"; "Later" hides it for the rest of the day.
 */
export function BrandMappingPrompt() {
  const { data: me } = useCurrentUser();
  const location = useLocation();
  const navigate = useNavigate();
  const [snoozed, setSnoozed] = useState(snoozedToday);
  const enabled = Boolean(me) && !me?.mustChangePassword;
  const query = useQuery({
    queryKey: ["projects", "unbranded"],
    queryFn: async () => (await api.get<UnbrandedResponse>("/projects/unbranded")).data,
    enabled,
    staleTime: 5 * 60_000,
  });
  const data = query.data;
  const onProjects = location.pathname.startsWith("/projects") || location.pathname.startsWith("/training");
  if (!enabled || !data || data.total === 0 || snoozed || onProjects) return null;

  const overdue = todayKey() > data.deadline;
  const daysLeft = Math.max(0, Math.round((Date.parse(`${data.deadline}T00:00:00Z`) - Date.parse(`${todayKey()}T00:00:00Z`)) / 86_400_000));

  function later() {
    try {
      window.sessionStorage.setItem(SNOOZE_KEY, todayKey());
    } catch {
      // storage unavailable: hide for this page view only
    }
    setSnoozed(true);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && later()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LuTags aria-hidden className="size-5 text-primary" />
            Map your projects to a brand
          </DialogTitle>
          <DialogDescription>
            {data.total} project{data.total === 1 ? "" : "s"} you manage {data.total === 1 ? "has" : "have"} no brand. Map each
            one to a brand by <strong>{formatDateOnly(data.deadline, true)}</strong>
            {overdue ? "" : ` (${daysLeft === 0 ? "today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`})`}. Projects
            still without a brand after that date may be removed.
          </DialogDescription>
        </DialogHeader>
        {overdue && (
          <p className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <LuTriangleAlert aria-hidden className="size-4" />
            The deadline has passed.
          </p>
        )}
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
          {data.projects.slice(0, 8).map((p) => (
            <li key={p._id}>
              <Link to={`/projects/${p._id}`} className="block truncate rounded px-2 py-1 hover:bg-accent" onClick={later}>
                <span className="font-mono text-xs text-muted-foreground">{p.code}</span> {p.name}
              </Link>
            </li>
          ))}
          {data.total > 8 && <li className="px-2 text-xs text-muted-foreground">…and {data.total - 8} more</li>}
        </ul>
        <p className="text-xs text-muted-foreground">Open a project, press Edit, pick its brand and save.</p>
        <DialogFooter>
          <Button variant="outline" onClick={later}>
            Later
          </Button>
          <Button
            onClick={() => {
              later();
              void navigate("/projects?brand=none");
            }}
          >
            Map brands now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
