// @ts-check
// Reads CSS with postcss, once per fragment, so declarations, the rule each one is
// in, comments and quoted values come from a syntax tree rather than from patterns.
// Shared by the declaration reader (scripts/design-rules.mjs) and the token inventory
// (scripts/design-core.mjs). Checked by tsc (tsconfig.type-tests.json).
import postcss from 'postcss';

/**
 * One declaration in a CSS fragment. `start` and `end` are offsets in the whole file;
 * `scope` is the offset of the rule or at-rule it's in, or `rootScope` when it sits at
 * the top (a style attribute's declarations, or a stylesheet's stray ones).
 * @typedef {{ prop: string, value: string, start: number, end: number, scope: number }} CssDeclaration
 */

/** CSS the parser couldn't read: where (an offset in the file) and why. */
export class CssReadError extends Error {
  /** @param {string} reason @param {number} index */
  constructor(reason, index) {
    super(`couldn't read the CSS: ${reason}`);
    this.name = 'CssReadError';
    this.reason = reason;
    this.index = index;
  }
}

/** The offset of a 1-based line and column in `text`. @param {string} text @param {number} line @param {number} column */
function offsetOf(text, line, column) {
  let at = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', at);
    if (next === -1) break;
    at = next + 1;
  }
  return at + Math.max(column - 1, 0);
}

/**
 * Every declaration in a CSS fragment that starts at `offset` in its file.
 * @param {string} css
 * @param {number} [offset]
 * @param {number} [rootScope] the scope of declarations outside any rule
 * @returns {CssDeclaration[]}
 * @throws {CssReadError} when the fragment isn't CSS the parser can read
 */
export function cssDeclarations(css, offset = 0, rootScope = -1) {
  let root;
  try {
    root = postcss.parse(css);
  } catch (error) {
    if (error instanceof postcss.CssSyntaxError) {
      throw new CssReadError(error.reason, offset + offsetOf(css, error.line ?? 1, error.column ?? 1));
    }
    throw error;
  }
  /** @type {CssDeclaration[]} */
  const out = [];
  root.walkDecls((d) => {
    const start = offset + (d.source?.start?.offset ?? 0);
    const end = offset + Math.max((d.source?.end?.offset ?? 0) - 1, d.source?.start?.offset ?? 0);
    const parent = d.parent;
    const scope = parent && parent.type !== 'root' ? offset + (parent.source?.start?.offset ?? 0) : rootScope;
    out.push({ prop: d.prop, value: d.important ? `${d.value} !important` : d.value, start, end, scope });
  });
  return out;
}
