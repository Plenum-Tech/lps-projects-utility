import { LuSparkles, LuUserX } from "react-icons/lu";

import { UserPicker } from "@/components/globals/user-picker";
import { speakerTones } from "@/lib/meetings";
import { initials } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { UserRef } from "@/types";

export interface SpeakerRow {
  name: string;
  /** Mapped LPS user id, null = "Not in LPS". */
  user: string | null;
  /** Auto-matched by the server (shown as a hint). */
  matched?: UserRef | null;
  /** Currently mapped user (kept selectable even if not in `people`). */
  current?: UserRef | null;
}

/** Each detected speaker → an LPS user picker, with "Not in LPS". */
export function SpeakerMapping({
  rows,
  onChange,
  people,
  loading,
  disabled,
}: {
  rows: SpeakerRow[];
  onChange: (name: string, user: string | null) => void;
  people: UserRef[];
  loading?: boolean;
  disabled?: boolean;
}) {
  const tones = speakerTones(rows.map((row) => row.name));
  return (
    <ul className="divide-y rounded-xl border">
      {rows.map((row) => {
        const tone = tones.get(row.name);
        const autoMatched = Boolean(row.matched && row.user === row.matched._id);
        return (
          <li key={row.name} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold text-background",
                  tone?.dot ?? "bg-muted-foreground"
                )}
              >
                {initials(row.name)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  {autoMatched ? (
                    <>
                      <LuSparkles aria-hidden className="size-3 text-primary" />
                      Auto-matched
                    </>
                  ) : row.user ? (
                    "Mapped"
                  ) : (
                    <>
                      <LuUserX aria-hidden className="size-3" />
                      Not in LPS
                    </>
                  )}
                </p>
              </div>
            </div>
            <UserPicker
              users={people}
              extra={[row.current, row.matched]}
              value={row.user}
              onChange={(user) => onChange(row.name, user)}
              noneLabel="Not in LPS"
              loading={loading}
              disabled={disabled}
              aria-label={`LPS user for ${row.name}`}
            />
          </li>
        );
      })}
    </ul>
  );
}
