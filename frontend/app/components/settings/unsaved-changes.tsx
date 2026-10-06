import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useBlocker } from "react-router";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";

interface UnsavedChangesContextValue {
  report: (id: string, dirty: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

/**
 * Lets a settings form report unsaved edits. Outside the settings area there's
 * no provider and this is a no-op, so shared cards (SaveBar, reminder cards)
 * can call it unconditionally.
 */
export function useReportDirty(dirty: boolean) {
  const context = useContext(UnsavedChangesContext);
  const id = useId();
  const report = context?.report;
  useEffect(() => {
    if (!report) return;
    report(id, dirty);
    return () => report(id, false);
  }, [report, id, dirty]);
}

/**
 * Collects dirty flags from the forms below it and guards navigation while
 * any is set: in-app navigation (another section, the sidebar) asks first,
 * and closing / reloading the tab triggers the browser's own prompt.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((id: string, dirty: boolean) => {
    setDirtyIds((previous) => {
      if (previous.has(id) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ report }), [report]);
  const dirty = dirtyIds.size > 0;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
  );

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.state === "blocked") blocker.reset();
        }}
        title="Discard unsaved changes?"
        description="You have changes on this page that haven't been saved. If you leave now they'll be lost."
        confirmLabel="Leave without saving"
        destructive
        onConfirm={() => {
          if (blocker.state === "blocked") {
            setDirtyIds(new Set());
            blocker.proceed();
          }
        }}
      />
    </UnsavedChangesContext.Provider>
  );
}
