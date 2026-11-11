// The text a person can read in the node UI, for the writing checks (DESIGN.md · Writing).
// visibleLines reads one source file; shownLines is every piece of shown text in src/ui,
// with the file and line it is on. Checks that look at code syntax read the source instead.
import ts from 'typescript';
import { COPY } from '../../src/ui/marketplace/copy.generated';
import { codeFiles, read, where } from './source.js';

/**
 * Names people see or hear: JSX attributes, and object properties anywhere in `src/ui`.
 * In UI code an object's `message`, `body` or `reason` is nearly always copy, such as a toast
 * or an alert built in a hook. An object that is internal data instead can say so (see NOT_SHOWN).
 */
const VISIBLE_ATTRIBUTES = new Set([
  'alt', 'aria-description', 'aria-label', 'body', 'caption', 'confirmLabel', 'cancelLabel', 'description',
  'detail', 'empty', 'emptyText', 'error', 'footnote', 'heading', 'help', 'helperText', 'hint', 'label', 'message',
  'note', 'placeholder', 'reason', 'subtitle', 'summary', 'text', 'title', 'tooltip',
]);
/**
 * A comment that marks an object property, or a whole object, as data that never reaches the screen:
 * `{ reason: 'not admitted' } // writing-rules: not shown` or `// writing-rules: not shown` on the line above.
 */
const NOT_SHOWN = /writing-rules:\s*not shown/;
const VISIBLE_CALL = /^(toast|notify|alert|confirm|set(Error|Notice|Message|Warning)\w*)$|\.(toast|notify)$/;

const clean = (text: string) => text.replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();

const propertyName = (node: ts.PropertyAssignment) => node.name.getText().replace(/['"]/g, '');

/** Whether a node, or the object or statement it sits in, is marked NOT_SHOWN on its own line or on a comment line just above. */
const markedNotShown = (node: ts.Node) => {
  const file = node.getSourceFile();
  const lines = file.text.split('\n');
  for (let at: ts.Node | undefined = node; at && !ts.isSourceFile(at) && !ts.isFunctionLike(at); at = at.parent) {
    const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line;
    const above = (lines[line - 1] ?? '').trim();
    if (NOT_SHOWN.test(lines[line] ?? '') || (above.startsWith('//') && NOT_SHOWN.test(above))) return true;
    if (ts.isStatement(at)) return false;
  }
  return false;
};
const isProperty = (node: ts.Node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
  && VISIBLE_ATTRIBUTES.has(propertyName(node)) && !markedNotShown(node);

/** One piece of visible text and where it is (`file:line`). */
export type Line = { text: string; where: string };
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

type Following = ReadonlySet<ts.Node>;

/** Wrappers that don't change a value: `(x)`, `x as T`, `x satisfies T`, `x!`. */
const unwrap = (node: ts.Expression): ts.Expression => (
  ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
  || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)
    ? unwrap(node.expression) : node
);

/** The object literal an expression stands for: written in place, or the value of a `const` it names. */
const objectOf = (node: ts.Expression, checker: ts.TypeChecker): ts.ObjectLiteralExpression | undefined => {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return undefined;
  const found = declared(value, checker).map((d) => d.value && unwrap(d.value)).find((v) => v && ts.isObjectLiteralExpression(v));
  return found as ts.ObjectLiteralExpression | undefined;
};

/** The values a lookup can produce: `labels.name` or `labels['name']` gives that property, `labels[key]` gives every value. */
const lookedUp = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, checker: ts.TypeChecker) => {
  const object = objectOf(node.expression, checker);
  if (!object) return [];
  const key = ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  return object.properties.filter(ts.isPropertyAssignment)
    .filter((property) => key === undefined || propertyName(property) === key)
    .map((property) => property.initializer);
};

/**
 * The text an expression can produce, read only from the forms listed here.
 * Anything else, such as a comparison, a condition, a call argument or a lookup key,
 * is opaque: it is code, not copy.
 */
const literals = (node: ts.Node, add: Add, checker: ts.TypeChecker, following: Following = new Set()): void => {
  const read = (next: ts.Node, via = following) => literals(next, add, checker, via);
  const through = (at: ts.Node, values: ts.Node[]) => {
    if (!following.has(at)) values.forEach((value) => read(value, new Set(following).add(at)));
  };

  // Text itself.
  if (ts.isStringLiteralLike(node)) add(node.text, node);
  else if (ts.isTemplateExpression(node)) {
    add([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '), node);
    node.templateSpans.forEach((span) => read(span.expression));
  }
  // Wrappers around a value.
  else if (ts.isJsxExpression(node)) { if (node.expression) read(node.expression); }
  else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) read(node.expression);
  // A choice between values: the branches, never the condition.
  else if (ts.isConditionalExpression(node)) { read(node.whenTrue); read(node.whenFalse); }
  else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) read(node.right);
    else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
      read(node.left);
      read(node.right);
    }
  }
  // Values kept elsewhere in the file.
  else if (ts.isIdentifier(node)) {
    for (const { at, value } of declared(node, checker)) if (value) through(at, [value]);
  } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    for (const { at, fn } of declared(node.expression, checker)) if (fn) through(at, returnsOf(fn));
  } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    through(node, lookedUp(node, checker));
  }
  // Collections: every item of a list, and the properties people see on an object.
  else if (ts.isArrayLiteralExpression(node)) node.elements.forEach((element) => read(element));
  else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) if (isProperty(property)) read(property.initializer);
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
    else if (isProperty(node)) read(node.initializer);
    else if (ts.isCallExpression(node) && VISIBLE_CALL.test(node.expression.getText(file))) node.arguments.forEach(read);
    else if (ts.isNewExpression(node) && node.expression.getText(file).endsWith('Error')) node.arguments?.forEach(read);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
};

/** The text a person can read in one source file. */
export const visibleText = (source: string, fileName = 'file.tsx') => new Set(visibleLines(source, fileName).map((line) => line.text));

// Findings name files from the package root (src/ui/…), so they can be opened as written.
const fromPackage = (file: string) => `src/ui/${where(file)}`;
// Sample data and the development-only reference page never reach a person using a node.
const sources = codeFiles.filter((file) => !/^(mocks|design-system)\b/.test(where(file)));
// The Marketplace keeps its text in one table that components read by key, so every value in it is shown.
// The development-only component gallery is left out, like the reference page above.
const copySource = read('marketplace/copy.generated.ts').split('\n');
const copyLines: Line[] = Object.entries(COPY)
  .filter(([key]) => !key.startsWith('gallery.'))
  .map(([key, text]) => ({
    text: clean(String(text)),
    where: `src/ui/marketplace/copy.generated.ts:${copySource.findIndex((line) => line.includes(`"${key}":`)) + 1}`,
  }));
export const shownLines: Line[] = [
  ...sources.flatMap((file) => visibleLines(read(file), fromPackage(file))),
  ...copyLines,
];
export const shownText = new Set(shownLines.map((line) => line.text));
