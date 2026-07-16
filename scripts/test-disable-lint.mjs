#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

function d2Fingerprint(value) {
  return createHash('sha1').update(`D2:vitest.exclude:${value}`).digest('hex');
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
      && binding.declaration.initializer
      ? binding.declaration.initializer
      : undefined;
  }
  return undefined;
}

function staticExclusionValues(node, arraysAllowed = false, seen = new Set()) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isIdentifier(node)) {
    const initializer = staticConstantInitializer(node);
    if (!initializer || seen.has(initializer)) return undefined;
    return staticExclusionValues(
      initializer,
      arraysAllowed,
      new Set([...seen, initializer]),
    );
  }
  if (!arraysAllowed || !ts.isArrayLiteralExpression(node)) return undefined;

  const values = [];
  for (const element of node.elements) {
    const resolved = ts.isSpreadElement(element)
      ? staticExclusionValues(element.expression, true, seen)
      : staticExclusionValues(element, false, seen);
    if (resolved) values.push(...resolved);
  }
  return values;
}

function exclusionElements(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  return [node];
}

function exclusionElementValues(element, arrayInitializer) {
  if (ts.isSpreadElement(element)) {
    return staticExclusionValues(element.expression, true) ?? [];
  }
  if (!arrayInitializer) return staticExclusionValues(element, true) ?? [];
  return staticExclusionValues(element) ?? [];
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

function isScannableFile(filePath) {
  return isD1ScannableFile(filePath) || isD2ScannableFile(filePath);
}

export function analyzeD1Source(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const comments = sourceComments(source, sourceFile, filePath);
  const findings = [];

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
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && LEGACY_ALIASES.has(callee.text)) {
        addFinding(
          callee,
          callee.text,
          `legacy:${callee.text}`,
          node.arguments[0],
          node.arguments[0] ?? callee,
        );
      } else if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && DIRECT_BASES.has(callee.expression.text)
        && DIRECT_MEMBERS.has(callee.name.text)
      ) {
        const api = `${callee.expression.text}.${callee.name.text}`;
        const conditional = CONDITIONAL_MEMBERS.has(callee.name.text);
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
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && DIRECT_BASES.has(node.expression.text)
      && node.name.text === 'skip'
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const api = `${node.expression.text}.${node.name.text}`;
      addFinding(node, api, `reference:${api}`);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings.filter((finding) => !isAllowed(finding, comments));
}

