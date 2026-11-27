// @ts-check
// Reads an HTML mock-up once: its opening tags with their attributes, and the bodies of
// its <style> blocks, each with where it is in the file. Comments in markup are skipped,
// so commented-out markup isn't read; `<!--` in raw text (a script, a style) is text. Both the
// declaration reader (scripts/design-rules.mjs: style attributes and <style> blocks) and
// the component rules (scripts/design-core.mjs) read HTML through this, and nothing else.
// Attribute values are decoded as a browser decodes them (`ds&#45;btn` is ds-btn), with
// a map back to where each character is in the file. Checked by tsc (tsconfig.type-tests.json).
import { decodeHTMLAttribute } from 'entities';

/**
 * An attribute: its value as the browser reads it, with character references decoded
 * ('' when bare), where the value starts in the file, and `offsetAt(i)`, the file offset
 * of the decoded value's character i.
 * @typedef {{ value: string, start: number, offsetAt: (index: number) => number }} HtmlAttr
 */
/**
 * An opening tag: its lower-case name, where it starts, how it's written, and its
 * attributes by lower-case name.
 * @typedef {{ name: string, index: number, source: string, attrs: Map<string, HtmlAttr> }} HtmlTag
 */
/** A <style> block's CSS and where it starts in the file. @typedef {{ css: string, start: number }} HtmlStyle */
/** @typedef {{ tags: HtmlTag[], styles: HtmlStyle[] }} HtmlDocument */

// One attribute: a name, then optionally `=` (with HTML's optional spaces) and a value in
// double quotes, single quotes or none. Quoted values may hold any character, `>` too.
const ATTR = String.raw`([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?`;
const TAG = new RegExp(String.raw`<([a-z][\w-]*)((?:\s+${ATTR})*)\s*\/?>`, 'gi');
const ATTRS = new RegExp(ATTR, 'gd');
/**
 * An attribute value with its character references decoded, and the offset in `raw` of
 * each decoded character (one past the end included), so positions in the decoded value
 * can be traced back. A reference that isn't one (`&copy=` in an attribute) is left as written.
 * @param {string} raw
 * @returns {{ value: string, rawAt: number[] }}
 */
export function decodeAttribute(raw) {
  let value = '';
  /** @type {number[]} */
  const rawAt = [];
  let last = 0;
  for (const m of raw.matchAll(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);?/gi)) {
    const at = m.index ?? 0;
    for (let i = last; i < at; i++) { value += raw[i]; rawAt.push(i); }
    // Decode with the character after it, which decides legacy references in attributes.
    const next = raw[at + m[0].length] ?? '';
    const decoded = decodeHTMLAttribute(m[0] + next);
    const text = next && decoded.endsWith(next) ? decoded.slice(0, -next.length) : decoded;
    for (const ch of text) { value += ch; rawAt.push(at); }
    last = at + m[0].length;
  }
  for (let i = last; i < raw.length; i++) { value += raw[i]; rawAt.push(i); }
  rawAt.push(raw.length);
  return { value, rawAt };
}

/** Elements whose content is raw or escapable text, never elements (HTML's raw text and escapable raw text elements). */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/**
 * Every opening tag and <style> block in an HTML document, outside its comments.
 * @param {string} html
 * @returns {HtmlDocument}
 */
export function readHtml(html) {
  const source = html;
  /** @type {HtmlTag[]} */
  const tags = [];
  /** @type {HtmlStyle[]} */
  const styles = [];
  // Elements whose body is text, not markup: a `<button>` written inside a textarea, a
  // script string or a CSS `content` value is text, so reading skips to the closing tag.
  // A <style> body is still read, as CSS.
  // Comments are skipped as they're reached in markup, so `<!--` inside a script, a <style>
  // body or a quoted attribute is text there, not the start of a comment.
  const tagAt = new RegExp(TAG.source, 'gi');
  for (;;) {
    const from = tagAt.lastIndex;
    const m = tagAt.exec(source);
    if (!m) break;
    const comment = source.indexOf('<!--', from);
    if (comment !== -1 && comment < m.index) {
      const close = source.indexOf('-->', comment + 4);
      tagAt.lastIndex = close === -1 ? source.length : close + 3;
      continue;
    }
    const index = m.index;
    const attrsAt = index + 1 + m[1].length;
    /** @type {Map<string, HtmlAttr>} */
    const attrs = new Map();
    for (const a of m[2].matchAll(ATTRS)) {
      const group = a[2] !== undefined ? 2 : a[3] !== undefined ? 3 : a[4] !== undefined ? 4 : 0;
      const span = group ? a.indices?.[group] : undefined;
      const start = attrsAt + (span ? span[0] : (a.index ?? 0));
      const { value, rawAt } = decodeAttribute(group ? a[group] : '');
      attrs.set(a[1].toLowerCase(), { value, start, offsetAt: (i) => start + (rawAt[Math.min(Math.max(i, 0), rawAt.length - 1)] ?? 0) });
    }
    const name = m[1].toLowerCase();
    tags.push({ name, index, source: m[0], attrs });
    if (RAW_TEXT.has(name) && !m[0].endsWith('/>')) {
      const start = index + m[0].length;
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(start));
      const end = close ? start + close.index : source.length;
      if (name === 'style') styles.push({ css: source.slice(start, end), start });
      tagAt.lastIndex = close ? end + close[0].length : source.length;
    }
  }
  return { tags, styles };
}
