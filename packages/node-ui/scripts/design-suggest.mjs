// @ts-check
// Turns a rule's hit (scripts/design-rules.mjs) into what the design check says: the
// token to use, or the nearest one and that the system may need a new one. Typed with
// the same Hit union classify() returns, and checked by tsc (tsconfig.type-tests.json),
// so a rule and its suggestion can't drift apart.
import { WEIGHTS } from './design-rules.mjs';

/** @typedef {import('./design-rules.mjs').Hit} Hit */
/** A step on a scale: a token and its number (px, ms or unitless). @typedef {{ name: string, value: number }} Step */
/**
 * The scales a suggestion picks from, built from the tokens in 00-theme.css.
 * @typedef {{ radius: Step[], space: Step[], fontSize: Step[], height: Step[], lineHeight: Step[], z: Step[], motion: Step[] }} Scales
 */
/**
 * What a finding is about. Every kind fails the check except a height, which may be
 * layout and only gets a suggestion.
 * @typedef {'corner' | 'spacing' | 'type size' | 'weight' | 'line height' | 'layer' | 'motion' | 'colour' | 'token' | 'shadow' | 'component' | 'css'} BlockingKind
 * @typedef {BlockingKind | 'height'} FindingKind
 */
/**
 * What the check reports for one value. A blocking finding (a value off the system, or one
 * on it written as a literal instead of its token) carries `offScale: true`, which the JSON
 * output keeps; a height never does, so the type says which is which.
 * @typedef {{ kind: BlockingKind, value: string, use: string, offScale: true }} BlockingFinding
 * @typedef {{ kind: 'height', value: string, use: string }} AdvisoryFinding
 * @typedef {BlockingFinding | AdvisoryFinding} Finding
 */

/** Whether a finding fails the check: everything but a height. @param {Finding} f @returns {f is BlockingFinding} */
export const fails = (f) => f.kind !== 'height';

export const ADD = 'or, if this is a new rule, add a token (DESIGN.md · Adding to the system)';

const WEIGHT_LIST = `${WEIGHTS.slice(0, -1).join(', ')} or ${WEIGHTS[WEIGHTS.length - 1]}`;

/**
 * The closest step. On a tie, `up` picks the larger one (DESIGN.md · Spacing: padding rounds up, gaps and margins down).
 * @param {Step[]} scale @param {number} value @param {boolean} [up]
 * @returns {Step | null}
 */
export function nearest(scale, value, up = false) {
  /** @type {Step | null} */
  let best = null;
  for (const t of scale) {
    if (!best) { best = t; continue; }
    const [d, bd] = [Math.abs(t.value - value), Math.abs(best.value - value)];
    if (d < bd || (d === bd && (up ? t.value > best.value : t.value < best.value))) best = t;
  }
  return best;
}

/**
 * The token for a number on a scale, or the nearest one and that the system may need a new one.
 * @param {BlockingKind} kind @param {Step[]} scale @param {number} value @param {string} [unit] @param {boolean} [up]
 * @returns {{ kind: BlockingKind, use: string, offScale: true }}
 */
export function scaleRule(kind, scale, value, unit = 'px', up = false) {
  const hit = scale.find((t) => t.value === value);
  // On the scale but written as a number: it still fails, the token is what to write.
  if (hit) return { kind, use: `var(${hit.name})`, offScale: true };
  const near = nearest(scale, value, up);
  return { kind, use: near ? `nearest is var(${near.name}) (${near.value}${unit}), ${ADD}` : ADD, offScale: true };
}

/**
 * What to say about one hit, or null when there's nothing to say (a height that isn't a control height).
 * @param {Scales} scales
 * @param {Hit} hit
 * @returns {Finding | null}
 */
export function suggest(scales, hit) {
  const { value } = hit;
  switch (hit.kind) {
    case 'corner':
      if ('pill' in hit) return { kind: hit.kind, value, use: 'var(--radius-pill)', offScale: true };
      if ('unit' in hit) return { kind: hit.kind, value, use: `corners are px tokens (--radius-*): work out ${value} in px and use the nearest, ${ADD}`, offScale: true };
      return { value, ...scaleRule(hit.kind, scales.radius, hit.n) };
    case 'spacing':
      if ('unit' in hit) return { kind: hit.kind, value, use: `spacing is px tokens (--space-*): work out ${value} in px and use the nearest, ${ADD}`, offScale: true };
      return { value, ...scaleRule(hit.kind, scales.space, hit.n, 'px', hit.up) };
    case 'type size':
      return 'unit' in hit
        ? { kind: hit.kind, value, use: 'type sizes are px tokens (--fs-*)', offScale: true }
        : { value, ...scaleRule(hit.kind, scales.fontSize, hit.n) };
    case 'weight':
      return { kind: hit.kind, value, use: `weights are ${WEIGHT_LIST}`, offScale: true };
    case 'line height':
      return { value, ...scaleRule(hit.kind, scales.lineHeight, hit.n, '') };
    case 'layer':
      return { value, ...scaleRule(hit.kind, scales.z, hit.n, '') };
    case 'motion':
      return { value, ...scaleRule(hit.kind, scales.motion, hit.n, 'ms') };
    case 'height': {
      // Only sizes that are already a control or badge height: anything else may be layout.
      const token = scales.height.find((t) => t.value === hit.n);
      return token ? { kind: hit.kind, value, use: `var(${token.name}), if this is a control, badge or row` } : null;
    }
    default: {
      /** @type {never} */
      const unhandled = hit;
      return unhandled;
    }
  }
}
