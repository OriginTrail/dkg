// Reads JSX with the TypeScript parser, so a check looks at the element tree, not at
// how the source happens to be laid out. Shared by the source checks
// (test/helpers/jsx.ts) and the design check (scripts/design-rules.mjs).
import ts from 'typescript';

export { ts };

export const opening = (n) => (ts.isJsxElement(n) ? n.openingElement : n);
export const tagName = (n) => opening(n).tagName.getText();
export const attrsOf = (n) => new Map(opening(n).attributes.properties
  .filter(ts.isJsxAttribute)
  .map((a) => [a.name.getText(), a]));
export const hasSpread = (n) => opening(n).attributes.properties.some(ts.isJsxSpreadAttribute);
/** The className as written, a string or an expression, for matching class names in it. */
export const classText = (n) => attrsOf(n).get('className')?.initializer?.getText() ?? '';

export function parseTsx(source, fileName = 'inline.tsx') {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Calls `visit(node, ancestors)` for every JSX element, ancestors nearest first. */
export function walkJsx(tree, visit) {
  const stack = [];
  const step = (n) => {
    const isJsx = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
    if (isJsx) { visit(n, [...stack].reverse()); stack.push(n); }
    ts.forEachChild(n, step);
    if (isJsx) stack.pop();
  };
  step(tree);
}

// How React writes a number in a style object: px, except for these properties.
const UNITLESS = new Set(['animationIterationCount', 'aspectRatio', 'columnCount', 'columns', 'flex', 'flexGrow', 'flexShrink',
  'fontWeight', 'gridColumn', 'gridColumnEnd', 'gridColumnStart', 'gridRow', 'gridRowEnd', 'gridRowStart', 'lineClamp',
  'lineHeight', 'opacity', 'order', 'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'strokeOpacity', 'strokeWidth']);

const camelToKebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The object a style expression stands for, through parentheses and `as`/`satisfies`/`<T>` casts. */
function styleObject(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e && ts.isObjectLiteralExpression(e) ? e : null;
}

/** A literal value as CSS text, or null if it's worked out at runtime. */
function literalValue(name, init) {
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  const neg = ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(init.operand);
  if (ts.isNumericLiteral(init) || neg) {
    const n = neg ? `-${init.operand.text}` : init.text;
    return UNITLESS.has(name) || n === '0' ? n : `${n}px`;
  }
  return null;
}

/**
 * Every literal declaration in the JSX `style` objects of a file, as
 * `{ prop, value, line, endLine }` with kebab-case properties and React's px units.
 */
export function styleDeclarations(text, fileName = 'inline.tsx') {
  const tree = parseTsx(text, fileName);
  const lineOf = (pos) => tree.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  walkJsx(tree, (node) => {
    const style = attrsOf(node).get('style');
    const init = style?.initializer;
    const obj = init && ts.isJsxExpression(init) ? styleObject(init.expression) : null;
    if (!obj) return;
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      const value = name && literalValue(name, p.initializer);
      if (value === null || value === undefined) continue;
      out.push({ prop: name.startsWith('--') ? name : camelToKebab(name), value, line: lineOf(p.getStart(tree)), endLine: lineOf(p.getEnd()) });
    }
  });
  return out;
}
