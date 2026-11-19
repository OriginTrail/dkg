// @ts-check
// Reads an HTML mock-up once: its opening tags with their attributes, and the bodies of
// its <style> blocks, each with where it is in the file. Comments are masked first, so
// commented-out markup isn't read and every offset stays where it was. Both the
// declaration reader (scripts/design-rules.mjs: style attributes and <style> blocks) and
// the component rules (scripts/design-core.mjs) read HTML through this, and nothing else.
// Checked by tsc (tsconfig.type-tests.json).

/** An attribute's value and the offset in the file where the value starts ('' when bare). @typedef {{ value: string, start: number }} HtmlAttr */
/**
 * An opening tag: its lower-case name, where it starts, how it's written, and its
 * attributes by lower-case name.
 * @typedef {{ name: string, index: number, source: string, attrs: Map<string, HtmlAttr> }} HtmlTag
 */
/** A <style> block's CSS and where it starts in the file. @typedef {{ css: string, start: number }} HtmlStyle */
/** @typedef {{ tags: HtmlTag[], styles: HtmlStyle[] }} HtmlDocument */

/** HTML without its comments, each replaced by spaces so every offset and line stays where it was. @param {string} html @returns {string} */
export const maskHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));

// One attribute: a name, then optionally `=` (with HTML's optional spaces) and a value in
// double quotes, single quotes or none. Quoted values may hold any character, `>` too.
const ATTR = String.raw`([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?`;
const TAG = new RegExp(String.raw`<([a-z][\w-]*)((?:\s+${ATTR})*)\s*\/?>`, 'gi');
const ATTRS = new RegExp(ATTR, 'gd');

/**
 * Every opening tag and <style> block in an HTML document, outside its comments.
 * @param {string} html
 * @returns {HtmlDocument}
 */
export function readHtml(html) {
  const source = maskHtmlComments(html);
  /** @type {HtmlTag[]} */
  const tags = [];
  /** @type {HtmlStyle[]} */
  const styles = [];
  for (const m of source.matchAll(TAG)) {
    const index = m.index ?? 0;
    const attrsAt = index + 1 + m[1].length;
    /** @type {Map<string, HtmlAttr>} */
    const attrs = new Map();
    for (const a of m[2].matchAll(ATTRS)) {
      const group = a[2] !== undefined ? 2 : a[3] !== undefined ? 3 : a[4] !== undefined ? 4 : 0;
      const span = group ? a.indices?.[group] : undefined;
      attrs.set(a[1].toLowerCase(), { value: group ? a[group] : '', start: attrsAt + (span ? span[0] : (a.index ?? 0)) });
    }
    const name = m[1].toLowerCase();
    tags.push({ name, index, source: m[0], attrs });
    if (name === 'style') {
      const start = index + m[0].length;
      const close = source.slice(start).search(/<\/style\s*>/i);
      styles.push({ css: source.slice(start, close === -1 ? source.length : start + close), start });
    }
  }
  return { tags, styles };
}
