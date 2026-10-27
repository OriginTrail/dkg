/**
 * Static scanners for the share queue's control-graph census (OT-RFC-73 AC1 check (3)): which package sources reference the
 * share control graph, which source labels name the queue's store sites, and whether every store call in a queue site file
 * carries the options its row of the §5.1 tagging table requires. They work on source text, so the tests can also run them
 * against fixtures to show they report what they must.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

export const SHARE_CONTROL_GRAPH_IRI = 'urn:dkg:promote-queue:control-plane';
export const SHARE_CONTROL_GRAPH_CONSTANT = 'DEFAULT_PROMOTE_CONTROL_GRAPH_URI';

/** Source labels of the share queue's graph sites: its own `publisher.asyncPromote.*` and the monitoring COUNT. */
const SHARE_LABEL = /^publisher\.asyncPromote\.|^publisher\.queueUsage\.share$/;

export interface SourceText { path: string; text: string }

/** Every `packages/<name>/src/**\/*.ts(x)` file (declaration files left out), as a repository-relative path with its text. */
export function readPackageSources(repoRoot: string): SourceText[] {
  const files: SourceText[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push({ path: relative(repoRoot, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (pkg.isDirectory()) {
      try { walk(join(repoRoot, 'packages', pkg.name, 'src')); } catch { /* a package without src/ */ }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function parse(file: SourceText): ts.SourceFile {
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function visit(sf: ts.SourceFile, fn: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => { fn(node); ts.forEachChild(node, walk); };
  walk(sf);
}

/** Lines of the CODE references to the share control graph: its IRI as a string literal, or the constant that names it. Comments are not references. */
export function graphReferences(file: SourceText): number[] {
  if (!file.text.includes(SHARE_CONTROL_GRAPH_IRI) && !file.text.includes(SHARE_CONTROL_GRAPH_CONSTANT)) return [];
  const sf = parse(file);
  const lines: number[] = [];
  visit(sf, (node) => {
    if ((ts.isStringLiteralLike(node) && node.text.includes(SHARE_CONTROL_GRAPH_IRI))
      || (ts.isIdentifier(node) && node.text === SHARE_CONTROL_GRAPH_CONSTANT)) lines.push(lineOf(sf, node));
  });
  return lines;
}

/** Every string literal that is a share store site label, with its line. A label is one literal: sharing it makes two sites indistinguishable. */
export function labelOccurrences(file: SourceText): Array<{ label: string; line: number }> {
  if (!file.text.includes('publisher.asyncPromote.') && !file.text.includes('publisher.queueUsage.share')) return [];
  const sf = parse(file);
  const found: Array<{ label: string; line: number }> = [];
  visit(sf, (node) => {
    if (ts.isStringLiteralLike(node) && SHARE_LABEL.test(node.text)) found.push({ label: node.text, line: lineOf(sf, node) });
  });
  return found;
}

/** Method name -> index of its options argument (the store methods a queue site may call). */
const STORE_METHOD_OPTIONS: Readonly<Record<string, number>> = {
  query: 1, update: 1, insert: 1, delete: 1, deleteByPattern: 1, deleteBySubjectPrefix: 2, replaceSubject: 3,
  replaceSubjectAndInsert: 4, replaceGraph: 2, dropGraph: 1, hasGraph: 1, countQuads: 1,
};
/** Free helper -> index of its options argument. `createGraph` and `flush` are exempt: the queue passes no options and neither reaches a scheduler. */
const STORE_HELPER_OPTIONS: Readonly<Record<string, number>> = {
  deleteByPatternWithoutCount: 2, tryReplaceSubjectAtomically: 4, tryReplaceSubjectAndInsertAtomically: 5,
  replaceSubjectAtomicallyOrFallback: 4, readPromoteOwnershipCandidates: 3,
};

/**
 * `parameter` is a REQUIRED pass-through parameter: its caller must name the options. A parameter with a default or a `?` is
 * `defaulted-parameter` and no site file allows it, because a default would let a caller that omits the options make an
 * untagged read of the control graph under a queue label.
 */
export type OptionsClass = 'control' | 'reader' | 'monitoring' | 'parameter' | 'defaulted-parameter' | 'other' | 'missing';

function isShareControlCall(expr: ts.Expression): boolean {
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'controlStoreOptions'
    && expr.arguments.length === 2 && ts.isStringLiteralLike(expr.arguments[0]!) && expr.arguments[0].text === 'share';
}

/** The declaration `id` refers to: the nearest enclosing function's parameter, or a variable declared directly in an enclosing block or the file. */
function declarationOf(id: ts.Identifier): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
      if (parameter) return parameter;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const variable = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === id.text);
        if (variable) return variable;
      }
    }
  }
  return undefined;
}

/** What the options argument of a store call is: the share control tag, the lock-free reader's own options, a required pass-through parameter, or something else. */
export function classifyOptions(expr: ts.Expression | undefined, sf: ts.SourceFile, depth = 0): OptionsClass {
  if (!expr) return 'missing';
  // `Object.freeze(x)` is `x`: the reader's module-level options are frozen.
  if (ts.isCallExpression(expr) && expr.arguments.length === 1 && expr.expression.getText(sf) === 'Object.freeze') {
    return classifyOptions(expr.arguments[0], sf, depth + 1);
  }
  if (isShareControlCall(expr)) return 'control';
  // The monitoring reads build their background options with `readOptions('publisher.queueUsage.<queue>', signal)`.
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'readOptions'
    && ts.isStringLiteralLike(expr.arguments[0]!) && expr.arguments[0].text.startsWith('publisher.queueUsage.')) return 'monitoring';
  if (ts.isObjectLiteralExpression(expr)) {
    if (expr.properties.some((p) => ts.isSpreadAssignment(p) && classifyOptions(p.expression, sf, depth + 1) === 'control')) return 'control';
    const source = expr.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'source');
    if (source && ts.isStringLiteralLike(source.initializer) && source.initializer.text === 'publisher.asyncPromote.ownershipReader') return 'reader';
    return 'other';
  }
  if (ts.isIdentifier(expr) && depth < 4) {
    const declaration = declarationOf(expr);
    if (!declaration) return 'other';
    if (ts.isParameter(declaration)) return declaration.initializer || declaration.questionToken ? 'defaulted-parameter' : 'parameter';
    return declaration.initializer ? classifyOptions(declaration.initializer, sf, depth + 1) : 'other';
  }
  return 'other';
}

export interface StoreSite { line: number; callee: string; options: OptionsClass }

/** Every store call of a file (store methods on a `store` receiver, and the free helpers) with how its options argument is formed. */
export function storeSites(file: SourceText): StoreSite[] {
  const sf = parse(file);
  const sites: StoreSite[] = [];
  visit(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    let index: number | undefined;
    let callee = '';
    if (ts.isPropertyAccessExpression(node.expression) && /(?:^|\.)store\??$/.test(node.expression.expression.getText(sf))) {
      callee = node.expression.name.text;
      index = STORE_METHOD_OPTIONS[callee];
    } else if (ts.isIdentifier(node.expression)) {
      callee = node.expression.text;
      index = STORE_HELPER_OPTIONS[callee];
    }
    if (index !== undefined) sites.push({ line: lineOf(sf, node), callee, options: classifyOptions(node.arguments[index], sf) });
  });
  return sites;
}
