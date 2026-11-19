// Reads the UI's JSX with the TypeScript parser, so source checks look at the
// element tree, not at how the source happens to be laid out. The parser
// primitives live in scripts/jsx.mjs, which the design check uses too.
import type ts from 'typescript';
// @ts-expect-error: a plain .mjs module, with no types
import * as shared from '../../scripts/jsx.mjs';
import { UI, read, tsxFiles, uiFiles, where } from './source.js';

// The source inventory is shared with the other rule suites (helpers/source.ts).
export { UI, tsxFiles, uiFiles };

export type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;
export const opening: (n: Jsx) => ts.JsxOpeningLikeElement = shared.opening;
export const tagName: (n: Jsx) => string = shared.tagName;
export const attrsOf: (n: Jsx) => Map<string, ts.JsxAttribute> = shared.attrsOf;
export const hasSpread: (n: Jsx) => boolean = shared.hasSpread;
/** The className as written, a string or an expression, for matching class names in it. */
export const classText: (n: Jsx) => string = shared.classText;
export const parseTsx: (source: string, fileName?: string) => ts.SourceFile = shared.parseTsx;

/** Every JSX element in a tree, with its JSX ancestors (nearest first) and `file:line`. */
export function* jsxElements(tree: ts.SourceFile, file = tree.fileName): Generator<{ node: Jsx; ancestors: Jsx[]; where: string }> {
  const out: { node: Jsx; ancestors: Jsx[]; where: string }[] = [];
  shared.walkJsx(tree, (node: Jsx, ancestors: Jsx[]) => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    out.push({ node, ancestors, where: `${where(file)}:${line}` });
  });
  yield* out;
}

/** Every JSX element in every UI .tsx file. */
export function* uiJsxElements() {
  for (const file of tsxFiles) yield* jsxElements(parseTsx(read(file), file), file);
}
