import { useState } from "react";
import { LuSearch, LuSearchX, LuX } from "react-icons/lu";
import { Link, Navigate, useNavigate } from "react-router";

import { AccessDenied, PageHeader } from "@/components/globals/query-states";
import {
  SETTINGS_SECTIONS,
  defaultSectionId,
  matchesSearch,
  sectionsForRole,
} from "@/components/settings/registry";
import { UnsavedChangesProvider } from "@/components/settings/unsaved-changes";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { useCurrentUser } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

/**
 * /settings and /settings/:section — searchable section menu on the left
 * (a select on small screens), the active section on the right. Sections are
 * filtered by role; admin-only sections show "Admins only" to everyone else.
 */
export function SettingsLayout({ sectionId }: { sectionId?: string }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  if (!user) return null;

  const available = sectionsForRole(user.role);
  if (!sectionId) return <Navigate to={`/settings/${defaultSectionId(user.role)}`} replace />;

  const section = SETTINGS_SECTIONS.find((item) => item.id === sectionId);
  if (!section) return <Navigate to={`/settings/${defaultSectionId(user.role)}`} replace />;
  const allowed = !section.roles || section.roles.includes(user.role);
  const visible = available.filter((item) => matchesSearch(item, query));
  const Section = section.component;

  return (
    <UnsavedChangesProvider>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader title="Settings" description="Manage your account and, for admins, the whole workspace." />

        {/* Small screens: the section list becomes a select. */}
        <div className="mt-6 space-y-1.5 md:hidden">
          <Label htmlFor="settings-section-select">Section</Label>
          <NativeSelect
            id="settings-section-select"
            className="w-full"
            value={allowed ? section.id : ""}
            onChange={(event) => navigate(`/settings/${event.target.value}`)}
          >
            {!allowed && <NativeSelectOption value="">{section.title}</NativeSelectOption>}
            {available.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="hidden md:block">
            <div className="sticky top-4 space-y-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
              <InputGroup>
                <InputGroupAddon>
                  <LuSearch aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                />
                {query && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                      <LuX aria-hidden />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>

              {visible.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-2 py-6 text-center text-sm text-muted-foreground">
                  <LuSearchX aria-hidden className="size-5" />
                  No settings match &ldquo;{query.trim()}&rdquo;.
                </div>
              ) : (
                <nav aria-label="Settings sections">
                  <ul className="space-y-0.5">
                    {visible.map((item) => {
                      const active = item.id === section.id;
                      return (
                        <li key={item.id}>
                          <Link
                            to={`/settings/${item.id}`}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50",
                              active
                                ? "bg-primary/10 font-medium text-foreground before:absolute before:top-1/2 before:left-0 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <item.icon aria-hidden className={cn("size-4 shrink-0", active && "text-primary")} />
                            <span className="truncate">{item.title}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}
            </div>
          </aside>

          <section aria-labelledby="settings-section-title" className="min-w-0">
            {allowed ? (
              <>
                <header className="mb-4">
                  <h2 id="settings-section-title" className="font-heading text-xl font-semibold text-foreground">
                    {section.title}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">{section.description}</p>
                </header>
                <Section key={section.id} />
              </>
            ) : (
              <>
                <h2 id="settings-section-title" className="sr-only">
                  {section.title}
                </h2>
                <AccessDenied
                  title="Admins only"
                  description={`${section.title} can only be changed by an administrator.`}
                />
              </>
            )}
          </section>
        </div>
      </div>
    </UnsavedChangesProvider>
  );
}
