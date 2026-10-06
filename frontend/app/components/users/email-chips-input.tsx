import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { LuCircleAlert, LuX } from "react-icons/lu";

import { cn } from "@/lib/utils";

export const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const SEPARATORS = /[\s,;]+/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/**
 * Chips input for many email addresses. Typing a comma, space, semicolon or
 * Enter (or pasting a list) turns text into chips. Addresses are trimmed,
 * lowercased and de-duplicated; invalid ones stay visible, flagged, so the user
 * can fix or remove them. `max` caps the number of chips.
 */
export function EmailChipsInput({
  id,
  value,
  onValueChange,
  max = 50,
  invalid,
  disabled,
  placeholder = "name@company.com, another@company.com",
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  max?: number;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  "aria-describedby"?: string;
}) {
  const [draft, setDraft] = useState("");
  const [overflow, setOverflow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Latest chips, updated synchronously on commit so fast typing/pasting never
  // works from a stale render.
  const valueRef = useRef(value);
  valueRef.current = value;

  function commit(raw: string) {
    const parts = raw
      .split(SEPARATORS)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...valueRef.current];
    let dropped = false;
    for (const part of parts) {
      if (next.includes(part)) continue;
      if (next.length >= max) {
        dropped = true;
        break;
      }
      next.push(part);
    }
    setOverflow(dropped);
    valueRef.current = next;
    onValueChange(next);
  }

  function remove(email: string) {
    setOverflow(false);
    const next = valueRef.current.filter((item) => item !== email);
    valueRef.current = next;
    onValueChange(next);
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Read the DOM value, not state: it is always current.
    const current = event.currentTarget.value;
    if (event.key === "Enter" || event.key === "," || event.key === ";" || event.key === " " || event.key === "Tab") {
      if (current.trim() === "") {
        if (event.key !== "Tab") event.preventDefault();
        return;
      }
      event.preventDefault();
      commit(current);
      setDraft("");
    } else if (event.key === "Backspace" && current === "" && valueRef.current.length > 0) {
      event.preventDefault();
      remove(valueRef.current[valueRef.current.length - 1]!);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!SEPARATORS.test(text)) return; // a single address: let it paste into the draft
    event.preventDefault();
    commit(event.currentTarget.value + " " + text);
    setDraft("");
  }

  const invalidCount = value.filter((email) => !isValidEmail(email)).length;

  return (
    <div className="space-y-1.5">
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex min-h-20 cursor-text flex-wrap content-start items-start gap-1 rounded-lg border border-input bg-transparent p-1.5 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
          invalid && "border-destructive ring-3 ring-destructive/20 dark:border-destructive/50 dark:ring-destructive/40",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <ul className="contents" aria-label="Email addresses">
          {value.map((email) => {
            const ok = isValidEmail(email);
            return (
              <li
                key={email}
                className={cn(
                  "flex h-6 max-w-full items-center gap-1 rounded-md pr-0.5 pl-2 text-xs font-medium",
                  ok ? "bg-muted text-foreground" : "bg-destructive/10 text-destructive"
                )}
              >
                {!ok && <LuCircleAlert aria-hidden className="size-3 shrink-0" />}
                <span className="truncate">{email}</span>
                {!ok && <span className="sr-only">(invalid address)</span>}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(email);
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={`Remove ${email}`}
                >
                  <LuX aria-hidden className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            const text = event.target.value;
            // Typed or IME-inserted separators commit immediately.
            if (SEPARATORS.test(text)) {
              commit(text);
              setDraft("");
            } else {
              setDraft(text);
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={(event) => {
            if (event.currentTarget.value.trim()) {
              commit(event.currentTarget.value);
              setDraft("");
            }
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="h-6 min-w-40 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" aria-live="polite">
        <span>
          {invalidCount > 0 ? (
            <span className="text-destructive">
              {invalidCount} invalid {invalidCount === 1 ? "address" : "addresses"}: fix or remove {invalidCount === 1 ? "it" : "them"}.
            </span>
          ) : overflow ? (
            <span className="text-destructive">You can invite up to {max} people at once.</span>
          ) : (
            "Separate addresses with commas, spaces or new lines."
          )}
        </span>
        <span className="tabular-nums">
          {value.length} / {max}
        </span>
      </div>
    </div>
  );
}
