import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { EditorContent, Node, mergeAttributes, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import {
  LuAlignCenter,
  LuAlignLeft,
  LuAlignRight,
  LuAtSign,
  LuBold,
  LuItalic,
  LuLink,
  LuList,
  LuListOrdered,
  LuUnderline,
  LuUnlink,
} from "react-icons/lu";

import { UserAvatar } from "@/components/tasks/task-badges";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { MentionableUser } from "@/types";

// ---------------------------------------------------------------------------
// Formatted descriptions: an editor (bold, italic, underline, links, lists,
// alignment) that stores HTML, and a safe renderer that also shows older
// plain-text descriptions. The server cleans saved HTML too (lib/richText.ts).
// People are @mentioned as `<span data-mention-id="<userId>">@Name</span>`
// (the server emails them); plain text reads "@Name".
// ---------------------------------------------------------------------------

/** HTML from the editor (vs. a legacy plain-text description). */
export function isRichText(value: string | null | undefined): boolean {
  return Boolean(value && /<(p|br|strong|em|u|s|a|ul|ol|li|h[1-6]|blockquote|span)\b[^>]*>/i.test(value));
}

/** Plain text of a description (for counters and "is it empty?" checks). */
export function richTextPlain(value: string): string {
  if (!isRichText(value)) return value;
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(value);
  return (div.textContent ?? "").trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Editor value from a stored description: plain text becomes paragraphs. */
function toEditorHtml(value: string): string {
  if (!value) return "";
  if (isRichText(value)) return value;
  return value
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

const PROSE =
  "text-sm break-words text-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:min-h-[1lh] [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_[data-mention-id]]:rounded-sm [&_[data-mention-id]]:bg-primary/10 [&_[data-mention-id]]:px-0.5 [&_[data-mention-id]]:font-medium [&_[data-mention-id]]:text-primary";

/** An @mention: an inline, uneditable chip holding the user's id and name. */
const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-mention-id"),
        renderHTML: (attributes) => ({ "data-mention-id": attributes.id as string }),
      },
      label: {
        default: "",
        parseHTML: (element) => (element.textContent ?? "").replace(/^@/, ""),
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention-id]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), `@${node.attrs.label as string}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label as string}`;
  },
});

/** "@query" right before the caret (same trigger as comments). */
const TRIGGER = /(^|\s)@([^\s@]{0,30})$/;

interface MentionQuery {
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
}

