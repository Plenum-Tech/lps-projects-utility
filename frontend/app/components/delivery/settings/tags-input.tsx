import { useState, type KeyboardEvent } from "react";
import { LuX } from "react-icons/lu";

import { cn } from "@/lib/utils";

/**
 * Free-text chips: Enter, comma or paste adds; Backspace on an empty input
 * removes the last chip. Values are normalised by `normalize` (default: trim +
 * lower-case) and de-duplicated.
 */
export function TagsInput({
  id,
  value,
  onChange,
  placeholder,
  max = 50,
  maxLength = 40,
  normalize = (text: string) => text.trim().toLowerCase(),
  invalid,
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  max?: number;
  maxLength?: number;
  normalize?: (text: string) => string;
  invalid?: boolean;
  "aria-describedby"?: string;
}) {
  const [draft, setDraft] = useState("");

  function add(text: string) {
    const parts = text
      .split(/[,\n]/)
      .map(normalize)
      .filter((part) => part && part.length <= maxLength);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) if (!next.includes(part) && next.length < max) next.push(part);
    onChange(next);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        invalid && "border-destructive"
      )}
    >
      {value.map((tag) => (
        <span key={tag} className="inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 text-xs font-medium">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((item) => item !== tag))}
            aria-label={`Remove ${tag}`}
            className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <LuX aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft && add(draft)}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (/[,\n]/.test(text)) {
            event.preventDefault();
            add(text);
          }
        }}
        placeholder={value.length === 0 ? placeholder : "Add…"}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        maxLength={maxLength + 200}
        className="h-7 min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
