import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LuAtSign } from "react-icons/lu";

import { UserAvatar } from "@/components/tasks/task-badges";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Textarea } from "@/components/ui/textarea";
import { MENTION_TOKEN, parseMentions } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { MentionableUser } from "@/types";

/* ------------------------------------------------------------------ */
/* Draft model: friendly "@Name" text + the mentions picked for it      */
/* ------------------------------------------------------------------ */

export interface MentionRef {
  id: string;
  name: string;
}

export interface MentionDraft {
  text: string;
  mentions: MentionRef[];
}

export const EMPTY_DRAFT: MentionDraft = { text: "", mentions: [] };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Raw comment body (with `@[Name](id)` tokens) → editable draft. */
export function bodyToDraft(body: string): MentionDraft {
  const mentions: MentionRef[] = [];
  const text = body.replace(MENTION_TOKEN, (_match, name: string, id: string) => {
    if (!mentions.some((mention) => mention.id === id)) mentions.push({ id, name });
    return `@${name}`;
  });
  return { text, mentions };
}

/** Draft → raw body: each picked "@Name" still present becomes a token. */
export function draftToBody(draft: MentionDraft): string {
  let body = draft.text;
  // Longest names first so "@Ann Lee" wins over "@Ann".
  const sorted = [...draft.mentions].sort((a, b) => b.name.length - a.name.length);
  for (const mention of sorted) {
    const pattern = new RegExp(`(^|\\s)@${escapeRegExp(mention.name)}(?=$|[\\s.,!?;:)])`, "g");
    body = body.replace(pattern, (_match, lead: string) => `${lead}@[${mention.name}](${mention.id})`);
  }
  return body.trim();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Comment body with mention tokens rendered as highlighted names. */
export function CommentBody({ body, className }: { body: string; className?: string }) {
  const parts = useMemo(() => parseMentions(body), [body]);
  return (
    <p className={cn("text-sm break-words whitespace-pre-wrap text-foreground", className)}>
      {parts.map((part, index) =>
        part.type === "text" ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <span
            key={index}
            className="rounded-sm bg-primary/10 px-0.5 font-medium text-primary"
            title={part.name}
          >
            @{part.name}
          </span>
        )
      )}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Textarea with @ autocomplete                                        */
/* ------------------------------------------------------------------ */

const TRIGGER = /(^|\s)@([^\s@]{0,30})$/;

/**
 * Textarea that suggests task members after "@". Picking one inserts a
 * friendly "@Name" and records the mention; `draftToBody` turns it into the
 * `@[Name](userId)` token the API expects. Ctrl/⌘+Enter submits.
 */
export function MentionTextarea({
  id,
  value,
  onChange,
  users,
  onSubmit,
  placeholder,
  disabled,
  autoFocus,
  rows = 3,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: MentionDraft;
  onChange: (value: MentionDraft) => void;
  users: MentionableUser[];
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  rows?: number;
  "aria-label"?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState("");

  const suggestions = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return users
      .filter(
        (user) => user.name.toLowerCase().includes(q) || user.email.toLowerCase().startsWith(q)
      )
      .slice(0, 6);
  }, [query, users]);

  const open = query !== null && suggestions.length > 0;
  const listId = `${id ?? "mention"}-suggestions`;

  function detect(text: string, caret: number) {
    const match = TRIGGER.exec(text.slice(0, caret));
    if (match) {
      setQuery(match[2]);
      setHighlighted((current) => current || "");
    } else {
      setQuery(null);
    }
  }

  function insert(user: MentionableUser) {
    const textarea = textareaRef.current;
    if (!textarea || query === null) return;
    const caret = textarea.selectionStart;
    const start = caret - query.length - 1; // include "@"
    const insertion = `@${user.name} `;
    const text = value.text.slice(0, start) + insertion + value.text.slice(caret);
    const mentions = value.mentions.some((mention) => mention.id === user._id)
      ? value.mentions
      : [...value.mentions, { id: user._id, name: user.name }];
    onChange({ text, mentions });
    setQuery(null);
    const nextCaret = start + insertion.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      const index = Math.max(
        0,
        suggestions.findIndex((user) => user._id === highlighted)
      );
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (index + delta + suggestions.length) % suggestions.length;
        setHighlighted(suggestions[next]._id);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insert(suggestions[index]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
    }
  }

  const activeId = open
    ? (suggestions.find((user) => user._id === highlighted) ?? suggestions[0])._id
    : undefined;

  return (
    <div className="relative">
      <Textarea
        ref={textareaRef}
        id={id}
        value={value.text}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId ? `${listId}-${activeId}` : undefined}
        onChange={(event) => {
          // Drop mentions whose "@Name" was deleted from the text.
          const text = event.target.value;
          onChange({
            text,
            mentions: value.mentions.filter((mention) => text.includes(`@${mention.name}`)),
          });
          detect(text, event.target.selectionStart);
        }}
        onSelect={(event) =>
          detect(event.currentTarget.value, event.currentTarget.selectionStart)
        }
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
      />

      {open && (
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg shadow-md ring-1 ring-foreground/10"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Command
            shouldFilter={false}
            value={activeId}
            onValueChange={setHighlighted}
            className="rounded-lg!"
          >
            <CommandList id={listId} aria-label="Mention suggestions">
              <CommandGroup heading="Mention someone">
                {suggestions.map((user) => (
                  <CommandItem
                    key={user._id}
                    id={`${listId}-${user._id}`}
                    value={user._id}
                    onSelect={() => insert(user)}
                  >
                    <UserAvatar user={user} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{user.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}

      <p className="mt-1 flex items-center gap-1 text-[0.7rem] text-muted-foreground">
        <LuAtSign aria-hidden className="size-3" />
        Type @ to mention someone · Ctrl+Enter to send
      </p>
    </div>
  );
}
