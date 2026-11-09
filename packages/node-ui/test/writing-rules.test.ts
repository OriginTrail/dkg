// Word check for the text people read in the node UI (DESIGN.md · Writing).
// A listed word fails wherever a person could read it: JSX text, the attributes
// people see or hear, labels and messages in objects, and error messages.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Words DESIGN.md · Writing rules out, with what to use instead. */
const WORDS: [RegExp, string][] = [
  [/\bprincipals?\b/i, 'agent'],
  [/\bruntimes?\b/i, 'agent'],
  [/\bdaemon\b(?!\.log)/i, 'node'],
  [/\bcanonical\b/i, 'remove the word'],
  [/\batomic(ally)?\b/i, 'say what happens'],
  [/\bnonce\b/i, 'remove the word'],
  [/\bprob(e|es|ed|ing)\b/i, 'check'],
  [/\bseed(ed|ing)\b/i, 'say where it came from'],
  [/\bvault(ed|ing)?\b/i, 'saved or stored'],
  [/\btriage\b/i, 'review'],
  [/\benvelopes?\b/i, 'say what it is'],
  [/\bbootstrap(ped|ping)?\b/i, 'say what happens'],
  [/\breachable\b/i, 'Connected'],
  [/\bprocessing\b/i, 'In progress'],
  [/\bawaiting (your )?approval\b/i, 'Approval needed'],
  [/\bpending review\b/i, 'Approval needed'],
  [/\boutcome not confirmed\b/i, 'Outcome unknown'],
  [/\bcarried out\b/i, 'Done'],
  [/\bnot admitted\b/i, 'Refused'],
  [/\bSPEC_[A-Z]/, 'no spec notes on screen'],
  [/^\d+ · /, 'a label and its detail take a colon'],
];

/**
 * Lines waiting for a wording decision. This list only gets shorter: a line that
 * has changed fails the last test until it is removed here.
 */
const PENDING = new Set<string>([]);

const VISIBLE_ATTRIBUTES = new Set([
  'alt', 'aria-description', 'aria-label', 'body', 'caption', 'confirmLabel', 'cancelLabel', 'description',
  'detail', 'empty', 'emptyText', 'error', 'footnote', 'heading', 'help', 'helperText', 'hint', 'label', 'message',
  'note', 'placeholder', 'reason', 'subtitle', 'summary', 'text', 'title', 'tooltip',
]);
const VISIBLE_CALL = /^(toast|notify|alert|confirm|set(Error|Notice|Message|Warning)\w*)$|\.(toast|notify)$/;

const clean = (text: string) => text.replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();

const isComparison = (node: ts.Node) => ts.isBinaryExpression(node)
  && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind);
