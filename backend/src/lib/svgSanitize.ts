// ---------------------------------------------------------------------------
// SVG sanitizer (no dependencies) — allowlist + re-serialization.
//
// The input is tokenized with a strict XML scanner and a brand-new document is
// written from scratch containing only allowlisted elements and attributes, so
// anything the scanner doesn't understand is dropped or the file is rejected:
//   - DOCTYPE / ENTITY / CDATA                         → rejected (XXE, entity bombs)
//   - malformed markup, mismatched tags, non-<svg> root → rejected
//   - elements not on the allowlist (script, style, foreignObject, image, a,
//     iframe, animate/set, metadata, …)                → dropped with their subtree
//   - on* handlers, unknown/namespaced attributes      → dropped
//   - href / xlink:href                                 → kept only as "#local-id"
//   - any value with javascript:/vbscript:/data: or a url(...) that is not url(#id)
//                                                       → attribute dropped
// Comments and processing instructions are removed. Text survives only inside
// title/desc/text/tspan and is re-escaped. Served additionally with
// CSP default-src 'none' + nosniff, and rendered by the UI through <img>.
// ---------------------------------------------------------------------------

export class SvgRejectedError extends Error {}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "symbol", "use",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern",
  "filter", "feBlend", "feColorMatrix", "feComposite", "feDropShadow", "feFlood",
  "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset",
]);

/** Elements whose text content is meaningful. */
const TEXT_ELEMENTS = new Set(["title", "desc", "text", "tspan"]);

const ALLOWED_ATTRIBUTES = new Set([
  // core / structure
  "id", "class", "viewBox", "preserveAspectRatio", "width", "height", "x", "y",
  "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points",
  "transform", "version", "xmlns", "xmlns:xlink", "xml:space", "lang", "xml:lang",
  "href", "xlink:href",
  // presentation
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "opacity", "color", "display", "visibility", "overflow",
  "clip-path", "clip-rule", "mask", "filter", "style",
  "stop-color", "stop-opacity", "offset",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline",
  "alignment-baseline", "baseline-shift", "text-decoration", "writing-mode",
  "dx", "dy", "rotate", "textLength", "lengthAdjust",
  "vector-effect", "shape-rendering", "paint-order", "mix-blend-mode", "isolation",
  "color-interpolation", "color-interpolation-filters",
  // gradients / patterns / masks / clip
  "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform",
  "maskUnits", "maskContentUnits", "clipPathUnits",
  // filters
  "filterUnits", "primitiveUnits", "in", "in2", "result", "stdDeviation", "mode",
  "type", "values", "operator", "k1", "k2", "k3", "k4", "radius",
  "flood-color", "flood-opacity", "edgeMode",
]);

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const ATTR = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      return String.fromCodePoint(code);
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ent] ?? "";
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ALLOWED_FUNCTIONS = new Set([
  "url", "rgb", "rgba", "hsl", "hsla", "calc", "var",
  "translate", "translatex", "translatey", "rotate", "scale", "scalex", "scaley",
  "matrix", "skewx", "skewy",
]);

