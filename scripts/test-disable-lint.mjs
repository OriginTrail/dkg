#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

export function auditFiles(filePaths) {
  return filePaths.flatMap((filePath) => {
    if (!isD1ScannableFile(filePath)) return [];
    return analyzeD1Source(readFileSync(filePath, 'utf8'), filePath);
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

function findingsAt(revision, cwd) {
  return git(['ls-tree', '-r', '--name-only', revision], cwd)
    .split('\n')
    .filter(isD1ScannableFile)
    .flatMap((filePath) => analyzeD1Source(
      git(['show', `${revision}:${filePath}`], cwd),
      filePath,
    ));
}

export function computeDiffFindings(baseRevision, headRevision, cwd = process.cwd()) {
  const baseline = new Map();
  for (const finding of findingsAt(baseRevision, cwd)) {
    baseline.set(finding.fingerprint, (baseline.get(finding.fingerprint) ?? 0) + 1);
  }

  const results = findingsAt(headRevision, cwd).map((finding) => {
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

    const results = computeDiffFindings(base, head, fixtureRoot).results;
    const pass = results.filter(({ verdict }) => verdict === 'new').length === 0
      && results.filter(({ verdict }) => verdict === 'grandfathered').length === 1;
    if (!pass) {
      process.stderr.write(`SELF-TEST FAIL: semantic move produced ${JSON.stringify(results)}\n`);
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
    const fixturePath = path.join(fixtureRoot, 'test/copy.test.ts');
    const disabledTest = "test.skip('copied debt', () => {});\n";
    writeFileSync(fixturePath, disabledTest);
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();

    writeFileSync(fixturePath, `${disabledTest}\n\n${disabledTest}`);
    git('commit', '-aqm', 'copy disabled test');
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
    const expected = ['test/copy.test.ts:4:1: D1 test.skip'];
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

function selfTest() {
  const movePasses = semanticMoveSelfTest();
  const growthPasses = semanticGrowthSelfTest();
  process.stdout.write(
    `test-disable-lint self-test: semantic move ${movePasses ? 'pass' : 'FAIL'}, `
      + `semantic growth ${growthPasses ? 'pass' : 'FAIL'}.\n`,
  );
  return movePasses && growthPasses ? 0 : 1;
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
    if (!process.env.TEST_DISABLE_LINT_NO_SELF_TEST) {
      const selfTestResult = selfTest();
      if (selfTestResult !== 0) return selfTestResult;
    }
    return runDiff(baseRevision, headRevision);
  }
  if (argv[0] !== '--files' || argv.length === 1) {
    process.stderr.write('Usage: node scripts/test-disable-lint.mjs --files <path...>\n');
    return 2;
  }

  for (const finding of auditFiles(argv.slice(1))) {
    process.stdout.write(
      `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
    );
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
