import type { ReactNode } from "react";
import { useSearchParams } from "react-router";

import { PageHeader } from "@/components/globals/query-states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface ModuleTab {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * One sidebar entry, several role-aware views: a page header plus tabs whose
 * selection lives in `?tab=` (so deep links and old routes can open a view).
 * An unknown or missing `tab` falls back to `defaultTab` (or the first tab).
 */
export function ModuleTabsPage({
  title,
  description,
  tabs,
  defaultTab,
}: {
  title: string;
  description: string;
  tabs: ModuleTab[];
  defaultTab?: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const fallback = defaultTab ?? tabs[0]?.value ?? "";
  const active = tabs.some((tab) => tab.value === requested) ? (requested as string) : fallback;

  function select(value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("tab", value);
        return next;
      },
      { replace: true }
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader title={title} description={description} />
      <Tabs value={active} onValueChange={(value) => select(String(value))} className="mt-6">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
