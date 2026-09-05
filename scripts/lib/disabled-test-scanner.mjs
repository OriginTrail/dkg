import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_NAME = /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIRECTORY = /(^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)/;
const VITEST_CONFIG_FILE = /(^|\/)(?:vitest(?:[.-][^/]*)?|vite\.config)\.[cm]?[jt]sx?$/i;
const TEST_EXCLUSION_PATH = /(^|\/)(?:test|tests|__tests__|spec|e2e)(?:\/|$)/i;
const TEST_EXCLUSION_FILE = /\.(?:test|spec)\.[^/]+$/i;
const EXCLUDED_TREE = /(^|\/)(?:node_modules|dist|build|out|generated|coverage|\.nyc_output|\.turbo)(?:\/|$)/;
const D1_ARCHIVE_TREE = /(^|\/)(?:test|tests)\/archive(?:\/|$)/;
const DIRECT_BASES = new Set(['describe', 'it', 'suite', 'test']);
const DIRECT_MEMBERS = new Set(['skip', 'todo', 'skipIf', 'runIf']);
const CONDITIONAL_MEMBERS = new Set(['skipIf', 'runIf']);
const FOCUSED_ALIASES = new Set(['fit', 'fdescribe', 'ftest']);
const LEGACY_ALIASES = new Set(['xdescribe', 'xit', 'xtest']);
const TICKET = /^(?:#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|[A-Z][A-Z0-9]*-\d+)$/i;
const AST_PRINTER = ts.createPrinter({ removeComments: true });

function scriptKindFor(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizedPath(filePath) {
  return filePath.replaceAll(path.sep, '/');
}

function normalizedStaticTitle(node) {
  if (!node || !ts.isStringLiteralLike(node)) return undefined;
  return node.text.replace(/\s+/g, ' ').trim();
}

function normalizedFragment(node, sourceFile) {
  return AST_PRINTER
    .printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/\s+/g, ' ')
    .trim();
}

function d1Fingerprint(pattern, titleNode, fallbackNode, sourceFile) {
  const identity = normalizedStaticTitle(titleNode)
    ?? normalizedFragment(fallbackNode, sourceFile);
  return createHash('sha1').update(`D1:${pattern}:${identity}`).digest('hex');
}

function d2Fingerprint(value, opaque) {
  const pattern = opaque ? 'opaque' : 'static';
  return createHash('sha1').update(`D2:vitest.exclude:${pattern}:${value}`).digest('hex');
}

function propertyNameText(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    ? name.text
    : undefined;
}

function bindingNameIncludes(name, identifier) {
  if (ts.isIdentifier(name)) return name.text === identifier;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element)
      && bindingNameIncludes(element.name, identifier),
  );
}

function lexicalBinding(scope, identifier) {
  if (ts.isFunctionLike(scope)) {
    const parameter = scope.parameters.find(
      ({ name }) => bindingNameIncludes(name, identifier),
    );
    if (parameter) return { declaration: parameter, isConst: false };
  }
  if (
    ts.isCatchClause(scope)
    && scope.variableDeclaration
    && bindingNameIncludes(scope.variableDeclaration.name, identifier)
  ) {
    return { declaration: scope.variableDeclaration, isConst: false };
  }
  if (
    ts.isForStatement(scope)
    && scope.initializer
    && ts.isVariableDeclarationList(scope.initializer)
  ) {
    const declaration = scope.initializer.declarations.find(
      ({ name }) => bindingNameIncludes(name, identifier),
    );
    if (declaration) {
      return {
        declaration,
        isConst: Boolean(scope.initializer.flags & ts.NodeFlags.Const),
      };
    }
  }
  if (
    (ts.isForOfStatement(scope) || ts.isForInStatement(scope))
    && ts.isVariableDeclarationList(scope.initializer)
  ) {
    const declaration = scope.initializer.declarations.find(
      ({ name }) => bindingNameIncludes(name, identifier),
    );
    if (declaration) {
      return {
        declaration,
        isConst: Boolean(scope.initializer.flags & ts.NodeFlags.Const),
      };
    }
  }
  if (ts.isCaseBlock(scope)) {
    for (const clause of scope.clauses) {
      for (const statement of clause.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const declaration = statement.declarationList.declarations.find(
          ({ name }) => bindingNameIncludes(name, identifier),
        );
        if (declaration) {
          return {
            declaration,
            isConst: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
          };
        }
      }
    }
  }
  if (!ts.isSourceFile(scope) && !ts.isBlock(scope)) return undefined;
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      ({ name }) => bindingNameIncludes(name, identifier),
    );
    if (declaration) {
      return {
        declaration,
        isConst: Boolean(statement.declarationList.flags & ts.NodeFlags.Const),
      };
    }
  }
  return undefined;
}

function staticConstantInitializer(node) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    const binding = lexicalBinding(scope, node.text);
    if (!binding) continue;
    return binding.isConst
      && ts.isIdentifier(binding.declaration.name)
      && binding.declaration.initializer
      ? binding.declaration.initializer
      : undefined;
  }
  return undefined;
}

