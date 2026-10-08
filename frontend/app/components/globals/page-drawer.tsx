import type { ReactNode } from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { LuX } from "react-icons/lu";

import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Worksuite-style page drawer: slides in from the right and covers the page
 * up to the app sidebar, on a muted background, with a round close tab on its
 * left edge. Full screen (with a normal close button) on small screens.
 * Use inside a <Sheet>; put content in <PageDrawerCard>s.
 */
export function PageDrawerContent({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof SheetContent>,
  "side" | "showCloseButton"
>) {
  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      className={cn(
        "w-full! max-w-none! gap-0 bg-muted p-0 lg:w-[calc(100vw-var(--sidebar-width,16rem))]!",
        className,
      )}
      {...props}
    >
      <SheetPrimitive.Close
        className="absolute top-4 -left-14 z-10 hidden h-11 w-14 items-center justify-center rounded-l-full bg-foreground text-background shadow-md outline-none hover:bg-foreground/90 focus-visible:ring-3 focus-visible:ring-ring/50 lg:inline-flex"
        aria-label="Close"
      >
        <LuX aria-hidden className="size-5" />
      </SheetPrimitive.Close>
      <SheetPrimitive.Close
        className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 lg:hidden"
        aria-label="Close"
      >
        <LuX aria-hidden className="size-4" />
      </SheetPrimitive.Close>
      {children}
    </SheetContent>
  );
}

/** White card section inside a page drawer, with an optional heading row. */
export function PageDrawerCard({
  title,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow-xs",
        className,
      )}
    >
      {title && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <h3 className="text-lg font-medium">{title}</h3>
          {action}
        </div>
      )}
      <div className="p-4 sm:p-6">{children}</div>
    </section>
  );
}
