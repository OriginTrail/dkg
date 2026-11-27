// Reads the UI's JSX with the TypeScript parser, so source checks look at the
// element tree, not at how the source happens to be laid out. The parser
// primitives and their types live in scripts/jsx.mjs, which the design check uses too.
import type ts from 'typescript';
import { parseTsx, walkJsx, type Jsx } from '../../scripts/jsx.mjs';
import { UI, read, tsxFiles, uiFiles, where } from './source.js';

// The source inventory is shared with the other rule suites (helpers/source.ts).
export { UI, tsxFiles, uiFiles };
export { attrsOf, classText, hasSpread, opening, parseTsx, tagName, type Jsx } from '../../scripts/jsx.mjs';

/** Every JSX element in a tree, with its JSX ancestors (nearest first) and `file:line`. */
export function* jsxElements(tree: ts.SourceFile, file = tree.fileName): Generator<{ node: Jsx; ancestors: Jsx[]; where: string }> {
  const out: { node: Jsx; ancestors: Jsx[]; where: string }[] = [];
  walkJsx(tree, (node, ancestors) => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    out.push({ node, ancestors, where: `${where(file)}:${line}` });
  });
  yield* out;
}

/** Every JSX element in every UI .tsx file. */
export function* uiJsxElements() {
  for (const file of tsxFiles) yield* jsxElements(parseTsx(read(file), file), file);
}
