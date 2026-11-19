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
      } else if (c === ',' || c === '/') {
        out.push({ type: 'div', value: c, start, end: ++i });
      } else if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
        i = Math.min(i + 1, text.length);
        out.push({ type: 'string', value: text.slice(start, i), start, end: i });
      } else {
        while (i < text.length && !/[\s,/()"']/.test(text[i])) i++;
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
 * The value again, with each node `replace` returns text for written as that text instead.
 * Positions stay meaningful only when replacements keep their length.
 * @param {string} text the value the nodes were read from
 * @param {ValueNode[]} nodes
 * @param {(node: ValueNode) => string | undefined} replace
 * @returns {string}
 */
export function rewriteValue(text, nodes, replace) {
  /** @type {{ start: number, end: number, with: string }[]} */
  const edits = [];
  walkValue(nodes, (n) => {
    const r = replace(n);
    if (r === undefined) return true;
    edits.push({ start: n.start, end: n.end, with: r });
    return false;
  });
  let out = '';
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.start) + e.with; at = e.end; }
  return out + text.slice(at);
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
