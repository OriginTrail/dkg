// The design rules both the checks and the design check apply: how a declaration is
// found in a file, and which literal values in it fall under a rule. Policy lives
// here once. test/layout-tokens.test.ts fails on any value a rule finds, and
// scripts/design-check.mjs turns each one into a suggestion (the token to use, or
// that the system needs a new one).

/** Font weights the type scale uses (DESIGN.md · Type). */
export const WEIGHTS = ['400', '500', '600', '700'];
/** Layers up to this sit in a component's own stacking; above it, use a --z-* token. */
export const LAYER_FREE_MAX = 10;
/** Durations at or under this are reduced-motion overrides, not timings. */
export const MOTION_FREE_MS = 0.5;

export const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** A value with its var() expressions taken out, so the literals beside a token are still checked. */
export const literals = (value) => value.replace(/var\((?:[^()]|\([^()]*\))*\)/g, ' ');

/** The line each character index is on, from 1. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/** Every declaration in a file with its line: CSS, <style> blocks, style="" and style={{}}. */
export function declarations(text, ext) {
  const lineAt = lineIndex(text);
  const out = [];
  const add = (prop, value, index) => out.push({ prop, value, line: lineAt(index) });
  const cssIn = (css, offset) => {
    for (const m of stripComments(css).matchAll(/(?<![\w-])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/gm)) {
      if (/^(https?|data)$/.test(m[1])) continue;
      add(m[1], m[2], offset + m.index);
    }
  };
  if (ext === '.css') { cssIn(text, 0); return out; }
  // Each body's offset is where it starts in the file, so a declaration keeps its own line.
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssIn(m[1], m.index + m[0].length - '</style>'.length - m[1].length);
  for (const m of text.matchAll(/\bstyle="([^"]*)"/g)) cssIn(m[1], m.index + 'style="'.length);
  for (const m of text.matchAll(/\bstyle=\{\{([\s\S]*?)\}\}/g)) {
    const at = m.index + 'style={{'.length;
    for (const d of m[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*(['"`])([^'"`]*)\2/g)) add(camelToKebab(d[1]), d[3], at + d.index);
    for (const d of m[1].matchAll(/\b(fontSize|borderRadius|padding|margin|gap|zIndex|fontWeight|lineHeight)\s*:\s*(\d*\.?\d+)\b/g)) {
      const unitless = ['zIndex', 'fontWeight', 'lineHeight'].includes(d[1]);
      add(camelToKebab(d[1]), unitless ? d[2] : `${d[2]}px`, at + d.index);
    }
  }
  return out;
}

/**
 * The literal values in one declaration that a rule covers, with the rule's
 * exceptions applied: `{ kind, value, n? }`. Values inside var() are tokens and
 * aren't returned; literals beside them are.
 *
 *   corner       border radius in px (0 and pills of 100px+ aside; `pill` marks 999px)
 *   spacing      padding, margin and gap over 1px (negative margins aside); `up` on padding
 *   type size    font-size, and the size in a `font` shorthand; `unit` for em, rem and pt
 *   weight       a numeric weight off WEIGHTS
 *   line height  a unitless line height other than 0 and 1
 *   layer        a z-index over LAYER_FREE_MAX
 *   height       height and min-height in px (a control height only if it matches one)
 *   motion       a transition duration or delay over MOTION_FREE_MS, as `n` ms
 */
export function classify(prop, value) {
  const p = prop.toLowerCase();
  const v = value.replace(/!important/, '').trim();
  const lit = literals(v);
  const px = () => [...lit.matchAll(/(?<![\w.#-])(-?\d*\.?\d+)px\b/g)].map((m) => Number(m[1]));
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
