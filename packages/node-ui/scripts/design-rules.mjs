// @ts-check
// The design rules both the checks and the design check apply: how a declaration is
// found in a file, and which literal values in it fall under a rule. Policy lives
// here once. test/layout-tokens.test.ts fails on any value a rule finds, and
// scripts/design-suggest.mjs turns each one into a suggestion (the token to use, or
// that the system needs a new one). The JSDoc types are checked: tsconfig.type-tests.json
// runs tsc with checkJs over this file.
import { CssReadError, cssDeclarations } from './css.mjs';
import { literalWords, parseValue, readValue, varRefs } from './css-value.mjs';
import { readHtml } from './html.mjs';
import { attrText, attrsOf, classNames, opening, parseTsx, styleDeclarations, tagName, walkJsx } from './jsx.mjs';

/** @typedef {import('./jsx.mjs').Declaration} Declaration */
/**
 * An element as the component rules see it, from HTML or from JSX: its tag name, where
 * it starts, its classes and its attributes (a string, '' when bare, null when set at
 * runtime). `source` is how it's written, for the report.
 * @typedef {{ name: string, source: string, index: number, classes: string[], attrs: Map<string, string | null> }} Tag
 */
/**
 * A file read once, for both rule families: its declarations (in line order) and the
 * elements it draws (HTML tags, or lower-case JSX elements; none in a stylesheet).
 * @typedef {{ declarations: Declaration[], tags: Tag[] }} SourceDocument
 */

/**
 * A literal value a rule covers. Each kind carries what its rule needs: `n` is the
 * number on the rule's scale (px, or ms for motion) wherever there is one.
 * @typedef {{ kind: 'corner', value: string, n: number }} CornerHit        a border radius in px
 * @typedef {{ kind: 'corner', value: string, pill: true }} PillHit        a corner of 100px or more: the pill token
 * @typedef {{ kind: 'corner', value: string, unit: true }} CornerUnitHit  a radius in another length unit (rem, em, vw …)
 * @typedef {{ kind: 'spacing', value: string, n: number, up: boolean }} SpacingHit  `up` on padding: ties round up
 * @typedef {{ kind: 'spacing', value: string, unit: true }} SpacingUnitHit a space in another length unit
 * @typedef {{ kind: 'type size', value: string, n: number }} TypeSizeHit  a size in px
 * @typedef {{ kind: 'type size', value: string, unit: true }} TypeUnitHit a size in another unit (em, rem, pt, vw, % …)
 * @typedef {{ kind: 'weight', value: string }} WeightHit                 a numeric weight off WEIGHTS
 * @typedef {{ kind: 'line height' | 'layer' | 'height' | 'motion', value: string, n: number }} ScaleHit
 * @typedef {CornerHit | PillHit | CornerUnitHit | SpacingHit | SpacingUnitHit | TypeSizeHit | TypeUnitHit | WeightHit | ScaleHit} Hit
 * @typedef {Hit['kind']} Kind
 */

/** Font weights the type scale uses (DESIGN.md · Type). */
export const WEIGHTS = ['400', '500', '600', '700'];
/** Layers up to this sit in a component's own stacking; above it, use a --z-* token. */
export const LAYER_FREE_MAX = 10;
/** Durations at or under this are reduced-motion overrides, not timings. */
export const MOTION_FREE_MS = 0.5;

/**
 * A length in a unit other than px, whose size the scales (all in px) can't check: rem
 * and em, print units, viewport and container units, ch, ex and the like. Percentages
 * aren't here: a % corner is a circle and a % space is layout.
 */
const OTHER_LENGTH = /^(-?\d*\.?\d+)(rem|em|pt|pc|in|cm|mm|q|vw|vh|vi|vb|vmin|vmax|[sld]v[whib]|cq[whib]|cqmin|cqmax|ch|ex|cap|ic|r?lh)$/i;

/** Most values one declaration is checked with, when its variables have several definitions. */
const MAX_CANDIDATES = 16;