function unwrapTransparentExpression(node) {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function exclusionEntries(node, sourceFile, arraysAllowed = false, seen = new Set()) {
  node = unwrapTransparentExpression(node);
  if (ts.isOmittedExpression(node)) return [];
  if (ts.isStringLiteralLike(node)) return [{ value: node.text, opaque: false }];
  if (ts.isIdentifier(node)) {
    const initializer = staticConstantInitializer(node);
    if (!initializer || seen.has(initializer)) {
      return [{ value: normalizedFragment(node, sourceFile), opaque: true }];
    }
    return exclusionEntries(
      initializer,
      sourceFile,
      arraysAllowed,
      new Set([...seen, initializer]),
    );
  }
  if (!arraysAllowed || !ts.isArrayLiteralExpression(node)) {
    return [{ value: normalizedFragment(node, sourceFile), opaque: true }];
  }

  const entries = [];
  for (const element of node.elements) {
    const resolved = ts.isSpreadElement(element)
      ? exclusionEntries(element.expression, sourceFile, true, seen)
      : exclusionEntries(element, sourceFile, false, seen);
    entries.push(...resolved);
  }
  return entries;
}

function exclusionElements(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  return [node];
}

function resolvedExclusionEntries(element, sourceFile, arrayInitializer) {
  if (ts.isSpreadElement(element)) {
    return exclusionEntries(element.expression, sourceFile, true);
  }
  if (!arrayInitializer) return exclusionEntries(element, sourceFile, true);
  return exclusionEntries(element, sourceFile);
}

function isTestTargetingExclusion(value) {
  const candidate = value.replaceAll('\\', '/');
  return TEST_EXCLUSION_PATH.test(candidate) || TEST_EXCLUSION_FILE.test(candidate);
}

function sourceComments(source, sourceFile, filePath) {
  const languageVariant = /\.[jt]sx$/i.test(filePath)
    ? ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, languageVariant, source);
  const comments = [];

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia
      && token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) continue;

    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    comments.push({
      text: source.slice(start, end),
      line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      endLine: sourceFile.getLineAndCharacterOfPosition(end - 1).line + 1,
    });
  }
  return comments;
}