export function analyzeD2Source(source, filePath) {
  if (!isD2ScannableFile(filePath)) return [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const findings = [];

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === 'test'
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      const exclude = node.initializer.properties.find(
        (property) => ts.isPropertyAssignment(property)
          && propertyNameText(property.name) === 'exclude',
      );
      if (exclude) {
        const arrayInitializer = ts.isArrayLiteralExpression(exclude.initializer);
        for (const element of exclusionElements(exclude.initializer)) {
          for (const value of exclusionElementValues(element, arrayInitializer)) {
            if (!isTestTargetingExclusion(value)) continue;
            const location = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            findings.push({
              rule: 'D2',
              api: 'vitest.exclude',
              value,
              fingerprint: d2Fingerprint(value),
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
  return findings;
}

export function auditFiles(filePaths) {
  return filePaths.flatMap((filePath) => {
    const scansD1 = isD1ScannableFile(filePath);
    const scansD2 = isD2ScannableFile(filePath);
    if (!scansD1 && !scansD2) return [];
    const source = readFileSync(filePath, 'utf8');
    return [
      ...(scansD1 ? analyzeD1Source(source, filePath) : []),
      ...(scansD2 ? analyzeD2Source(source, filePath) : []),
    ];
  });
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function changedEntries(baseRevision, headRevision, cwd) {
  const entries = [];
  const fields = git([
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--find-copies-harder',
    '--diff-filter=ACDMR',
    baseRevision,
    headRevision,
  ], cwd).split('\0');

  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const firstPath = fields[index++];
    const secondPath = status.startsWith('R') || status.startsWith('C')
      ? fields[index++]
      : undefined;
    if (status.startsWith('R')) {
      if (isScannableFile(firstPath) || isScannableFile(secondPath)) {
        entries.push({
          basePath: isScannableFile(firstPath) ? firstPath : null,
          headPath: isScannableFile(secondPath) ? secondPath : null,
        });
      }
    } else if (status.startsWith('C')) {
      if (isScannableFile(secondPath)) {
        entries.push({ basePath: null, headPath: secondPath });
      }
    } else if (isScannableFile(firstPath)) {
      entries.push({
        basePath: status === 'A' ? null : firstPath,
        headPath: status === 'D' ? null : firstPath,
      });
    }
  }
  return entries;
}

function findingsAt(revision, filePath, cwd) {
  if (!filePath) return [];
  const source = git(['show', `${revision}:${filePath}`], cwd);
  return [
    ...(isD1ScannableFile(filePath) ? analyzeD1Source(source, filePath) : []),
    ...(isD2ScannableFile(filePath) ? analyzeD2Source(source, filePath) : []),
  ];
}

export function computeDiffFindings(baseRevision, headRevision, cwd = process.cwd()) {
  const entries = changedEntries(baseRevision, headRevision, cwd);
  const baseline = new Map();
  for (const entry of entries) {
    for (const finding of findingsAt(baseRevision, entry.basePath, cwd)) {
      baseline.set(finding.fingerprint, (baseline.get(finding.fingerprint) ?? 0) + 1);
    }
  }

  const results = entries.flatMap((entry) => findingsAt(headRevision, entry.headPath, cwd))
    .map((finding) => {
      const remaining = baseline.get(finding.fingerprint) ?? 0;
      if (remaining === 0) return { ...finding, verdict: 'new' };
      baseline.set(finding.fingerprint, remaining - 1);
      return { ...finding, verdict: 'grandfathered' };
    });
  return { results };
}

function runDiff(baseRevision, headRevision) {
  const blocking = computeDiffFindings(baseRevision, headRevision).results
    .filter(({ verdict }) => verdict === 'new');
  for (const finding of blocking) {
    process.stdout.write(
      `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
    );
  }
  return blocking.length === 0 ? 0 : 1;
}

function listTrackedFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter(isScannableFile);
}

function semanticMoveSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-move-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, 'test/original.test.ts'),
      "test.skip('existing debt', () => {});\n",
    );
    writeFileSync(
      path.join(fixtureRoot, 'test/untouched.test.ts'),
      "it.todo('untouched debt');\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    git('mv', 'test/original.test.ts', 'test/moved.test.ts');
    writeFileSync(
      path.join(fixtureRoot, 'test/moved.test.ts'),
      "\n\ntest.skip('existing debt', () => {});\n",
    );
    git('add', '-A');
    git('commit', '-qm', 'move disabled test');
    const head = git('rev-parse', 'HEAD').trim();
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, TEST_DISABLE_LINT_NO_SELF_TEST: '1' },
      },
    );
    const pass = cli.status === 0 && cli.stdout === '';
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: semantic move exit=${cli.status}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function semanticGrowthSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-growth-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
    const fixturePath = path.join(fixtureRoot, 'test/original.test.ts');
    const disabledTest = "test.skip('copied debt', () => {});\n";
    writeFileSync(fixturePath, disabledTest);
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    const copiedPath = path.join(fixtureRoot, 'test/café\tcopy.test.ts');
    copyFileSync(fixturePath, copiedPath);
    git('add', '-A');
    git('commit', '-qm', 'copy disabled test');
    const head = git('rev-parse', 'HEAD').trim();
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, TEST_DISABLE_LINT_NO_SELF_TEST: '1' },
      },
    );
    const diagnostics = cli.stdout
      .trim()
      .split('\n')
      .filter((line) => line.includes(': D1 '));
    const expected = ['test/café\tcopy.test.ts:1:1: D1 test.skip'];
    const pass = cli.status === 1 && JSON.stringify(diagnostics) === JSON.stringify(expected);
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: semantic growth exit=${cli.status}\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function auditModesSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-audit-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    const relativeFixturePath = 'test/café\tdebt.test.ts';
    const fixturePath = path.join(fixtureRoot, relativeFixturePath);
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, "it.todo('audit debt');\n");
    git('add', '-A');

    const spawnAudit = (args) => spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...args],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, TEST_DISABLE_LINT_NO_SELF_TEST: '1' },
      },
    );
    const fileAudit = spawnAudit(['--files', fixturePath]);
    const fullAudit = spawnAudit(['--all']);
    const pass = fileAudit.status === 0
      && fileAudit.stdout.trim() === `${fixturePath}:1:1: D1 it.todo`
      && fullAudit.status === 0
      && fullAudit.stdout.trim() === `${relativeFixturePath}:1:1: D1 it.todo`;
    if (!pass) {
      process.stderr.write(
        'SELF-TEST FAIL: audit modes did not report debt without failure\n'
          + `--files exit=${fileAudit.status}\nstdout:\n${fileAudit.stdout}\nstderr:\n${fileAudit.stderr}`
          + `--all exit=${fullAudit.status}\nstdout:\n${fullAudit.stdout}\nstderr:\n${fullAudit.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function staticD2ArraySelfTest() {
  const source = [
    "const TEST_EXCLUSIONS = ['tests/unit/**'];",
    "const NESTED_EXCLUSIONS = ['coverage/**', ...TEST_EXCLUSIONS];",
    "const EXCLUSIONS = [...NESTED_EXCLUSIONS, '**/*.spec.ts'];",
    'export default { test: { exclude: EXCLUSIONS } };',
  ].join('\n');
  const values = analyzeD2Source(source, 'vitest.config.ts').map(({ value }) => value);
  const expected = ['tests/unit/**', '**/*.spec.ts'];
  const pass = JSON.stringify(values) === JSON.stringify(expected);
  if (!pass) {
    process.stderr.write(
      `SELF-TEST FAIL: static D2 arrays expected ${JSON.stringify(expected)}, `
        + `received ${JSON.stringify(values)}\n`,
    );
  }
  return pass;
}

function opaqueD2RatchetSelfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'test-disable-lint-opaque-d2-'));
  const git = (...args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    git('init', '-q');
    git('config', 'user.email', 'selftest@example.invalid');
    git('config', 'user.name', 'test-disable-lint-selftest');
    const configPath = path.join(fixtureRoot, 'vitest.config.ts');
    writeFileSync(configPath, [
      'export default {',
      '  test: {',
      '    exclude: [',
      '      legacyExclusions(),',
      '    ],',
      '  },',
      '};',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    writeFileSync(configPath, [
      'export default {',
      '  test: {',
      '    exclude: [',
      '      legacyExclusions(),',
      '',
      '      // test-disable-allow: D2 #123 -- generated test inventory',
      '      allowedExclusions(),',
      '',
      '',
      '',
      '      // test-disable-allow: D1 #124 -- wrong rule cannot allow D2',
      '      wrongRuleExclusions(),',
      '',
      '',
      '',
      '      newExclusions(),',
      '    ],',
      '  },',
      '};',
    ].join('\n'));
    git('add', '-A');
    git('commit', '-qm', 'head');
    const head = git('rev-parse', 'HEAD').trim();

    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--diff', base, head],
      {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, TEST_DISABLE_LINT_NO_SELF_TEST: '1' },
      },
    );
    const diagnostics = cli.stdout.trim().split('\n');
    const expected = [
      'vitest.config.ts:12:7: D2 vitest.exclude',
      'vitest.config.ts:16:7: D2 vitest.exclude',
    ];
    const pass = cli.status === 1
      && JSON.stringify(diagnostics) === JSON.stringify(expected);
    if (!pass) {
      process.stderr.write(
        `SELF-TEST FAIL: opaque D2 ratchet exit=${cli.status}\n`
          + `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
      );
    }
    return pass;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function selfTest({ report = true } = {}) {
  const movePasses = semanticMoveSelfTest();
  const growthPasses = semanticGrowthSelfTest();
  const auditsPass = auditModesSelfTest();
  const staticD2ArraysPass = staticD2ArraySelfTest();
  const opaqueD2RatchetPass = opaqueD2RatchetSelfTest();
  if (report) {
    process.stdout.write(
      `test-disable-lint self-test: semantic move ${movePasses ? 'pass' : 'FAIL'}, `
        + `semantic growth ${growthPasses ? 'pass' : 'FAIL'}, `
        + `audit modes ${auditsPass ? 'pass' : 'FAIL'}, `
        + `static D2 arrays ${staticD2ArraysPass ? 'pass' : 'FAIL'}, `
        + `opaque D2 ratchet ${opaqueD2RatchetPass ? 'pass' : 'FAIL'}.\n`,
    );
  }
  return movePasses
    && growthPasses
    && auditsPass
    && staticD2ArraysPass
    && opaqueD2RatchetPass
    ? 0
    : 1;
}

function validateScanner() {
  return process.env.TEST_DISABLE_LINT_NO_SELF_TEST ? 0 : selfTest({ report: false });
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv[0] === '--self-test') return selfTest();
  if (argv[0] === '--diff') {
    const [, baseRevision, headRevision] = argv;
    if (!baseRevision || !headRevision) {
      process.stderr.write(
        'Usage: node scripts/test-disable-lint.mjs --diff <base> <head>\n',
      );
      return 2;
    }
    const selfTestResult = validateScanner();
    if (selfTestResult !== 0) return selfTestResult;
    return runDiff(baseRevision, headRevision);
  }
  if (argv[0] === '--all') {
    const selfTestResult = validateScanner();
    if (selfTestResult !== 0) return selfTestResult;
    for (const finding of auditFiles(listTrackedFiles())) {
      process.stdout.write(
        `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
      );
    }
    return 0;
  }
  if (argv[0] !== '--files' || argv.length === 1) {
    process.stderr.write(
      'Usage: node scripts/test-disable-lint.mjs '
        + '--diff <base> <head> | --all | --files <path...> | --self-test\n',
    );
    return 2;
  }

  const selfTestResult = validateScanner();
  if (selfTestResult !== 0) return selfTestResult;
  for (const finding of auditFiles(argv.slice(1))) {
    process.stdout.write(
      `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
    );
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