/**
 * The values a declaration can have once a mock-up's own variables are put in, so
 * `gap: var(--gap)` with `--gap: 10px` is checked as a 10px gap. A definition in the
 * declaration's own scope (the same rule, or the same style attribute) is the one that
 * applies. Without one, the value can come from any other definition, so each is
 * checked. A definition's own references are resolved where it's defined, as CSS
 * computes them: with `:root { --gap: 10px; --pad: var(--gap) }`, `.a { --gap: 8px; padding: var(--pad) }`
 * is 10px. Variables with no definition, and loops between them, are left as they are.
 * @param {string} value
 * @param {Map<string, { value: string, scope: number }[]>} defs every definition of each variable
 * @param {number} scope the declaration's scope
 * @returns {string[]} distinct values, `value` itself when nothing resolves
 */
export function resolveVars(value, defs, scope) {
  return resolveVarsFrom(value, defs, scope).map((c) => c.value);
}

/**
 * resolveVars, with the definitions each value was built from (aliases included), so a
 * caller can tell which definitions a value depends on: --changed reports a use at the
 * changed definition it reads. A value reached from several definitions lists them all.
 * @template {{ value: string, scope: number }} D
 * @param {string} value
 * @param {Map<string, D[]>} defs
 * @param {number} scope
 * @returns {{ value: string, from: D[] }[]}
 */