const isCode = (node: ts.Node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isCallExpression(node) || isComparison(node);

/** One piece of visible text and where it is (`file:line`). */
type Line = { text: string; where: string };
type Add = (text: string, at: ts.Node) => void;

/**
 * Every literal inside an expression, including those inside a template's
 * `${…}` parts. Nested JSX is read by the main walk; calls and comparisons are code.
 */
const literals = (node: ts.Node, add: Add) => {
  if (ts.isStringLiteralLike(node)) add(node.text, node);
  else if (ts.isTemplateExpression(node)) {
    add([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '), node);
    node.templateSpans.forEach((span) => literals(span.expression, add));
  } else if (!isCode(node)) {
    ts.forEachChild(node, (child) => literals(child, add));
  }
};

/** The text a person can read in one source file, with the line each piece is on. */
export const visibleLines = (source: string, fileName = 'file.tsx'): Line[] => {
  const lines: Line[] = [];
  const seen = new Set<string>();
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const add: Add = (raw, at) => {
    const text = clean(raw);
    if (!text) return;
    const start = at.getStart(file) + Math.max(at.getText(file).search(/\S/), 0);
    const where = `${fileName}:${file.getLineAndCharacterOfPosition(start).line + 1}`;
    const key = `${text}\0${where}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ text, where });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text, node);
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) literals(node.expression, add);
    else if (ts.isJsxAttribute(node) && node.initializer && VISIBLE_ATTRIBUTES.has(node.name.getText(file))) literals(node.initializer, add);
    else if (ts.isPropertyAssignment(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(file).replace(/['"]/g, ''))) literals(node.initializer, add);
    else if (ts.isCallExpression(node) && VISIBLE_CALL.test(node.expression.getText(file))) node.arguments.forEach((argument) => literals(argument, add));
    else if (ts.isNewExpression(node) && node.expression.getText(file).endsWith('Error')) node.arguments?.forEach((argument) => literals(argument, add));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
};

/** The text a person can read in one source file. */
export const visibleText = (source: string, fileName = 'file.tsx') => new Set(visibleLines(source, fileName).map((line) => line.text));

/** Each problem names the file and line, so it can be found even when the text is put together from parts. */
const problemsIn = (lines: Line[]) => lines.flatMap(({ text, where }) => WORDS
  .filter(([word]) => word.test(text))
  .map(([word, use]) => ({ where, text, word: word.source, use })));
const asLines = (texts: string[]): Line[] => texts.map((text) => ({ text, where: 'example' }));

const uiRoot = resolve(__dirname, '../src/ui');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
// Sample data and the development-only reference page never reach a person using a node.
const sources = walk(uiRoot)
  .filter((path) => /\.tsx?$/.test(path))
  .filter((path) => !/^(mocks|design-system)\b/.test(relative(uiRoot, path).replace(/\\/g, '/')));
const packageRoot = resolve(__dirname, '..');
const allLines = sources.flatMap((path) => visibleLines(readFileSync(path, 'utf8'), relative(packageRoot, path).replace(/\\/g, '/')));
const allText = new Set(allLines.map((line) => line.text));

describe('writing rules', () => {
  it('reads every kind of visible text', () => {
    const lines = visibleText(`
      const shown = { label: 'Object label', className: 'not-text' };
      toast('Toast message.');
      throw new Error('Error message');
      export const View = () => (
        <div className="not-text" title="Attribute text" aria-label={ready ? 'Ready name' : 'Waiting name'}>
          Plain text
          {busy ? 'Busy text' : <b data-id="not-text">Nested text</b>}
          {mode === 'not-text' ? 'Mode text' : null}
          <i title={\`Status: \${busy ? 'Template busy' : 'Template idle'}\`} />
          <i title={\`Kind: \${kind === 'not-text' ? 'Kind one' : 'Kind two'}\`} />
        </div>
      );
    `);
    expect([...lines].sort()).toEqual([
      'Attribute text', 'Busy text', 'Error message', 'Kind one', 'Kind two', 'Kind:', 'Mode text', 'Nested text',
      'Object label', 'Plain text', 'Ready name', 'Status:', 'Template busy', 'Template idle', 'Toast message.', 'Waiting name',
    ]);
  });

  it('fails a listed word inside a template interpolation', () => {
    const lines = visibleLines('<div title={`Status: ${busy ? \'processing\' : \'Ready\'}`} />', 'example.tsx');
    expect(problemsIn(lines)).toEqual([{ where: 'example.tsx:1', text: 'processing', word: '\\bprocessing\\b', use: 'In progress' }]);
  });

  it('says where each piece of text is', () => {
    const lines = visibleLines('const a = 1;\nexport const View = () => (\n  <p>\n    Shown text\n  </p>\n);\n', 'view.tsx');
    expect(lines).toEqual([{ text: 'Shown text', where: 'view.tsx:4' }]);
  });

  it('finds real text in the UI', () => {
    for (const known of ['Retry loading agent', 'Copy UAL', 'Context Graph']) {
      expect([...allText].some((line) => line.includes(known)), known).toBe(true);
    }
  });

  it('fails a listed word', () => {
    expect(problemsIn(asLines(['Check the daemon'])).map((problem) => problem.use)).toEqual(['node']);
    expect(problemsIn(asLines(['2 · Commitment'])).map((problem) => problem.use)).toEqual(['a label and its detail take a colon']);
    expect(problemsIn(asLines(['PDF · 8.4 MB', 'Check the node']))).toEqual([]);
  });

  it('keeps UI text to the word list', () => {
    expect(problemsIn(allLines.filter((line) => !PENDING.has(line.text)))).toEqual([]);
  });

  it('keeps the pending list short', () => {
    expect([...PENDING].filter((line) => !allText.has(line) || problemsIn(asLines([line])).length === 0)).toEqual([]);
  });
});