/** True when a (decoded) attribute value could reference script or an external resource. */
function isDangerousValue(value: string): boolean {
  // CSS escapes (e.g. "\75 rl(...)") could disguise function names or schemes: refuse them.
  if (value.includes("\\")) return true;
  // Strip whitespace and control chars that browsers ignore inside schemes.
  const squashed = value.replace(/[\s\u0000-\u001f\u007f]+/g, "").toLowerCase();
  if (/(javascript|vbscript|data|livescript):/.test(squashed)) return true;
  if (/@import|expression|behavior:|-moz-binding/.test(squashed)) return true;
  // Only allowlisted CSS/transform functions; url(...) only for same-document fragments.
  for (const call of squashed.matchAll(/([a-z-]*)\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(call[1]!)) return true;
  }
  const urls = squashed.match(/url\([^)]*\)?/g) ?? [];
  return urls.some((u) => !/^url\(["']?#[a-z0-9_.:-]+["']?\)$/.test(u));
}

function sanitizeAttribute(element: string, name: string, rawValue: string): string | null {
  if (!ALLOWED_ATTRIBUTES.has(name)) return null;
  const value = decodeEntities(rawValue);
  if (name === "xmlns") return SVG_NS; // always the SVG namespace
  if (name === "xmlns:xlink") return XLINK_NS;
  if (name === "href" || name === "xlink:href") {
    // Only same-document references (e.g. <use href="#shape">, gradients).
    return /^#[A-Za-z0-9_.:-]+$/.test(value.trim()) ? value.trim() : null;
  }
  if (isDangerousValue(value)) return null;
  return value;
}

interface Frame {
  name: string;
  /** False when this element (or an ancestor) was dropped — its subtree is skipped. */
  kept: boolean;
}

/**
 * Returns a sanitized SVG document, or throws SvgRejectedError when the input is
 * not a well-formed, entity-free SVG we can safely rewrite.
 */
export function sanitizeSvg(input: Buffer | string): string {
  let src = typeof input === "string" ? input : input.toString("utf8");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.includes("\u0000") || src.includes("\ufffd")) throw new SvgRejectedError("SVG must be UTF-8 text");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(src)) {
    throw new SvgRejectedError("SVG with DOCTYPE, ENTITY or CDATA sections is not allowed");
  }

  const out: string[] = [];
  const stack: Frame[] = [];
  let sawRoot = false;
  let rootClosed = false;
  let i = 0;

  const fail = (why: string): never => {
    throw new SvgRejectedError(`Invalid SVG: ${why}`);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > i) {
      const text = src.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (!top) {
        if (text.trim()) fail("text outside the root element");
      } else if (top.kept && TEXT_ELEMENTS.has(top.name)) {
        out.push(escapeXml(decodeEntities(text)));
      } else if (top.kept && !text.trim()) {
        out.push(text.replace(/[^\s]/g, "")); // keep indentation whitespace only
      }
      i = textEnd;
      continue;
    }

    // Comments and processing instructions (<?xml …?>) are removed.
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) fail("unsupported declaration");

    // Closing tag
    if (src.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(src);
      if (!m) fail("bad closing tag");
      const name = m![0];
      let j = NAME.lastIndex;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] !== ">") fail(`bad closing tag </${name}>`);
      const frame = stack.pop();
      if (!frame || frame.name !== name) fail(`mismatched </${name}>`);
      if (frame!.kept) out.push(`</${name}>`);
      if (stack.length === 0) rootClosed = true;
      i = j + 1;
      continue;
    }

    // Opening / self-closing tag
    NAME.lastIndex = i + 1;
    const m = NAME.exec(src);
    if (!m) fail("bad tag");
    const name = m![0];
    let j = NAME.lastIndex;
    const attrs: [string, string][] = [];
    for (;;) {
      ATTR.lastIndex = j;
      const a = ATTR.exec(src);
      if (!a) break;
      attrs.push([a[1]!, a[2] ?? a[3] ?? ""]);
      j = ATTR.lastIndex;
    }
    while (j < src.length && /\s/.test(src[j]!)) j++;
    let selfClosing = false;
    if (src[j] === "/") {
      selfClosing = true;
      j++;
    }
    if (src[j] !== ">") fail(`malformed <${name}> tag`);
    i = j + 1;

    if (stack.length === 0) {
      if (sawRoot || rootClosed) fail("multiple root elements");
      if (name !== "svg") fail("root element must be <svg>");
      sawRoot = true;
    }

    const parentKept = stack.length === 0 || stack[stack.length - 1]!.kept;
    const kept = parentKept && ALLOWED_ELEMENTS.has(name);

    if (kept) {
      const seen = new Set<string>();
      const parts: string[] = [name];
      for (const [attrName, raw] of attrs) {
        if (seen.has(attrName)) fail(`duplicate attribute ${attrName}`);
        seen.add(attrName);
        const clean = sanitizeAttribute(name, attrName, raw);
        if (clean !== null) parts.push(`${attrName}="${escapeXml(clean)}"`);
      }
      if (stack.length === 0 && !seen.has("xmlns")) parts.push(`xmlns="${SVG_NS}"`);
      out.push(`<${parts.join(" ")}${selfClosing ? "/>" : ">"}`);
    }

    if (!selfClosing) stack.push({ name, kept });
    else if (stack.length === 0) rootClosed = true;
  }

  if (!sawRoot) fail("no <svg> element");
  if (stack.length > 0) fail(`unclosed <${stack[stack.length - 1]!.name}>`);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${out.join("")}`;
}
