import { useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LuBuilding2 } from "react-icons/lu";

import { ActionsSection } from "@/components/delivery/actions-section";
import { AnalysisSection } from "@/components/delivery/analysis-section";
import { DeliveryHeader, SectionNav } from "@/components/delivery/delivery-header";
import { PeopleSection } from "@/components/delivery/people-section";
import { ResultsSection } from "@/components/delivery/results-section";
import { useDeliveryFilters } from "@/components/delivery/use-delivery-filters";
import { EmptyState } from "@/components/globals/query-states";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { deliveryKeys, useDeliverySummary } from "@/hooks/use-delivery";
import type { Role } from "@/types";

/** Height of the sticky header while it's sticky (≥ lg), so the nav sits right under it. */
function useStickyOffset(headerRef: RefObject<HTMLElement | null>, navRef: RefObject<HTMLElement | null>) {
  const [state, setState] = useState({ navTop: 0, offset: 0 });
  useEffect(() => {
    const header = headerRef.current;
    const nav = navRef.current;
    if (!header || !nav) return;
    const media = window.matchMedia("(min-width: 1024px)");
    const measure = () => {
      const navTop = media.matches ? header.offsetHeight : 0;
      setState({ navTop, offset: navTop + nav.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(nav);
    media.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", measure);
    };
  }, [headerRef, navRef]);
  return state;
}

/** Reports → Delivery Pulse (admin: everything; head: their department's doers). */
export function DeliveryPulse({ me }: { me: { _id: string; role: Role } }) {
  const { filters, setFilters, filtered, taskId, openTask } = useDeliveryFilters();
  const summary = useDeliverySummary(filters);
  const queryClient = useQueryClient();
  const headerRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const { navTop, offset } = useStickyOffset(headerRef, navRef);
  const scope = summary.data?.meta.scope;

  // Deep link (#people) once the content exists.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div
      className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 lg:px-8"
      style={{ ["--pulse-offset" as string]: `${offset}px` }}
    >
      <DeliveryHeader
        headerRef={headerRef}
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters({ team: "", brand: "", person: "" })}
        filtered={filtered}
        asOf={summary.data?.meta.asOf ?? null}
        fetching={summary.isFetching}
        onRefresh={() => void queryClient.invalidateQueries({ queryKey: deliveryKeys.all })}
      />
      <SectionNav top={navTop} navRef={navRef} />

      {scope?.noDepartment ? (
        <EmptyState
          icon={LuBuilding2}
          title="You're not in a department yet"
          description="Delivery Pulse shows department heads the work of their own department's doers. Ask an administrator to add you to a department."
          className="mt-8"
        />
      ) : (
        <div className="mt-6 space-y-12">
          {scope?.kind === "department" && (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Showing tasks where at least one doer is in <span className="font-medium text-foreground">{scope.departmentName ?? "your department"}</span>.
            </p>
          )}
          <ResultsSection summary={summary} />
          <AnalysisSection filters={filters} />
          <ActionsSection filters={filters} onOpenTask={openTask} />
          <PeopleSection filters={filters} isAdmin={me.role === "admin"} onOpenTask={openTask} />
          <p className="text-xs text-muted-foreground">
            Dates are compared in the app timezone{summary.data ? ` (${summary.data.meta.timezone})` : ""}. “12m” covers the last 365 days. Tasks in archived projects are included. Traffic managers (Settings → Delivery) are left out of people stats and doer checks.
          </p>
        </div>
      )}

      <TaskDetailSheet taskId={taskId} me={me} onClose={() => openTask(null)} />
    </div>
  );
}
