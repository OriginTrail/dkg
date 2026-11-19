// @ts-check
// The design rules both the checks and the design check apply: how a declaration is
// found in a file, and which literal values in it fall under a rule. Policy lives
// here once. test/layout-tokens.test.ts fails on any value a rule finds, and
// scripts/design-suggest.mjs turns each one into a suggestion (the token to use, or
// that the system needs a new one). The JSDoc types are checked: tsconfig.type-tests.json
// runs tsc with checkJs over this file.
import { CssReadError, cssDeclarations } from './css.mjs';
import { maskHtmlComments, readHtml } from './html.mjs';
import { styleDeclarations } from './jsx.mjs';

/** @typedef {import('./jsx.mjs').Declaration} Declaration */

/**
 * A literal value a rule covers. Each kind carries what its rule needs: `n` is the
 * number on the rule's scale (px, or ms for motion) wherever there is one.
 * @typedef {{ kind: 'corner', value: string, n: number }} CornerHit        a border radius in px
 * @typedef {{ kind: 'corner', value: string, pill: true }} PillHit        a 999px corner: the pill token
 * @typedef {{ kind: 'spacing', value: string, n: number, up: boolean }} SpacingHit  `up` on padding: ties round up
 * @typedef {{ kind: 'type size', value: string, n: number }} TypeSizeHit  a size in px
 * @typedef {{ kind: 'type size', value: string, unit: true }} TypeUnitHit a size in em, rem or pt
 * @typedef {{ kind: 'weight', value: string }} WeightHit                 a numeric weight off WEIGHTS
 * @typedef {{ kind: 'line height' | 'layer' | 'height' | 'motion', value: string, n: number }} ScaleHit
 * @typedef {CornerHit | PillHit | SpacingHit | TypeSizeHit | TypeUnitHit | WeightHit | ScaleHit} Hit
 * @typedef {Hit['kind']} Kind
 */

/** Font weights the type scale uses (DESIGN.md · Type). */
export const WEIGHTS = ['400', '500', '600', '700'];
/** Layers up to this sit in a component's own stacking; above it, use a --z-* token. */
export const LAYER_FREE_MAX = 10;
/** Durations at or under this are reduced-motion overrides, not timings. */
export const MOTION_FREE_MS = 0.5;

export { maskHtmlComments };

const VAR = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g;

/** A value with its var() expressions taken out, so the literals beside a token are still checked. @param {string} value @returns {string} */
export const literals = (value) => value.replace(VAR, ' ');

/** Most values one declaration is checked with, when its variables have several definitions. */
const MAX_CANDIDATES = 16;

/**
 * The values a declaration can have once a mock-up's own variables are put in, so
 * `gap: var(--gap)` with `--gap: 10px` is checked as a 10px gap. A definition in the
 * declaration's own scope (the same rule, or the same style attribute) is the one that
 * applies. Without one, the value can come from any other definition, so each is
 * checked. Variables with no definition are left as they are.
 * @param {string} value
 * @param {Map<string, { value: string, scope: number }[]>} defs every definition of each variable
 * @param {number} scope the declaration's scope
 * @returns {string[]} distinct values, `value` itself when nothing resolves
 */
export function resolveVars(value, defs, scope) {
  /** @param {string} name */
  const options = (name) => {
    const all = defs.get(name) ?? [];
    const local = all.filter((d) => d.scope === scope);
    return [...new Set((local.length ? local : all).map((d) => d.value))];
  };
  let values = [value];
  // A few rounds, for variables that refer to variables; a loop between them stops here.
  for (let depth = 0; depth < 8; depth++) {
    /** @type {string[]} */
    const next = [];
    for (const v of values) {
      const m = [...v.matchAll(VAR)].find((x) => options(x[1]).length);
      if (!m) { next.push(v); continue; }
      const at = m.index ?? 0;
      for (const o of options(m[1])) next.push(v.slice(0, at) + o + v.slice(at + m[0].length));
    }
    const distinct = [...new Set(next)].slice(0, MAX_CANDIDATES);
    if (distinct.length === values.length && distinct.every((v, i) => v === values[i])) break;
    values = distinct;
  }
  return values;
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
  if (ext === '.css') { cssIn(text, 0); return out; }
  if (ext === '.tsx' || ext === '.jsx') {
    out.push(...styleDeclarations(text, `inline${ext}`));
  } else {
    const doc = readHtml(text);
    for (const style of doc.styles) cssIn(style.css, style.start);
    // A style attribute's declarations share one scope: the attribute's own.
    for (const tag of doc.tags) {
      const style = tag.attrs.get('style');
      // The value as the browser reads it, with character references decoded.
      if (style) cssIn(style.value, style.start, style.start, style.offsetAt);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The literal values in one declaration that a rule covers, with the rule's
 * exceptions applied. Values inside var() are tokens and aren't returned;
 * literals beside them are.
 *
 *   corner       border radius in px (0 and pills of 100px+ aside); a 999px pill
 *   spacing      padding, margin and gap over 1px (negative margins aside)
 *   type size    font-size, and the size in a `font` shorthand, in px or another unit
 *   weight       a numeric weight off WEIGHTS
 *   line height  a unitless line height other than 0 and 1
 *   layer        a z-index over LAYER_FREE_MAX
 *   height       height and min-height in px (a control height only if it matches one)
 *   motion       a transition duration or delay over MOTION_FREE_MS, in ms
 *
 * @param {string} prop
 * @param {string} value
 * @returns {Hit[]}
 */
export function classify(prop, value) {
  const p = prop.toLowerCase();
  const v = value.replace(/!important/, '').trim();
  const lit = literals(v);
  const px = () => [...lit.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px\b/g)].map((m) => Number(m[1]));
  /** @type {Hit[]} */
  const out = [];
  if (/^border(-[a-z]+)*-radius$/.test(p)) {
    for (const n of px()) if (n !== 0 && n < 100) out.push({ kind: 'corner', value: `${n}px`, n });
    if (/\b(999|9999)px\b/.test(lit)) out.push({ kind: 'corner', value: v, pill: true });
  } else if (/^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)*$/.test(p)) {
    for (const n of px()) if (n > 1) out.push({ kind: 'spacing', value: `${n}px`, n, up: p.startsWith('padding') });
  } else if (p === 'font-size' || p === 'font') {
    for (const n of p === 'font' ? px().slice(0, 1) : px()) out.push({ kind: 'type size', value: `${n}px`, n });
    if (/\d(r?em|pt)\b/.test(lit) && v !== '1em') out.push({ kind: 'type size', value: v, unit: true });
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
    for (const m of lit.matchAll(/(?<![\w.-])(\d*\.?\d+)(m?s)\b/g)) {
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (ms > MOTION_FREE_MS) out.push({ kind: 'motion', value: m[0], n: ms });
    }
  }
  return out;
}
