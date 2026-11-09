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
/** Nested JSX is read by the main walk, comparisons are code, and objects are read by their visible property names. */
const isCode = (node: ts.Node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || isComparison(node)
  || ts.isObjectLiteralExpression(node);

/** One piece of visible text and where it is (`file:line`). */
type Line = { text: string; where: string };
type Add = (text: string, at: ts.Node) => void;
type FunctionWithBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** One file on its own, with a type checker, so each name can be followed to the declaration it refers to. */
const parse = (fileName: string, source: string) => {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name.replace(/\\/g, '/').endsWith(fileName.replace(/\\/g, '/')) ? file : undefined);
  host.fileExists = (name) => name.replace(/\\/g, '/').endsWith(fileName.replace(/\\/g, '/'));
  host.readFile = () => source;
  host.writeFile = () => undefined;
  const checker = ts.createProgram({ rootNames: [fileName], options, host }).getTypeChecker();
  return { file, checker };
};

/** The `return` values of a function, not counting functions nested inside it. */
const returnsOf = (fn: FunctionWithBody): ts.Expression[] => {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
};

const isFunctionWithBody = (node: ts.Node | undefined): node is FunctionWithBody => !!node
  && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node));

/**
 * What a name refers to in this file: the value of a `const`, or a local function.
 * Imports, parameters and `let` are not followed.
 */
const declared = (name: ts.Identifier, checker: ts.TypeChecker) => {
  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol || symbol.flags & ts.SymbolFlags.Alias) return [];
  return (symbol.declarations ?? []).flatMap((declaration): { at: ts.Node; value?: ts.Expression; fn?: FunctionWithBody }[] => {
    if (ts.isFunctionDeclaration(declaration)) return [{ at: declaration, fn: declaration }];
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
      const init = declaration.initializer;
      return [isFunctionWithBody(init) ? { at: declaration, fn: init } : { at: declaration, value: init }];
    }
    return [];
  });
};

/**
 * Every literal inside an expression: template text and the literals inside its
 * `${…}` parts, the value of a `const` it names, and what a local function it calls
 * returns. A condition (`a ? …`, `a && …`) and the arguments of a call are code.
 */
const literals = (node: ts.Node, add: Add, checker: ts.TypeChecker, following: ReadonlySet<ts.Node> = new Set()) => {
  const read = (next: ts.Node, via = following) => literals(next, add, checker, via);
  if (ts.isStringLiteralLike(node)) add(node.text, node);
  else if (ts.isTemplateExpression(node)) {
    add([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '), node);
    node.templateSpans.forEach((span) => read(span.expression));
  } else if (ts.isIdentifier(node)) {
    for (const { at, value } of declared(node, checker)) {
      if (value && !following.has(at)) read(value, new Set(following).add(at));
    }
  } else if (ts.isCallExpression(node)) {
    if (!ts.isIdentifier(node.expression)) return;
    for (const { at, fn } of declared(node.expression, checker)) {
      if (fn && !following.has(at)) returnsOf(fn).forEach((value) => read(value, new Set(following).add(at)));
    }
  } else if (ts.isConditionalExpression(node)) {
    read(node.whenTrue);
    read(node.whenFalse);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    read(node.right);
  } else if (!isCode(node)) {
    ts.forEachChild(node, (child) => read(child));
  }
};

/** The text a person can read in one source file, with the line each piece is on. */
export const visibleLines = (source: string, fileName = 'file.tsx'): Line[] => {
  const lines: Line[] = [];
  const seen = new Set<string>();
  const { file, checker } = parse(fileName, source);
  const add: Add = (raw, at) => {
    const text = clean(raw);
    if (!text) return;
    const from = at.getSourceFile();
    const start = at.getStart(from) + Math.max(at.getText(from).search(/\S/), 0);
    const where = `${fileName}:${from.getLineAndCharacterOfPosition(start).line + 1}`;
    const key = `${text}\0${where}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ text, where });
  };
  const read = (node: ts.Node) => literals(node, add, checker);
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text, node);
    else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) read(node.expression);
    else if (ts.isJsxAttribute(node) && node.initializer && VISIBLE_ATTRIBUTES.has(node.name.getText(file))) read(node.initializer);
    else if (ts.isPropertyAssignment(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(file).replace(/['"]/g, ''))) read(node.initializer);
    else if (ts.isCallExpression(node) && VISIBLE_CALL.test(node.expression.getText(file))) node.arguments.forEach(read);
    else if (ts.isNewExpression(node) && node.expression.getText(file).endsWith('Error')) node.arguments?.forEach(read);
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

  it('follows text kept in a constant, but not the values it compares', () => {
    const lines = visibleLines(`
      const text = 'Check the daemon';
      const note = mode === 'daemon' ? 'Managed by the daemon' : 'Signed by your wallet';
      const loop = loop;
      export const View = () => <p title={note}>{text}{loop}</p>;
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Check the daemon', 'Managed by the daemon', 'Signed by your wallet']);
    expect(problemsIn(lines).map((problem) => `${problem.where} ${problem.use}`).sort()).toEqual(['example.tsx:2 node', 'example.tsx:3 node']);
  });

  it('follows what a local helper returns, but not its conditions', () => {
    const lines = visibleLines(`
      function hint() { return 'Check the daemon'; }
      const label = (mode: string) => mode === 'daemon' ? 'Node wallet' : 'Your wallet';
      function outer() { const inner = () => 'Not returned by outer'; return 'Shown'; }
      setError(hint());
      export const View = () => <p>{label(mode)}{outer()}</p>;
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Check the daemon', 'Node wallet', 'Shown', 'Your wallet']);
    expect(problemsIn(lines).map((problem) => `${problem.where} ${problem.use}`)).toEqual(['example.tsx:2 node']);
  });

  it('follows each name to its own declaration', () => {
    const lines = visibleLines(`
      function internal() { const text = 'daemon'; return text; }
      export function View() { const text = 'Connected'; return <p>{text}</p>; }
      const shadowed = 'Outer daemon';
      export function Inner() { const shadowed = 'Inner text'; return <p>{shadowed}</p>; }
    `, 'example.tsx');
    expect(lines.map((line) => line.text).sort()).toEqual(['Connected', 'Inner text']);
  });

  it('says where each piece of text is', () => {
    const lines = visibleLines('const a = 1;\nexport const View = () => (\n  <p>\n    Shown text\n  </p>\n);\n', 'view.tsx');
    expect(lines).toEqual([{ text: 'Shown text', where: 'view.tsx:4' }]);
  });

  it('finds real text in the UI', () => {
    // Two are kept in constants (walletSurfaceCopy, ownerNote) and one comes from a helper (formatJoinRequestError).
    for (const known of [
      'Retry loading agent', 'Copy UAL', 'Context Graph', 'Your connected wallet isn’t needed here', 'Managed by this node',
      'out-of-date network setting',
    ]) {
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
