// Reads the UI's JSX with the TypeScript parser, so source checks look at the
// element tree, not at how the source happens to be laid out.
import ts from 'typescript';
import { UI, read, tsxFiles, uiFiles, where } from './source.js';

// The source inventory is shared with the other rule suites (helpers/source.ts).
export { UI, tsxFiles, uiFiles };

export type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;
export const opening = (n: Jsx) => (ts.isJsxElement(n) ? n.openingElement : n);
export const tagName = (n: Jsx) => opening(n).tagName.getText();
export const attrsOf = (n: Jsx) => new Map(opening(n).attributes.properties
  .filter(ts.isJsxAttribute)
  .map((a) => [a.name.getText(), a]));
export const hasSpread = (n: Jsx) => opening(n).attributes.properties.some(ts.isJsxSpreadAttribute);
/** The className as written, a string or an expression, for matching class names in it. */
export const classText = (n: Jsx) => attrsOf(n).get('className')?.initializer?.getText() ?? '';

export function parseTsx(source: string, fileName = 'inline.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Every JSX element in a tree, with its JSX ancestors (nearest first) and `file:line`. */
export function* jsxElements(tree: ts.SourceFile, file = tree.fileName): Generator<{ node: Jsx; ancestors: Jsx[]; where: string }> {
  const stack: Jsx[] = [];
  const out: { node: Jsx; ancestors: Jsx[]; where: string }[] = [];
  const visit = (n: ts.Node) => {
    const isJsx = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
    if (isJsx) {
      const line = tree.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      out.push({ node: n, ancestors: [...stack].reverse(), where: `${where(file)}:${line}` });
      stack.push(n);
    }
    ts.forEachChild(n, visit);
    if (isJsx) stack.pop();
  };
  visit(tree);
  yield* out;
}

/** Every JSX element in every UI .tsx file. */
export function* uiJsxElements() {
  for (const file of tsxFiles) yield* jsxElements(parseTsx(read(file), file), file);
}
