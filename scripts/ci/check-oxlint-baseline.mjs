#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = path.join(REPO_ROOT, '.github/oxlint-baseline.json');

function diagnosticKey(diagnostic) {
  return `${diagnostic.code}\0${diagnostic.filename.replaceAll(path.sep, '/')}`;
}

function countsFromDiagnostics(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics.filter((entry) => entry.severity === 'warning')) {
    if (!diagnostic.code || !diagnostic.filename) {
      throw new Error('Oxlint emitted a warning without a rule code or filename');
    }
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countsFromBaseline(baseline) {
  if (
    baseline?.version !== 1
    || !baseline.rules
    || typeof baseline.rules !== 'object'
    || Array.isArray(baseline.rules)
  ) {
    throw new Error('Oxlint baseline must use version 1 with a rules mapping');
  }
  const counts = new Map();
  for (const [rule, paths] of Object.entries(baseline.rules)) {
    if (!rule || !paths || typeof paths !== 'object' || Array.isArray(paths)) {
      throw new Error('every Oxlint baseline rule must map repository paths to counts');
    }
    for (const [filePath, count] of Object.entries(paths)) {
      if (!filePath || !Number.isInteger(count) || count < 1) {
        throw new Error(`${rule} has an invalid baseline count for ${filePath || '<empty path>'}`);
      }
      counts.set(`${rule}\0${filePath}`, count);
    }
  }
  return counts;
}

export function compareOxlintBaseline({ diagnostics, baseline }) {
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  const current = countsFromDiagnostics(diagnostics);
  const allowed = countsFromBaseline(baseline);
  const regressions = [];
  const reductions = [];
  const keys = new Set([...current.keys(), ...allowed.keys()]);

  for (const key of [...keys].sort()) {
    const currentCount = current.get(key) ?? 0;
    const allowedCount = allowed.get(key) ?? 0;
    const [rule, filePath] = key.split('\0');
    if (currentCount > allowedCount) {
      regressions.push({ rule, path: filePath, current: currentCount, allowed: allowedCount });
    } else if (currentCount < allowedCount) {
      reductions.push({ rule, path: filePath, current: currentCount, allowed: allowedCount });
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

export function baselineFromDiagnostics(diagnostics) {
  const counts = countsFromDiagnostics(diagnostics);
  const rules = {};
  for (const [key, count] of [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const [rule, filePath] = key.split('\0');
    rules[rule] ??= {};
    rules[rule][filePath] = count;
  }
  return {
    version: 1,
    description: 'Known Oxlint correctness warnings, scoped by rule and repository path.',
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
        `${regression.path}: ${regression.rule} has ${regression.current} warning(s); baseline allows ${regression.allowed}`,
      );
    }
    if (!verdict.ok) return 1;
    if (verdict.reductions.length > 0) {
      console.log(`${verdict.reductions.length} baseline entr${verdict.reductions.length === 1 ? 'y is' : 'ies are'} now reducible; run pnpm lint:baseline:update.`);
    } else {
      console.log('Oxlint rule/path baseline passed.');
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
