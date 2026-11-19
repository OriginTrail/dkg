// The shared design modules (scripts/colour.mjs, jsx.mjs, design-rules.mjs) carry their
// contracts as JSDoc, which tsc checks with checkJs (tsconfig.type-tests.json). Each
// expected error below marks a misuse that must stay a type error.
import type ts from 'typescript';
import { parseColour } from '../scripts/colour.mjs';
import { classify, declarations, resolveVars, type Hit, type Kind } from '../scripts/design-rules.mjs';
import { attrsOf, parseTsx, walkJsx, type Declaration, type Jsx } from '../scripts/jsx.mjs';
import { jsxElements } from './helpers/jsx.js';

const colour = parseColour('#ffffff');
export const channels: [number, number, number] | undefined = colour?.rgb;
// @ts-expect-error: a colour can be null, so its channels aren't always there
export const unchecked: number = parseColour('#fff').alpha;

export const hits: Hit[] = classify('padding', '10px');
export const kind: Kind = 'spacing';
// @ts-expect-error: colours aren't one of the literal rules
export const notAKind: Kind = 'colour';
// @ts-expect-error: a hit's number is optional, so it can't be used as one unchecked
export const n: number = classify('gap', '10px')[0].n;

export const decls: Declaration[] = declarations('.a { gap: 8px; }', '.css');
// @ts-expect-error: the extension is a string such as '.css'
declarations('.a { gap: 8px; }', 1);
export const resolved: string = resolveVars('var(--gap)', new Map([['--gap', '8px']]));
// @ts-expect-error: variables are a Map of name to value
resolveVars('var(--gap)', { '--gap': '8px' });

const tree = parseTsx('<div style={{ gap: 8 }} />');
walkJsx(tree, (node: Jsx, ancestors: Jsx[]) => {
  const style: ts.JsxAttribute | undefined = attrsOf(node).get('style');
  void style; void ancestors;
});
// @ts-expect-error: ancestors are JSX elements, not strings
walkJsx(tree, (_node: Jsx, ancestors: string[]) => void ancestors);
export const where: string = [...jsxElements(tree)][0].where;