/** Renders a description: formatted HTML (sanitised) or legacy plain text. */
export function RichText({ value, className }: { value: string; className?: string }) {
  const html = useMemo(() => {
    if (!isRichText(value)) return null;
    const clean = DOMPurify.sanitize(value, {
      ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "h2", "h3", "blockquote", "span"],
      ALLOWED_ATTR: ["href", "target", "rel", "style", "data-mention-id"],
    });
    // Links open in a new tab.
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer nofollow" ');
  }, [value]);
  if (html === null) {
    return <p className={cn("text-sm break-words whitespace-pre-wrap text-foreground", className)}>{value}</p>;
  }
  return <div className={cn(PROSE, "space-y-2", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40",
        active && "bg-accent text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function setLink(editor: Editor) {
  const previous = editor.getAttributes("link").href as string | undefined;
  const entered = window.prompt("Link address (https://…)", previous ?? "https://");
  if (entered === null) return;
  const url = entered.trim();
  if (!url || url === "https://") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  const href = /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`;
  if (editor.state.selection.empty && !editor.isActive("link")) {
    // No text selected: insert the address itself as the link text.
    editor.chain().focus().insertContent(`<a href="${escapeHtml(href)}">${escapeHtml(url)}</a> `).run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

/**
 * Description editor with a small toolbar. `value` / `onChange` are HTML
 * ("" when empty); a legacy plain-text value is loaded as paragraphs. With
 * `mentionUsers`, typing "@" suggests people and inserts a mention.
 */
export function RichTextEditor({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  disabled,
  mentionUsers,
}: {
  id?: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** People who can be @mentioned (omit to turn the picker off). */
  mentionUsers?: MentionableUser[];
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlighted, setHighlighted] = useState("");
  /** Picker keys (arrows / Enter / Tab / Escape), read by the editor's key handler. */
  const keyHandler = useRef<(event: KeyboardEvent) => boolean>(() => false);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Mention,
    ],
    content: toEditorHtml(value),
    editorProps: {
      handleKeyDown: (_view, event) => keyHandler.current(event),
      attributes: {
        ...(id ? { id } : {}),
        role: "textbox",
        "aria-multiline": "true",
        ...(placeholder ? { "aria-placeholder": placeholder, "data-placeholder": placeholder } : {}),
        class: cn(PROSE, "min-h-24 px-3 py-2 outline-none [&_p]:my-1"),
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.isEmpty ? "" : current.getHTML()),
  });

  // Watch for "@query" before the caret while mentions are on.
  const mentionsOn = Boolean(mentionUsers && mentionUsers.length > 0);
  useEffect(() => {
    if (!editor || !mentionsOn) {
      setMention(null);
      return;
    }
    const detect = () => {
      const { selection } = editor.state;
      const wrapper = wrapperRef.current;
      if (!selection.empty || !wrapper || !editor.isFocused) {
        setMention(null);
        return;
      }
      const { $from } = selection;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, undefined, "\ufffc");
      const match = TRIGGER.exec(before);
      if (!match) {
        setMention(null);
        return;
      }
      const from = $from.pos - match[2].length - 1;
      const coords = editor.view.coordsAtPos(from);
      const box = wrapper.getBoundingClientRect();
      setMention({
        query: match[2],
        from,
        to: $from.pos,
        left: Math.max(0, Math.min(coords.left - box.left, box.width - 288)),
        top: coords.bottom - box.top + 4,
      });
    };
    const close = () => setTimeout(() => setMention(null), 120);
    editor.on("update", detect);
    editor.on("selectionUpdate", detect);
    editor.on("blur", close);
    return () => {
      editor.off("update", detect);
      editor.off("selectionUpdate", detect);
      editor.off("blur", close);
    };
  }, [editor, mentionsOn]);

  const suggestions = useMemo(() => {
    if (!mention || !mentionUsers) return [];
    const q = mention.query.toLowerCase();
    return mentionUsers
      .filter((user) => user.name.toLowerCase().includes(q) || user.email.toLowerCase().startsWith(q))
      .slice(0, 6);
  }, [mention, mentionUsers]);
  const open = mention !== null && suggestions.length > 0;
  const listId = `${id ?? "rich-text"}-mentions`;
  const activeId = open ? (suggestions.find((user) => user._id === highlighted) ?? suggestions[0])._id : undefined;

  function insertMention(user: MentionableUser) {
    if (!editor || !mention) return;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: mention.from, to: mention.to }, [
        { type: "mention", attrs: { id: user._id, label: user.name } },
        { type: "text", text: " " },
      ])
      .run();
    setMention(null);
  }

  keyHandler.current = (event) => {
    if (!open) return false;
    const index = Math.max(0, suggestions.findIndex((user) => user._id === highlighted));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted(suggestions[(index + delta + suggestions.length) % suggestions.length]._id);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      insertMention(suggestions[index]);
      return true;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      setMention(null);
      return true;
    }
    return false;
  };

  // Reset the content when the form loads another value (open / switch task).
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current && toEditorHtml(value) !== current) editor.commands.setContent(toEditorHtml(value), { emitUpdate: false });
  }, [editor, value]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            link: e.isActive("link"),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            left: e.isActive({ textAlign: "left" }),
            center: e.isActive({ textAlign: "center" }),
            right: e.isActive({ textAlign: "right" }),
            empty: e.isEmpty,
          }
        : null,
  });

  return (
    <div>
      <div
        className={cn(
          "rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          invalid && "border-destructive ring-destructive/20"
        )}
      >
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
          <ToolbarButton label="Bold" active={state?.bold} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}>
            <LuBold aria-hidden className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Italic" active={state?.italic} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <LuItalic aria-hidden className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Underline" active={state?.underline} disabled={!editor} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
            <LuUnderline aria-hidden className="size-4" />
          </ToolbarButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton label={state?.link ? "Edit link" : "Add link"} active={state?.link} disabled={!editor} onClick={() => editor && setLink(editor)}>
            <LuLink aria-hidden className="size-4" />
          </ToolbarButton>
          {state?.link && (
            <ToolbarButton label="Remove link" onClick={() => editor?.chain().focus().extendMarkRange("link").unsetLink().run()}>
              <LuUnlink aria-hidden className="size-4" />
            </ToolbarButton>
          )}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton label="Bulleted list" active={state?.bullet} disabled={!editor} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            <LuList aria-hidden className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Numbered list" active={state?.ordered} disabled={!editor} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            <LuListOrdered aria-hidden className="size-4" />
          </ToolbarButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <ToolbarButton label="Align left" active={state?.left} disabled={!editor} onClick={() => editor?.chain().focus().setTextAlign("left").run()}>
            <LuAlignLeft aria-hidden className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Align centre" active={state?.center} disabled={!editor} onClick={() => editor?.chain().focus().setTextAlign("center").run()}>
            <LuAlignCenter aria-hidden className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Align right" active={state?.right} disabled={!editor} onClick={() => editor?.chain().focus().setTextAlign("right").run()}>
            <LuAlignRight aria-hidden className="size-4" />
          </ToolbarButton>
        </div>
        <div ref={wrapperRef} className="relative">
          {state?.empty && placeholder && (
            <p aria-hidden className="pointer-events-none absolute top-2 left-3 text-sm text-muted-foreground">
              {placeholder}
            </p>
          )}
          <EditorContent editor={editor} />
          {open && (
            <div
              className="absolute z-50 w-72 overflow-hidden rounded-lg shadow-md ring-1 ring-foreground/10"
              style={{ left: mention.left, top: mention.top }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Command shouldFilter={false} value={activeId} onValueChange={setHighlighted} className="rounded-lg!">
                <CommandList id={listId} aria-label="Mention suggestions">
                  <CommandGroup heading="Mention someone">
                    {suggestions.map((user) => (
                      <CommandItem key={user._id} id={`${listId}-${user._id}`} value={user._id} onSelect={() => insertMention(user)}>
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
        </div>
      </div>
      {mentionsOn && (
        <p className="mt-1 flex items-center gap-1 text-[0.7rem] text-muted-foreground">
          <LuAtSign aria-hidden className="size-3" />
          Type @ to mention someone (they get an email)
        </p>
      )}
    </div>
  );
}
