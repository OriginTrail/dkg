// @ts-check
// Reads JSX with the TypeScript parser, so a check looks at the element tree, not at
// how the source happens to be laid out. Shared by the source checks
// (test/helpers/jsx.ts) and the design check (scripts/design-rules.mjs). The JSDoc
// types are checked: tsconfig.type-tests.json runs tsc with checkJs over this file.
import ts from 'typescript';

export { ts };

/** @typedef {ts.JsxElement | ts.JsxSelfClosingElement} Jsx */
/**
 * One declaration: the lines its property and value span, and its scope (the offset of the
 * rule, style attribute or JSX element it belongs to, -1 for none), which says which of a
 * mock-up's variable definitions applies to it.
 * @typedef {{ prop: string, value: string, line: number, endLine: number, scope: number }} Declaration
 */

/** @param {Jsx} n @returns {ts.JsxOpeningLikeElement} */
export const opening = (n) => (ts.isJsxElement(n) ? n.openingElement : n);
/** @param {Jsx} n @returns {string} */
export const tagName = (n) => opening(n).tagName.getText();
/** @param {Jsx} n @returns {Map<string, ts.JsxAttribute>} */
export const attrsOf = (n) => new Map(opening(n).attributes.properties
  .filter(ts.isJsxAttribute)
  .map((a) => [a.name.getText(), a]));
/** @param {Jsx} n @returns {boolean} */
export const hasSpread = (n) => opening(n).attributes.properties.some(ts.isJsxSpreadAttribute);
/** The className as written, a string or an expression, for matching class names in it. @param {Jsx} n @returns {string} */
export const classText = (n) => attrsOf(n).get('className')?.initializer?.getText() ?? '';

/**
 * The string an attribute is set to, written as `a="x"` or `a={'x'}`; '' for a bare
 * attribute; null when it's worked out at runtime.
 * @param {ts.JsxAttribute} attr @returns {string | null}
 */
export function attrText(attr) {
  const init = attr.initializer;
  if (!init) return '';
  if (ts.isStringLiteral(init)) return init.text;
  const e = ts.isJsxExpression(init) ? init.expression : undefined;
  return e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null;
}

/**
 * Every class name an element's className can hold: the words of each string in it,
 * so `className={cx('ds-btn', active && 'is-on')}` gives ds-btn and is-on.
 * @param {Jsx} n @returns {string[]}
 */
export function classNames(n) {
  const init = attrsOf(n).get('className')?.initializer;
  if (!init) return [];
  /** @type {string[]} */
  const words = [];
  /** @param {ts.Node} x */
  const collect = (x) => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) {
      words.push(...x.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(x, collect);
  };
  if (ts.isStringLiteral(init)) collect(init);
  else ts.forEachChild(init, collect);
  return words;
}

/** @param {string} source @param {string} [fileName] @returns {ts.SourceFile} */
export function parseTsx(source, fileName = 'inline.tsx') {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/**
 * Calls `visit(node, ancestors)` for every JSX element in source order, ancestors nearest first.
 * @param {ts.Node} tree
 * @param {(node: Jsx, ancestors: Jsx[]) => void} visit
 * @returns {void}
 */
export function walkJsx(tree, visit) {
  /** @type {Jsx[]} */
  const stack = [];
  /** @param {ts.Node} n */
  const step = (n) => {
    const jsx = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) ? n : null;
    if (jsx) { visit(jsx, [...stack].reverse()); stack.push(jsx); }
    ts.forEachChild(n, step);
    if (jsx) stack.pop();
  };
  step(tree);
}

// How React writes a number in a style object: px, except for these properties.
const UNITLESS = new Set(['animationIterationCount', 'aspectRatio', 'columnCount', 'columns', 'flex', 'flexGrow', 'flexShrink',
  'fontWeight', 'gridColumn', 'gridColumnEnd', 'gridColumnStart', 'gridRow', 'gridRowEnd', 'gridRowStart', 'lineClamp',
  'lineHeight', 'opacity', 'order', 'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'strokeOpacity', 'strokeWidth']);

/** @param {string} s */
const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The object a style expression stands for, through parentheses and `as`/`satisfies`/`<T>` casts.
 * @param {ts.Expression | undefined} e
 * @returns {ts.ObjectLiteralExpression | null}
 */
function styleObject(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e && ts.isObjectLiteralExpression(e) ? e : null;
}

/**
 * A literal value as CSS text, or null if it's worked out at runtime.
 * @param {string} name
 * @param {ts.Expression} init
 * @returns {string | null}
 */
function literalValue(name, init) {
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  let n = null;
  if (ts.isNumericLiteral(init)) n = init.text;
  else if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand)) n = `-${init.operand.text}`;
  if (n === null) return null;
  // React writes a custom property's number as it is: `'--layer': 50` is 50, not 50px.
  return name.startsWith('--') || UNITLESS.has(name) || n === '0' ? n : `${n}px`;
}

/**
 * Every literal declaration in the JSX `style` objects of a file, in source order,
 * with kebab-case properties and React's px units.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {Declaration[]}
 */
export function styleDeclarations(text, fileName = 'inline.tsx') {
  const tree = parseTsx(text, fileName);
  /** @param {number} pos */
  const lineOf = (pos) => tree.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Declaration[]} */
  const out = [];
  walkJsx(tree, (node) => {
    const init = attrsOf(node).get('style')?.initializer;
    const obj = init && ts.isJsxExpression(init) ? styleObject(init.expression) : null;
    if (!obj) return;
    const scope = node.getStart(tree);
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      const value = name === null ? null : literalValue(name, p.initializer);
      if (name === null || value === null) continue;
      out.push({ prop: name.startsWith('--') ? name : camelToKebab(name), value, line: lineOf(p.getStart(tree)), endLine: lineOf(p.getEnd()), scope });
    }
  });
  return out;
}