function pragmaRule(comment) {
  const body = comment.text
    .replace(/^\/\//, '')
    .replace(/^\/\*/, '')
    .replace(/\*\/$/, '')
    .trim();
  const match = body.match(/^test-disable-allow:\s*(D[12])\s+(\S+)\s+--\s*(.+)$/i);
  if (!match || !TICKET.test(match[2]) || !match[3].trim()) return undefined;
  return match[1].toUpperCase();
}

function isAllowed(finding, comments) {
  return comments.some((comment) => {
    const distance = finding.line - comment.endLine;
    return distance >= 1 && distance <= 3 && pragmaRule(comment) === finding.rule;
  });
}

export function isD1ScannableFile(filePath) {
  const candidate = normalizedPath(filePath);
  return SOURCE_EXTENSION.test(candidate)
    && !EXCLUDED_TREE.test(candidate)
    && !D1_ARCHIVE_TREE.test(candidate)
    && (TEST_FILE_NAME.test(path.posix.basename(candidate)) || TEST_DIRECTORY.test(candidate));
}

export function isD2ScannableFile(filePath) {
  const candidate = normalizedPath(filePath);
  return VITEST_CONFIG_FILE.test(candidate)
    && !TEST_FILE_NAME.test(path.posix.basename(candidate))
    && !EXCLUDED_TREE.test(candidate);
}

export function isScannableFile(filePath) {
  return isD1ScannableFile(filePath) || isD2ScannableFile(filePath);
}

export function analyzeTestSource(source, filePath, { now = new Date(), d1 = isD1ScannableFile(filePath), d2 = isD2ScannableFile(filePath) } = {}) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const imports = new Map();
  const importedNames = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) importedNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) importedNames.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) importedNames.add(item.name.text);
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['vitest', '@playwright/test', 'node:test', 'bun:test'].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name && statement.moduleSpecifier.text === 'node:test') imports.set(clause.name.text, 'test');
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      const original = item.propertyName?.text ?? item.name.text;
      if (DIRECT_BASES.has(original) || LEGACY_ALIASES.has(original) || FOCUSED_ALIASES.has(original)) imports.set(item.name.text, original);
    }
  }
  const member = (node) => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  const shadowed = (node) => {
    for (let scope = node.parent; scope && scope !== sourceFile; scope = scope.parent) {
      if (lexicalBinding(scope, node.text)) return true;
    }
    return false;
  };
  const testBase = (node, seen = new Set()) => {
    node = unwrapTransparentExpression(node);
    if (ts.isIdentifier(node)) {
      if (imports.has(node.text)) return shadowed(node) ? undefined : imports.get(node.text);
      if (importedNames.has(node.text)) return undefined;
      if ((DIRECT_BASES.has(node.text) || LEGACY_ALIASES.has(node.text) || FOCUSED_ALIASES.has(node.text)) && !shadowed(node)) return node.text;
      const initializer = staticConstantInitializer(node);
      if (initializer && !seen.has(initializer)) return testBase(initializer, new Set([...seen, initializer]));
      return undefined;
    }
    if (ts.isCallExpression(node)) return testBase(node.expression, seen);
    if (member(node)) {
      if (ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) && !shadowed(node.expression) && (DIRECT_BASES.has(member(node)) || LEGACY_ALIASES.has(member(node)) || FOCUSED_ALIASES.has(member(node)))) return member(node);
      if (['concurrent', 'sequential', 'each', 'only', 'skip', 'todo', 'skipIf', 'runIf'].includes(member(node))) return testBase(node.expression, seen);
    }
    return undefined;
  };
  const comments = sourceComments(source, sourceFile, filePath);
  const findings = [];
  const focused = [];
  const invalidExceptions = invalidExceptionLines(comments, now);

  const addFinding = (node, api, pattern, titleNode, fallbackNode = node) => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      rule: 'D1',
      api,
      fingerprint: d1Fingerprint(pattern, titleNode, fallbackNode, sourceFile),
      filePath,
      line: location.line + 1,
      column: location.character + 1,
    });
  };

  const visit = (node) => {
    if (d1 && ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && LEGACY_ALIASES.has(testBase(callee))) {
        addFinding(
          callee,
          testBase(callee),
          `legacy:${testBase(callee)}`,
          node.arguments[0],
          node.arguments[0] ?? callee,
        );
      } else if (
        member(callee)
        && DIRECT_BASES.has(testBase(callee.expression))
        && DIRECT_MEMBERS.has(member(callee))
      ) {
        const api = `${testBase(callee.expression)}.${member(callee)}`;
        const conditional = CONDITIONAL_MEMBERS.has(member(callee));
        const declaration = conditional
          && ts.isCallExpression(node.parent)
          && node.parent.expression === node
          ? node.parent
          : node;
        addFinding(
          callee,
          api,
          `${conditional ? 'conditional' : 'declaration'}:${api}`,
          declaration.arguments[0],
          declaration.arguments[0] ?? callee,
        );
      }
    }
    if (
      d1 && DIRECT_MEMBERS.has(member(node))
      && DIRECT_BASES.has(testBase(node.expression))
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const api = `${testBase(node.expression)}.${member(node)}`;
      addFinding(node, api, `reference:${api}`);
    }
    if ((member(node) === 'only' && DIRECT_BASES.has(testBase(node.expression))) ||
        (ts.isCallExpression(node) && FOCUSED_ALIASES.has(testBase(node.expression)))) {
      focused.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    if (d2 &&
      ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === 'test'
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      const exclude = node.initializer.properties.find(
        (property) => ts.isPropertyAssignment(property)
          && propertyNameText(property.name) === 'exclude',
      );
      if (exclude) {
        const initializer = unwrapTransparentExpression(exclude.initializer);
        const arrayInitializer = ts.isArrayLiteralExpression(initializer);
        for (const element of exclusionElements(initializer)) {
          const entries = resolvedExclusionEntries(element, sourceFile, arrayInitializer);
          for (const entry of entries) {
            if (!entry.opaque && !isTestTargetingExclusion(entry.value)) continue;
            const location = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            findings.push({
              rule: 'D2',
              api: 'vitest.exclude',
              value: entry.value,
              fingerprint: d2Fingerprint(entry.value, entry.opaque),
              filePath,
              line: location.line + 1,
              column: location.character + 1,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { disabled: findings.filter((finding) => !isAllowed(finding, comments)), focused: [...new Set(focused)], invalidExceptions };
}

// Compatibility entry points for the reviewed D1/D2 delta and fingerprint API.
export function analyzeD1Source(source, filePath) {
  return analyzeTestSource(source, filePath, { d1: true, d2: false }).disabled;
}
export function analyzeD2Source(source, filePath) {
  return analyzeTestSource(source, filePath, { d1: false }).disabled;
}

function invalidExceptionLines(comments, now) {
  return comments.filter(({ text }) => {
    if (!text.includes('test-disable-allow:')) return false;
    const expiry = /\bexpires=(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1];
    const owner = /\bowner=([\w@.-]+)/.exec(text)?.[1];
    const lane = /\blane=([\w:-]+)/.exec(text)?.[1];
    const date = expiry ? new Date(`${expiry}T23:59:59Z`) : new Date(NaN);
    const remaining = date.valueOf() - now.valueOf();
    return !owner || !lane || !Number.isFinite(remaining) || date.toISOString().slice(0, 10) !== expiry || remaining < 0 || remaining > 31 * 86_400_000;
  }).map(({ line }) => line);
}
