// @ts-check
// One reading of a CSS declaration value, shared by every check that looks inside one:
// the literals a rule covers, the var() references, the colours, and variable
// substitution (scripts/design-rules.mjs, scripts/design-core.mjs). The value becomes a
// tree of words, strings, functions (with what's inside them) and separators, each with
// where it is in the value. Design policy stays with the callers. Checked by tsc
// (tsconfig.type-tests.json).

/**
 * One piece of a value. A function's `value` is its name (lower case; '' for bare
 * parentheses) and `nodes` what's inside; `url()` keeps its inside as one raw word.
 * @typedef {{ type: 'word' | 'string' | 'space' | 'div', value: string, start: number, end: number }} Leaf
 * @typedef {{ type: 'function', value: string, start: number, end: number, nodes: ValueNode[] }} FunctionNode
 * @typedef {Leaf | FunctionNode} ValueNode
 */
/**
 * A value read once: its text and its tree, kept together so every node's start and end
 * are positions in `text`.
 * @typedef {{ text: string, nodes: ValueNode[] }} ParsedValue
 */

/** A value with its tree. @param {string} text @returns {ParsedValue} */
export const readValue = (text) => ({ text, nodes: parseValue(text) });

/**
 * A declaration value as a tree. Never throws: an unclosed string or function runs to the end.
 * @param {string} text
 * @returns {ValueNode[]}
 */
export function parseValue(text) {
  let i = 0;
  /** @param {boolean} inside @returns {ValueNode[]} */
  const list = (inside) => {
    /** @type {ValueNode[]} */
    const out = [];
    while (i < text.length) {
      const c = text[i];
      if (c === ')') { if (inside) return out; out.push({ type: 'word', value: c, start: i, end: ++i }); continue; }
      const start = i;
      if (/\s/.test(c)) {
        while (i < text.length && /\s/.test(text[i])) i++;
        out.push({ type: 'space', value: text.slice(start, i), start, end: i });
      } else if (c === ',' || c === '/' || c === '*') {
        // `*` is calc()'s multiplication, which needs no spaces: `2*10px` is 2 times 10px. (`+` and `-` do.)
        out.push({ type: 'div', value: c, start, end: ++i });
      } else if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
        i = Math.min(i + 1, text.length);
        out.push({ type: 'string', value: text.slice(start, i), start, end: i });
      } else {
        while (i < text.length && !/[\s,/*()"']/.test(text[i])) i++;
        const word = text.slice(start, i);
        if (text[i] !== '(') { out.push({ type: 'word', value: word, start, end: i }); continue; }
        i++; // past "("
        const name = word.toLowerCase();
        if (name === 'url' && !/^\s*["']/.test(text.slice(i))) {
          // An unquoted url() holds anything up to its ")", as one raw piece.
          const close = text.indexOf(')', i);
          const end = close === -1 ? text.length : close;
          const raw = { type: /** @type {const} */ ('word'), value: text.slice(i, end), start: i, end };
          i = close === -1 ? text.length : close + 1;
          out.push({ type: 'function', value: name, start, end: i, nodes: [raw] });
          continue;
        }
        const nodes = list(true);
        if (text[i] === ')') i++;
        out.push({ type: 'function', value: name, start, end: i, nodes });
      }
    }
    return out;
  };
  return list(false);
}

/**
 * Calls `visit` for every node, outside in. Returning false skips what's inside a function.
 * @param {ValueNode[]} nodes
 * @param {(node: ValueNode) => boolean | void} visit
 */
export function walkValue(nodes, visit) {
  for (const n of nodes) {
    if (visit(n) === false) continue;
    if (n.type === 'function') walkValue(n.nodes, visit);
  }
}

/**
 * The words a value says itself, in order: everything but a var()'s name (a token), url()
 * and strings (text), including inside other functions such as calc(), and a var()'s
 * fallback, which the browser uses when the variable isn't set. `var(--space-4) 10px` and
 * `var(--gap, 10px)` both give 10px.
 * @param {ValueNode[]} nodes
 * @returns {string[]}
 */
export function literalWords(nodes) {
  /** @type {string[]} */
  const out = [];
  walkValue(nodes, (n) => {
    if (n.type === 'function') {
      if (n.value === 'url') return false;
      if (n.value !== 'var') return true;
      // Past the first comma is the fallback, read like any other value.
      const comma = n.nodes.findIndex((c) => c.type === 'div' && c.value === ',');
      if (comma !== -1) out.push(...literalWords(n.nodes.slice(comma + 1)));
      return false;
    }
    if (n.type === 'word') out.push(n.value);
    return true;
  });
  return out;
}

/**
 * The var() references in a value, outside in, with the variable each names. A var() in a
 * string or url() is text, so it isn't one.
 * @param {ValueNode[]} nodes
 * @returns {{ node: FunctionNode, name: string }[]}
 */
export function varRefs(nodes) {
  /** @type {{ node: FunctionNode, name: string }[]} */
  const out = [];
  walkValue(nodes, (n) => {
    if (n.type !== 'function') return true;
    if (n.value === 'url') return false;
    if (n.value === 'var') {
      const first = n.nodes.find((x) => x.type !== 'space');
      if (first && first.type === 'word' && first.value.startsWith('--')) out.push({ node: n, name: first.value });
    }
    return true;
  });
  return out;
}
