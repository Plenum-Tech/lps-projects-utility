import { formatTimeOfDay } from "@/lib/format";
import { useEffect, useState } from "react";

/** "Welcome {name}" with a live clock (ticks on the minute). */
export function WelcomeClock({ name }: { name: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    let interval: ReturnType<typeof setInterval> | undefined;
    // Align to the next minute boundary, then tick every minute.
    const timeout = setTimeout(
      () => {
        setNow(new Date());
        interval = setInterval(() => setNow(new Date()), 60_000);
      },
      60_000 - (Date.now() % 60_000)
    );
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  const time = now ? formatTimeOfDay(now).toLowerCase() : undefined;
  const weekday = now?.toLocaleDateString("en-US", { weekday: "long" });

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="min-w-0 font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        Welcome <span className="text-primary">{name}</span>
      </h1>
      {now && (
        <p className="text-right leading-tight" aria-label={`${weekday}, ${time}`}>
          <time
            dateTime={now.toISOString()}
            className="block font-heading text-xl font-semibold text-foreground tabular-nums"
          >
            {time}
          </time>
          <span className="text-xs text-muted-foreground">{weekday}</span>
        </p>
      )}
    </div>
  );
}
