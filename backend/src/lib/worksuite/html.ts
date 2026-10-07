// ---------------------------------------------------------------------------
// Worksuite rich text (Quill HTML) → plain text with line breaks.
// - block elements (p, div, h1-6, li, blockquote, pre, tr) end with a newline
// - <br> is a newline; list items get "• " / "1. " prefixes
// - <a href="url">text</a> → "text (url)" (just "url" when the text is the URL)
// - Quill mention spans (<span class="mention" …>@Name</span>) become "@Name"
// - images are dropped (data: URIs would blow the length limits); an <img> with
//   an http(s) src becomes "[image: url]"
// - scripts/styles are removed with their content; entities are decoded
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  times: "×",
  laquo: "«",
  raquo: "»",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "tr",
  "table",
  "section",
  "article",
  "header",
  "footer",
  "ul",
  "ol",
]);

/** Converts Worksuite HTML to readable plain text. Plain text input passes through (entities decoded). */
export function htmlToText(input: string | null | undefined): string {
  if (!input) return "";
  let html = String(input);
  if (!/[<&]/.test(html)) return normalizeWhitespace(html);

  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<(script|style|iframe)\b[\s\S]*?<\/\1\s*>/gi, "");

  let out = "";
  const listStack: Array<{ ordered: boolean; n: number }> = [];
  const linkStack: Array<{ href: string | null; start: number }> = [];

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    out += decodeEntities(html.slice(last, m.index).replace(/[\r\n\t]+/g, " "));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const whole = m[0];

    if (name === "br") {
      out += "\n";
      continue;
    }
    if (name === "img") {
      const src = attr(whole, "src");
      if (src && /^https?:\/\//i.test(src)) out += ` [image: ${src}] `;
      continue;
    }
    if (name === "a") {
      if (!closing) {
        linkStack.push({ href: attr(whole, "href"), start: out.length });
      } else {
        const link = linkStack.pop();
        if (link?.href && /^(https?:|mailto:)/i.test(link.href)) {
          const text = out.slice(link.start).trim();
          const href = link.href.replace(/^mailto:/i, "");
          if (!text) out += href;
          else if (text !== href && text !== link.href && !text.includes(href)) out += ` (${href})`;
        }
      }
      continue;
    }
    if (name === "ul" || name === "ol") {
      if (!closing) listStack.push({ ordered: name === "ol", n: 0 });
      else listStack.pop();
      out += "\n";
      continue;
    }
    if (name === "li") {
      if (!closing) {
        const list = listStack[listStack.length - 1];
        const depth = Math.max(0, listStack.length - 1);
        if (!out.endsWith("\n") && out.length) out += "\n";
        out += "  ".repeat(depth);
        if (list?.ordered) out += `${++list.n}. `;
        else out += "• ";
      } else {
        out += "\n";
      }
      continue;
    }
    if (name === "td" || name === "th") {
      if (closing) out += "\t";
      continue;
    }
    if (BLOCK_TAGS.has(name)) {
      if (closing) out += "\n";
      else if (out.length && !out.endsWith("\n")) out += "\n";
      continue;
    }
    // Inline tags (span, strong, em, u, s, sup, font, code …) are dropped.
  }
  out += decodeEntities(html.slice(last).replace(/[\r\n\t]+/g, " "));
  return normalizeWhitespace(out);
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/[​﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, (ws) => (ws.includes("\t") ? "\t" : " ")).trimEnd().replace(/^ (?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cuts `text` to `max` characters, ending with "…" when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
