import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { LuActivity, LuFilterX, LuRefreshCw } from "react-icons/lu";

import { PERIODS } from "@/components/delivery/delivery-format";
import { FilterSelect } from "@/components/globals/filter-select";
import { SegmentedControl } from "@/components/globals/segmented-control";
import { Button } from "@/components/ui/button";
import { useBrands } from "@/hooks/use-brands";
import { useDeliveryTeamOptions } from "@/hooks/use-delivery";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { formatTimeOfDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DeliveryFilters } from "@/types";

export const PULSE_SECTIONS = [
  { id: "results", label: "Results" },
  { id: "analysis", label: "Analysis" },
  { id: "actions", label: "Actions" },
  { id: "people", label: "People" },
] as const;

/**
 * Sticky page header (≥ lg): title, "data as of", period + Team/Brand/Person
 * filters. Below lg it scrolls away and only the section nav sticks.
 */
export function DeliveryHeader({
  filters,
  onChange,
  onReset,
  filtered,
  asOf,
  fetching,
  onRefresh,
  headerRef,
}: {
  filters: DeliveryFilters;
  onChange: (patch: Partial<DeliveryFilters>) => void;
  onReset: () => void;
  filtered: boolean;
  asOf: string | null;
  fetching: boolean;
  onRefresh: () => void;
  headerRef: RefObject<HTMLElement | null>;
}) {
  const teams = useDeliveryTeamOptions();
  const brands = useBrands();
  const people = useAssignableUsers();

  const brandOptions = useMemo(
    () => [
      ...(brands.data ?? []).map((brand) => ({
        value: brand._id,
        label: brand.active ? brand.name : `${brand.name} (inactive)`,
      })),
      { value: "none", label: "No brand" },
    ],
    [brands.data]
  );
  const personOptions = useMemo(
    () => (people.data ?? []).map((user) => ({ value: user._id, label: user.name })),
    [people.data]
  );
  // Keep a filter from the URL selectable even before/without its option.
  const withCurrent = (options: { value: string; label: string }[], value: string, fallback: string) =>
    value && !options.some((option) => option.value === value) ? [...options, { value, label: fallback }] : options;

  return (
    <header
      ref={headerRef}
      className="z-30 -mx-4 border-b bg-background/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:sticky lg:top-0 lg:-mx-8 lg:px-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            <span className="flex size-8 items-center justify-center rounded-lg bg-pulse-blue/10 text-pulse-blue">
              <LuActivity aria-hidden className="size-4.5" />
            </span>
            Delivery Pulse
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Creative &amp; production delivery from the task board
            <span aria-hidden> · </span>
            <span className="whitespace-nowrap" aria-live="polite">
              {asOf ? `data as of ${formatTimeOfDay(asOf)}` : "loading…"}
            </span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={fetching}
          aria-label="Refresh data"
          className="hidden sm:inline-flex"
        >
          <LuRefreshCw aria-hidden className={cn(fetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Dashboard filters">
        <SegmentedControl
          label="Period"
          value={filters.period}
          onChange={(period) => onChange({ period })}
          options={PERIODS}
        />
        <FilterSelect
          label="Team"
          value={filters.team}
          onChange={(team) => onChange({ team })}
          options={withCurrent(teams.options, filters.team, "Selected team")}
          anyLabel="All teams"
        />
        <FilterSelect
          label="Brand"
          value={filters.brand}
          onChange={(brand) => onChange({ brand })}
          options={withCurrent(brandOptions, filters.brand, "Selected brand")}
          anyLabel="All brands"
        />
        <FilterSelect
          label="Person"
          value={filters.person}
          onChange={(person) => onChange({ person })}
          options={withCurrent(personOptions, filters.person, "Selected person")}
          anyLabel="Everyone"
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <LuFilterX aria-hidden />
            Clear
          </Button>
        )}
      </div>
    </header>
  );
}

/** Sticky "1 · Results … 4 · People" anchor nav with active-section highlighting. */
export function SectionNav({ top, navRef }: { top: number; navRef: RefObject<HTMLElement | null> }) {
  const [active, setActive] = useState<string>(PULSE_SECTIONS[0].id);
  const offsetRef = useRef(top);
  offsetRef.current = top;

  useEffect(() => {
    // Active = the last section whose top has passed just below the sticky chrome.
    function update() {
      const line = offsetRef.current + (navRef.current?.offsetHeight ?? 0) + 24;
      let current: string = PULSE_SECTIONS[0].id;
      for (const section of PULSE_SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      // At the very bottom, the last section is active even if it's short.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = PULSE_SECTIONS[PULSE_SECTIONS.length - 1].id;
      }
      setActive(current);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [navRef]);

  function go(id: string) {
    const element = document.getElementById(id);
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
    setActive(id);
  }

  return (
    <nav
      ref={navRef}
      aria-label="Dashboard sections"
      className="sticky z-20 -mx-4 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      style={{ top }}
    >
      <ol className="no-scrollbar flex gap-1 overflow-x-auto py-2">
        {PULSE_SECTIONS.map((section, index) => {
          const current = active === section.id;
          return (
            <li key={section.id} className="shrink-0">
              <a
                href={`#${section.id}`}
                aria-current={current ? "location" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  go(section.id);
                }}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/50",
                  current
                    ? "bg-pulse-blue/10 font-medium text-pulse-blue"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <span className="tabular-nums">{index + 1}</span>
                <span aria-hidden>·</span>
                {section.label}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
