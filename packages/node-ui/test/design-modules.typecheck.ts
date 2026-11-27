// The shared design modules (scripts/colour.mjs, jsx.mjs, design-rules.mjs, design-suggest.mjs) carry their
// contracts as JSDoc, which tsc checks with checkJs (tsconfig.type-tests.json). Each
// expected error below marks a misuse that must stay a type error.
import type ts from 'typescript';
import { parseColour } from '../scripts/colour.mjs';
import { parseValue, readValue } from '../scripts/css-value.mjs';
import { classify, declarations, readSource, resolveVars, type Hit, type Kind, type SourceDocument } from '../scripts/design-rules.mjs';
import { suggest, type Finding, type Scales } from '../scripts/design-suggest.mjs';
import { attrsOf, parseTsx, walkJsx, type Declaration, type Jsx } from '../scripts/jsx.mjs';
import { jsxElements } from './helpers/jsx.js';

const colour = parseColour('#ffffff');
export const channels: [number, number, number] | undefined = colour?.rgb;
// @ts-expect-error: a colour can be null, so its channels aren't always there
export const unchecked: number = parseColour('#fff').alpha;

export const hits: Hit[] = classify('padding', '10px');
export const fromParsed: Hit[] = classify('padding', readValue('10px'));
// @ts-expect-error: a tree alone has no text to report, so it comes with its text (readValue)
classify('padding', parseValue('10px'));
// @ts-expect-error: text and a separate tree can't disagree any more: classify takes one value
classify('padding', '10px', parseValue('10px'));
export const kind: Kind = 'spacing';
// @ts-expect-error: colours aren't one of the literal rules
export const notAKind: Kind = 'colour';
// @ts-expect-error: a spacing hit always carries its number
export const missingN: Hit = { kind: 'spacing', value: '10px', up: false };
// @ts-expect-error: only a pill corner has no number, and it says so
export const bareCorner: Hit = { kind: 'corner', value: '8px' };
// @ts-expect-error: before narrowing, a hit's number isn't there for every kind
export const unnarrowed: number = classify('gap', '10px')[0].n;
for (const hit of classify('gap', '10px')) {
  // Narrowed by kind and to a px value (not a pill, not another unit), the number is required.
  if (hit.kind === 'spacing' && !('unit' in hit)) { const n: number = hit.n; const up: boolean = hit.up; void n; void up; }
  if (hit.kind === 'corner' && !('pill' in hit) && !('unit' in hit)) { const n: number = hit.n; void n; }
  if (hit.kind === 'type size' && 'unit' in hit) { const unit: true = hit.unit; void unit; }
  // @ts-expect-error: a spacing hit in another unit has no px number
  if (hit.kind === 'spacing') { const n: number = hit.n; void n; }
}

const step = { name: '--space-8', value: 8 };
const scales: Scales = { radius: [step], space: [step], fontSize: [step], height: [step], lineHeight: [step], z: [step], motion: [step] };
export const finding: Finding | null = suggest(scales, { kind: 'spacing', value: '10px', n: 10, up: false });
export const advisory: Finding = { kind: 'height', value: '32px', use: 'var(--h-control-md)' };
// @ts-expect-error: every kind but a height fails, so it must say so
export const unflagged: Finding = { kind: 'spacing', value: '10px', use: 'var(--space-8)' };
// @ts-expect-error: a height is a suggestion, never a failure
export const blockingHeight: Finding = { kind: 'height', value: '32px', use: 'var(--h-control-md)', offScale: true };
// @ts-expect-error: a kind the check doesn't report
export const unknownKind: Finding = { kind: 'size', value: '10px', use: '', offScale: true };
// @ts-expect-error: a suggestion needs every scale
suggest({ space: [step] }, { kind: 'spacing', value: '10px', n: 10, up: false });

export const decls: Declaration[] = declarations('.a { gap: 8px; }', '.css');
// @ts-expect-error: the extension is a string such as '.css'
declarations('.a { gap: 8px; }', 1);
export const resolved: string[] = resolveVars('var(--gap)', new Map([['--gap', [{ value: '8px', scope: -1 }]]]), -1);
// @ts-expect-error: each variable maps to its definitions, each with its scope
resolveVars('var(--gap)', new Map([['--gap', '8px']]), -1);

const tree = parseTsx('<div style={{ gap: 8 }} />');
walkJsx(tree, (node: Jsx, ancestors: Jsx[]) => {
  const style: ts.JsxAttribute | undefined = attrsOf(node).get('style');
  void style; void ancestors;
});
// @ts-expect-error: ancestors are JSX elements, not strings
walkJsx(tree, (_node: Jsx, ancestors: string[]) => void ancestors);
export const where: string = [...jsxElements(tree)][0].where;

// One reading of a file gives both rule families what they need.
export const doc: SourceDocument = readSource('<button style="gap: 8px">Save</button>', '.html');
export const firstTag: string | undefined = doc.tags[0]?.name;
// @ts-expect-error: an element's attributes are strings (or null when set at runtime), not the reader's offsets
export const attrOffset: number = doc.tags[0].attrs.get('style')!.start;
