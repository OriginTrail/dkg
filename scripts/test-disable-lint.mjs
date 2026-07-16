#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const LEGACY_ALIASES = new Set(['xdescribe', 'xit', 'xtest']);
const TICKET = /^(?:#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|[A-Z][A-Z0-9]*-\d+)$/i;

function scriptKindFor(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function normalizedPath(filePath) {
  return filePath.replaceAll(path.sep, '/');
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

  const addFinding = (node, api) => {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      rule: 'D1',
      api,
      filePath,
      line: location.line + 1,
      column: location.character + 1,
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && LEGACY_ALIASES.has(callee.text)) {
        addFinding(callee, callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && DIRECT_BASES.has(callee.expression.text)
        && DIRECT_MEMBERS.has(callee.name.text)
      ) {
        addFinding(callee, `${callee.expression.text}.${callee.name.text}`);
      }
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

export function runCli(argv = process.argv.slice(2)) {
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
