#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = path.join(REPO_ROOT, '.github/oxlint-baseline.json');

function repositorySource(filePath) {
  if (!filePath || path.isAbsolute(filePath)) {
    throw new Error(`Oxlint warning has an invalid repository path: ${filePath || '<empty>'}`);
  }
  const resolved = path.resolve(REPO_ROOT, filePath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Oxlint warning escapes the repository: ${filePath}`);
  }
  return fs.readFileSync(resolved);
}

function diagnosticIdentity(diagnostic, readSource) {
  if (typeof diagnostic.message !== 'string' || diagnostic.message === '') {
    throw new Error('Oxlint emitted a warning without a message');
  }
  if (!Array.isArray(diagnostic.labels) || diagnostic.labels.length === 0) {
    throw new Error('Oxlint emitted a warning without labeled source evidence');
  }
  const source = Buffer.isBuffer(diagnostic.sourceText)
    ? diagnostic.sourceText
    : Buffer.from(diagnostic.sourceText ?? readSource(diagnostic.filename));
  const sourceLines = source.toString('utf8').split(/\r?\n/);
  const evidence = diagnostic.labels.map((label) => {
    const { offset, length, line } = label?.span ?? {};
    if (
      !Number.isInteger(offset)
      || offset < 0
      || !Number.isInteger(length)
      || length < 0
      || offset + length > source.length
      || !Number.isInteger(line)
      || line < 1
      || line > sourceLines.length
    ) {
      throw new Error(`${diagnostic.filename}: Oxlint emitted an invalid source span`);
    }
    return {
      label: typeof label.label === 'string' ? label.label : '',
      source: length === 0
        ? sourceLines[line - 1].trim()
        : source.subarray(offset, offset + length).toString('utf8'),
    };
  });
  return JSON.stringify({ message: diagnostic.message, evidence });
}

function countsFromDiagnostics(diagnostics, readRepositorySource = repositorySource) {
  const counts = new Map();
  const sourceCache = new Map();
  const readSource = (filePath) => {
    if (!sourceCache.has(filePath)) sourceCache.set(filePath, readRepositorySource(filePath));
    return sourceCache.get(filePath);
  };
  for (const diagnostic of diagnostics.filter((entry) => entry.severity === 'warning')) {
    if (!diagnostic.code || !diagnostic.filename) {
      throw new Error('Oxlint emitted a warning without a rule code or filename');
    }
    const normalizedPath = diagnostic.filename.replaceAll(path.sep, '/');
    const identity = diagnosticIdentity(diagnostic, readSource);
    const key = `${diagnostic.code}\0${normalizedPath}\0${identity}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countsFromBaseline(baseline) {
  if (
    baseline?.version !== 2
    || !baseline.rules
    || typeof baseline.rules !== 'object'
    || Array.isArray(baseline.rules)
  ) {
    throw new Error('Oxlint baseline must use version 2 with a rules mapping');
  }
  const counts = new Map();
  for (const [rule, paths] of Object.entries(baseline.rules)) {
    if (!rule || !paths || typeof paths !== 'object' || Array.isArray(paths)) {
      throw new Error('every Oxlint baseline rule must map repository paths to counts');
    }
    for (const [filePath, identities] of Object.entries(paths)) {
      if (!filePath || !identities || typeof identities !== 'object' || Array.isArray(identities)) {
        throw new Error(`${rule} has invalid diagnostic fingerprints for ${filePath || '<empty path>'}`);
      }
      for (const [identity, count] of Object.entries(identities)) {
        let parsedIdentity;
        try {
          parsedIdentity = JSON.parse(identity);
        } catch (error) {
          throw new Error(`${rule} has an invalid diagnostic fingerprint for ${filePath}: ${error.message}`);
        }
        if (
          typeof parsedIdentity?.message !== 'string'
          || !Array.isArray(parsedIdentity.evidence)
          || parsedIdentity.evidence.length === 0
          || parsedIdentity.evidence.some((entry) => (
            typeof entry?.label !== 'string' || typeof entry?.source !== 'string'
          ))
          || !Number.isInteger(count)
          || count < 1
        ) {
          throw new Error(`${rule} has an invalid diagnostic fingerprint for ${filePath}`);
        }
        counts.set(`${rule}\0${filePath}\0${identity}`, count);
      }
    }
  }
  return counts;
}

export function compareOxlintBaseline({ diagnostics, baseline, readSource }) {
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  const current = countsFromDiagnostics(diagnostics, readSource);
  const allowed = countsFromBaseline(baseline);
  const regressions = [];
  const reductions = [];
  const keys = new Set([...current.keys(), ...allowed.keys()]);

  for (const key of [...keys].sort()) {
    const currentCount = current.get(key) ?? 0;
    const allowedCount = allowed.get(key) ?? 0;
    const [rule, filePath, identity] = key.split('\0');
    const { message, evidence } = JSON.parse(identity);
    if (currentCount > allowedCount) {
      regressions.push({
        rule, path: filePath, message, evidence, current: currentCount, allowed: allowedCount,
      });
    } else if (currentCount < allowedCount) {
      reductions.push({
        rule, path: filePath, message, evidence, current: currentCount, allowed: allowedCount,
      });
    }
  }

  return { ok: errors.length === 0 && regressions.length === 0, errors, regressions, reductions };
}

export function executeOxlint(spawnProcess = spawnSync) {
  const result = spawnProcess(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'oxlint', '-c', '.oxlintrc.jsonc', '.', '--format=json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Oxlint terminated by ${result.signal}`);
  if (typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    throw new Error(`Oxlint produced no JSON output (exit ${result.status ?? 'unknown'})`);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Oxlint produced invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(report.diagnostics)) throw new Error('Oxlint JSON is missing diagnostics');
  if (
    result.status !== 0
    && !report.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
  ) {
    throw new Error(`Oxlint exited with status ${result.status ?? 'unknown'} without error diagnostics`);
  }
  return report.diagnostics;
}

export function baselineFromDiagnostics(diagnostics, readSource) {
  const counts = countsFromDiagnostics(diagnostics, readSource);
  const rules = {};
  for (const [key, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [rule, filePath, identity] = key.split('\0');
    rules[rule] ??= {};
    rules[rule][filePath] ??= {};
    rules[rule][filePath][identity] = count;
  }
  return {
    version: 2,
    description: 'Known Oxlint correctness warnings fingerprinted by rule, path, message, and labeled source text.',
    rules,
  };
}

export function runOxlintBaseline(argv, { spawnProcess = spawnSync } = {}) {
  try {
    const diagnostics = executeOxlint(spawnProcess);
    const parserErrors = diagnostics.filter((entry) => entry.severity === 'error');
    if (parserErrors.length > 0) {
      for (const error of parserErrors) console.error(`${error.filename}: ${error.message}`);
      return 1;
    }

    if (argv.length === 1 && argv[0] === '--write') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineFromDiagnostics(diagnostics), null, 2)}\n`);
      console.log(`Updated ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
      return 0;
    }
    if (argv.length !== 0) throw new Error('usage: check-oxlint-baseline.mjs [--write]');

    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const verdict = compareOxlintBaseline({ diagnostics, baseline });
    for (const regression of verdict.regressions) {
      console.error(
        `${regression.path}: ${regression.rule}: ${regression.message} `
        + `(source: ${regression.evidence.map((entry) => JSON.stringify(entry.source)).join(', ')}) `
        + `appears ${regression.current} time(s); baseline allows ${regression.allowed}`,
      );
    }
    if (!verdict.ok) return 1;
    if (verdict.reductions.length > 0) {
      console.log(`${verdict.reductions.length} baseline entr${verdict.reductions.length === 1 ? 'y is' : 'ies are'} now reducible; run pnpm lint:baseline:update.`);
    } else {
      console.log('Oxlint diagnostic fingerprint baseline passed.');
    }
    return 0;
  } catch (error) {
    console.error(`oxlint-baseline: ${error.message}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runOxlintBaseline(process.argv.slice(2));
}
