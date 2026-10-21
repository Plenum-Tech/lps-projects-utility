import sanitizeHtml from "sanitize-html";

// ---------------------------------------------------------------------------
// Task descriptions can be formatted (bold, italic, underline, links, lists,
// text alignment) — stored as HTML from the editor. Older descriptions are
// plain text. Saved HTML is cleaned to this allowlist; plain-text consumers
// (AI brief check, emails, Delivery Pulse) read `richTextToPlain`.
// People are @mentioned as `<span data-mention-id="<userId>">@Name</span>`, so
// plain-text readers see "@Name".
// ---------------------------------------------------------------------------

/** True when the value is HTML from the rich editor (not legacy plain text). */
export function isRichText(value: string | null | undefined): boolean {
  return Boolean(value && /<(p|br|strong|em|u|s|a|ul|ol|li|h[1-6]|blockquote|span)\b[^>]*>/i.test(value));
}

const ALIGN = /^(left|center|right|justify)$/;
const USER_ID = /^[a-f0-9]{24}$/i;
const MENTION_ATTR = /<span\b[^>]*\bdata-mention-id="([a-f0-9]{24})"/gi;

/** Cleans editor HTML to the allowed formatting; plain text is returned as is. */
export function sanitizeRichText(value: string): string {
  if (!isRichText(value)) return value;
  return sanitizeHtml(value, {
    allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "h2", "h3", "blockquote", "span"],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      p: ["style"],
      h2: ["style"],
      h3: ["style"],
      li: ["style"],
      span: ["data-mention-id"],
    },
    allowedStyles: { "*": { "text-align": [ALIGN] } },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }),
      // A mention keeps only a valid user id.
      span: (tagName, input) => {
        const id = input["data-mention-id"] ?? "";
        const attribs: sanitizeHtml.Attributes = USER_ID.test(id) ? { "data-mention-id": id.toLowerCase() } : {};
        return { tagName, attribs };
      },
    },
  }).trim();
}

/** User ids @mentioned in a description (unique, in order). */
export function richTextMentionIds(value: string | null | undefined): string[] {
  if (!value || !isRichText(value)) return [];
  const ids = new Set<string>();
  for (const match of value.matchAll(MENTION_ATTR)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}

/** Plain text of a description (links kept as "text (url)"), for AI, emails and reports. */
export function richTextToPlain(value: string | null | undefined): string {
  if (!value) return "";
  if (!isRichText(value)) return value;
  const withLinks = value.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, "").trim();
    return label && label !== href ? `${label} (${href})` : href;
  });
  const text = sanitizeHtml(
    withLinks
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• "),
    { allowedTags: [], allowedAttributes: {} }
  );
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