export function resolveVarsFrom(value, defs, scope) {
  /** Distinct values, merging where each came from. @param {{ value: string, from: D[] }[]} list */
  const distinct = (list) => {
    /** @type {Map<string, Set<D>>} */
    const by = new Map();
    for (const c of list) {
      const from = by.get(c.value) ?? new Set();
      for (const d of c.from) from.add(d);
      by.set(c.value, from);
    }
    return [...by].map(([v, from]) => ({ value: v, from: [...from] }));
  };
  /** The definitions that can apply in a scope. @param {string} name @param {number} at */
  const options = (name, at) => {
    const all = defs.get(name) ?? [];
    const local = all.filter((d) => d.scope === at);
    /** @type {Set<string>} */
    const seen = new Set();
    return (local.length ? local : all).filter((d) => {
      const key = `${d.scope}|${d.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  /**
   * @param {string} text
   * @param {number} at the scope its references are resolved in
   * @param {Set<string>} open variables being resolved further out, so a loop stops
   * @returns {{ value: string, from: D[] }[]}
   */
  const resolve = (text, at, open) => {
    const refs = varRefs(parseValue(text)).filter((r) => !open.has(r.name) && options(r.name, at).length);
    // The outermost references: one inside another's fallback is replaced with it.
    const outer = refs.filter((r) => !refs.some((o) => o !== r && o.node.start <= r.node.start && r.node.end <= o.node.end));
    if (!outer.length) return [{ value: text, from: [] }];
    /** @type {{ value: string, from: D[] }[]} */
    let results = [{ value: '', from: [] }];
    let last = 0;
    for (const r of outer) {
      /** @type {{ value: string, from: D[] }[]} */
      const values = [];
      for (const d of options(r.name, at)) {
        for (const v of resolve(d.value, d.scope, new Set([...open, r.name]))) values.push({ value: v.value, from: [d, ...v.from] });
      }
      const before = text.slice(last, r.node.start);
      results = distinct(results.flatMap((p) => distinct(values).map((v) => ({ value: p.value + before + v.value, from: [...p.from, ...v.from] })))).slice(0, MAX_CANDIDATES);
      last = r.node.end;
    }
    return results.map((p) => ({ value: p.value + text.slice(last), from: p.from }));
  };
  return distinct(resolve(value, scope, new Set())).slice(0, MAX_CANDIDATES);
}

/** The line each character index is on, from 1. @param {string} text @returns {(index: number) => number} */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/**
 * Every declaration in a file, in line order, where line and endLine are the lines
 * its property and value span and scope says which rule, style attribute or JSX
 * element it belongs to: CSS (read by scripts/css.mjs), an HTML mock-up's <style>
 * blocks and style attributes (found by scripts/html.mjs, outside its comments), and
 * JSX style objects (read by scripts/jsx.mjs).
 * @param {string} text
 * @param {string} ext the file's extension, with its dot
 * @returns {Declaration[]}
 * @throws {import('./css.mjs').CssReadError} when a stylesheet or style block can't be read
 */
export function declarations(text, ext) {
  return readSource(text, ext).declarations;
}

/**
 * A file read once: its declarations (as `declarations` describes them) and its elements,
 * so the declaration rules and the component rules work from the same reading. HTML is
 * read by scripts/html.mjs, JSX parsed once by scripts/jsx.mjs. A capitalised JSX
 * component (<Button>) is a system part already, so it isn't a tag here.
 * @param {string} text
 * @param {string} ext the file's extension, with its dot
 * @returns {SourceDocument}
 * @throws {import('./css.mjs').CssReadError} when a stylesheet or style block can't be read
 */
export function readSource(text, ext) {
  const lineAt = lineIndex(text);
  /** @type {Declaration[]} */
  const out = [];
  /**
   * @param {string} css
   * @param {number} offset where `css` starts in the file
   * @param {number} [rootScope]
   * @param {(index: number) => number} [at] where character i of `css` is in the file, when `css` isn't a plain slice of it (a decoded attribute)
   */
  const cssIn = (css, offset, rootScope, at) => {
    const place = at ?? ((i) => offset + i);
    let found;
    try {
      found = cssDeclarations(css, 0, rootScope);
    } catch (error) {
      if (error instanceof CssReadError) throw new CssReadError(error.reason, place(error.index));
      throw error;
    }
    for (const d of found) {
      // A rule's scope is an offset in `css`; put it where the rule is in the file.
      const scope = d.scope === (rootScope ?? -1) ? d.scope : place(d.scope);
      out.push({ prop: d.prop, value: d.value, line: lineAt(place(d.start)), endLine: lineAt(place(d.end)), scope });
    }
  };
  /** @type {Tag[]} */
  const tags = [];
  if (ext === '.css') { cssIn(text, 0); return { declarations: out, tags }; }
  if (ext === '.tsx' || ext === '.jsx') {
    const tree = parseTsx(text, `inline${ext}`);
    out.push(...styleDeclarations(tree));
    walkJsx(tree, (node) => {
      const name = tagName(node);
      if (!/^[a-z]/.test(name)) return;
      /** @type {Map<string, string | null>} */
      const attrs = new Map();
      for (const [key, attr] of attrsOf(node)) attrs.set(key, attrText(attr));
      tags.push({ name, source: opening(node).getText(tree), index: node.getStart(tree), classes: classNames(node), attrs });
    });
  } else {
    const doc = readHtml(text);
    for (const style of doc.styles) cssIn(style.css, style.start);
    for (const tag of doc.tags) {
      // A style attribute's declarations share one scope: the attribute's own. The value is
      // read as the browser reads it, with character references decoded.
      const style = tag.attrs.get('style');
      if (style) cssIn(style.value, style.start, style.start, style.offsetAt);
      /** @type {Map<string, string | null>} */
      const attrs = new Map([...tag.attrs].map(([k, a]) => [k, a.value]));
      tags.push({ name: tag.name, source: tag.source, index: tag.index, classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean), attrs });
    }
  }
  return { declarations: out.sort((a, b) => a.line - b.line), tags };
}

/**
 * The literal values in one declaration that a rule covers, with the rule's
 * exceptions applied. Values inside var() are tokens and aren't returned;
 * literals beside them are.
 *
 *   corner       border radius in px (0 aside), a pill (any corner of 100px or more), or one in another unit (% aside)
 *   spacing      padding, margin and gap over 1px (negative margins aside), or one in another unit (% aside)
 *   type size    font-size, and the size in a `font` shorthand, in px or another unit (1em aside)
 *   weight       a numeric weight off WEIGHTS
 *   line height  a unitless line height other than 0 and 1
 *   layer        a z-index over LAYER_FREE_MAX
 *   height       height and min-height in px (a control height only if it matches one)
 *   motion       a transition duration or delay over MOTION_FREE_MS, in ms
 *
 * @param {string} prop
 * @param {string | import('./css-value.mjs').ParsedValue} value the value as written, or
 *   already read by readValue (without !important), so it's read once
 * @returns {Hit[]}
 */
export function classify(prop, value) {
  const p = prop.toLowerCase();
  const { text: v, nodes: tree } = typeof value === 'string' ? readValue(value.replace(/!important/, '').trim()) : value;
  // The words the value says itself: var() is a token, so `var(--space-4) 10px` is checked as 10px.
  const words = literalWords(tree);
  /** @param {RegExp} re */
  const numbers = (re) => words.map((w) => re.exec(w)).filter((m) => m !== null).map((m) => Number(m[1]));
  const px = () => numbers(/^(-?\d*\.?\d+)px$/i);
  // Lengths in other units, zero aside (0rem is 0 in any unit).
  const others = () => words.filter((w) => OTHER_LENGTH.test(w) && parseFloat(w) !== 0);
  /** @type {Hit[]} */
  const out = [];
  if (/^border(-[a-z]+)*-radius$/.test(p)) {
    for (const n of px()) if (n !== 0 && n < 100) out.push({ kind: 'corner', value: `${n}px`, n });
    // A corner of 100px or more rounds any control into a pill: that's --radius-pill.
    if (px().some((n) => n >= 100)) out.push({ kind: 'corner', value: v, pill: true });
    for (const w of others()) out.push({ kind: 'corner', value: w, unit: true });
  } else if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/.test(p)) {
    for (const n of px()) if (n > 1) out.push({ kind: 'spacing', value: `${n}px`, n, up: p.startsWith('padding') });
    // Negative margins pull back by a known amount in any unit, as in px.
    for (const w of others()) if (parseFloat(w) > 0) out.push({ kind: 'spacing', value: w, unit: true });
  } else if (p === 'font') {
    // The shorthand is `[style] [weight] size[/line-height] family`. The size is the term just
    // before the "/", or with no "/" the first length or function (`var(--fs-*)`, `calc()`).
    // Only that term is a type size: a px line height after the "/" is not one.
    const slash = tree.findIndex((n) => n.type === 'div' && n.value === '/');
    const before = (slash === -1 ? tree : tree.slice(0, slash)).filter((n) => n.type !== 'space');
    const size = slash === -1
      ? before.find((n) => n.type === 'function' || (n.type === 'word' && /^-?\d*\.?\d+[a-z%]+$/i.test(n.value)))
      : before[before.length - 1];
    // Checked as font-size would check it: a word, or a function such as calc() or clamp()
    // by the literals inside it (a var() is a token, so it adds nothing).
    // The size's own text is read again, so its tree and text agree.
    if (size && (size.type === 'word' || size.type === 'function')) out.push(...classify('font-size', readValue(v.slice(size.start, size.end))));
    // The weight (a number before the size) and line height (after the "/") follow the
    // same rules as font-weight and line-height.
    const weight = before.find((n) => n !== size && n.type === 'word' && /^\d+$/.test(n.value));
    if (weight) out.push(...classify('font-weight', weight.value));
    const lineHeight = slash === -1 ? undefined : tree.slice(slash + 1).find((n) => n.type !== 'space');
    if (lineHeight && lineHeight.type === 'word') out.push(...classify('line-height', lineHeight.value));
  } else if (p === 'font-size') {
    for (const n of px()) out.push({ kind: 'type size', value: `${n}px`, n });
    // 1em is the parent's own size; anything else relative or in another unit can't be checked.
    for (const w of words.filter((x) => /^-?\d*\.?\d+[a-z%]+$/i.test(x))) {
      if ((OTHER_LENGTH.test(w) || w.endsWith('%')) && parseFloat(w) !== 0 && w.toLowerCase() !== '1em') out.push({ kind: 'type size', value: w, unit: true });
    }
  } else if (p === 'font-weight') {
    if (/^\d+$/.test(v) && !WEIGHTS.includes(v)) out.push({ kind: 'weight', value: v });
  } else if (p === 'line-height') {
    const n = Number(v);
    if (v && !Number.isNaN(n) && n !== 1 && n !== 0) out.push({ kind: 'line height', value: v, n });
  } else if (p === 'z-index') {
    const n = Number(v);
    if (n > LAYER_FREE_MAX) out.push({ kind: 'layer', value: v, n });
  } else if (/^(height|min-height)$/.test(p)) {
    for (const n of px()) out.push({ kind: 'height', value: `${n}px`, n });
  } else if (/^transition(-duration|-delay)?$/.test(p)) {
    // Transitions only: a looping animation (a spinner, a pulse) has its own length.
    for (const m of words.map((w) => /^(\d*\.?\d+)(m?s)$/i.exec(w)).filter((x) => x !== null)) {
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (ms > MOTION_FREE_MS) out.push({ kind: 'motion', value: m[0], n: ms });
    }
  }
  return out;
}
