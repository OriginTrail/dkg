#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { COVERAGE_SOURCE_ROOTS } from '../lib/coverage-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CRITICAL = new Set(['agent', 'chain', 'core', 'publisher', 'storage', 'random-sampling', 'rdf-utils']);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function hasRuntimeCode(filename, source) {
  const emitted = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, removeComments: true },
  }).outputText;
  const parsed = ts.createSourceFile(filename.replace(/\.[^.]+$/, '.js'), emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  return parsed.statements.some((statement) => !ts.isEmptyStatement(statement) && !(
    ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
    statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length === 0
  ));
}

export function inspectCoverage(packageDirectory) {
  const directory = path.resolve(packageDirectory);
  const coverageDirectory = path.join(directory, 'coverage');
  const report = JSON.parse(fs.readFileSync(path.join(coverageDirectory, 'coverage-summary.json'), 'utf8'));
  const lcov = fs.readFileSync(path.join(coverageDirectory, 'lcov.info'), 'utf8');
  if (!report.total || !Number.isFinite(report.total.lines?.total) || report.total.lines.total <= 0) {
    throw new Error('coverage summary has no executable lines');
  }
  const sourceFiles = COVERAGE_SOURCE_ROOTS.flatMap((root) => fs.existsSync(path.join(directory, root)) ? walk(path.join(directory, root)) : [])
    .filter((file) => /\.(?:[cm]?jsx?|tsx?)$/.test(file) && !file.endsWith('.d.ts'));
  const expected = new Set(sourceFiles.map((file) => path.resolve(file)));
  const reported = new Set(Object.keys(report).filter((key) => key !== 'total').map((key) => path.resolve(directory, key)));
  const unexpected = [...reported].filter((file) => !expected.has(file));
  if (unexpected.length) throw new Error(`non-production files in coverage: ${unexpected.join(', ')}`);
  const missing = [...expected].filter((file) => !reported.has(file) && hasRuntimeCode(file, fs.readFileSync(file, 'utf8')));
  if (missing.length) throw new Error(`production source missing from coverage: ${missing.join(', ')}`);

  const lines = new Map();
  for (const record of lcov.split('end_of_record')) {
    const source = /^SF:(.+)$/m.exec(record)?.[1];
    if (!source) continue;
    const file = path.resolve(directory, source);
    if (!expected.has(file)) throw new Error(`non-production LCOV source: ${source}`);
    const hits = new Map([...record.matchAll(/^DA:(\d+),(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
    lines.set(file, hits);
  }
  for (const file of reported) {
    const entry = report[file] ?? report[path.relative(directory, file)];
    if (entry?.lines.total > 0 && !lines.has(file)) throw new Error(`LCOV missing source: ${file}`);
  }
  return { totals: report.total, sourceFiles: expected.size, reportedFiles: reported.size, lines };
}

export function changedLinesFromDiff(diff) {
  const changed = new Map();
  let file;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      if (!changed.has(file)) changed.set(file, new Set());
    } else if (line === '+++ /dev/null') file = undefined;
    else if (file && line.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error(`invalid diff hunk: ${line}`);
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let n = start; n < start + count; n++) changed.get(file).add(n);
    }
  }
  return changed;
}

export function changedCoverage(coverage, changes, root, minimum) {
  let total = 0;
  let covered = 0;
  const uncovered = [];
  for (const [file, changed] of changes) {
    const executable = coverage.lines.get(path.resolve(root, file));
    if (!executable) continue; // Full-source validation has already rejected missing runtime modules.
    for (const line of changed) {
      if (!executable.has(line)) continue;
      total++;
      if (executable.get(line) > 0) covered++;
      else uncovered.push(`${file}:${line}`);
    }
  }
  const percent = total ? covered * 100 / total : 100;
  if (percent + 1e-9 < minimum) throw new Error(`changed executable lines ${covered}/${total} (${percent.toFixed(2)}%) < ${minimum}%: ${uncovered.join(', ')}`);
  return { total, covered, percent, minimum };
}

export function checkPackageCoverage(name, { root = ROOT, base } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid package name');
  const coverage = inspectCoverage(path.join(root, 'packages', name));
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/coverage-baselines.json'), 'utf8')).packages[name];
  if (!policy) throw new Error(`no measured coverage policy for ${name}`);
  for (const metric of ['lines', 'branches', 'functions', 'statements']) {
    const actual = coverage.totals[metric]?.pct;
    const minimum = policy.thresholds[metric];
    if (!Number.isFinite(actual) || !Number.isFinite(minimum) || actual < minimum) {
      throw new Error(`${name}: ${metric} coverage ${actual}% is below ${minimum}%`);
    }
  }
  const files = JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'coverage/coverage-summary.json'), 'utf8'));
  for (const [file, floors] of Object.entries(policy.preservedFiles ?? {})) {
    const entry = files[path.join(root, 'packages', name, file)] ?? files[file];
    for (const [metric, minimum] of Object.entries(floors)) {
      if (!Number.isFinite(entry?.[metric]?.pct) || entry[metric].pct < minimum) throw new Error(`${name}/${file}: preserved ${metric} floor ${minimum}% not met`);
    }
  }
  const result = { package: name, totals: coverage.totals, sourceFiles: coverage.sourceFiles, reportedFiles: coverage.reportedFiles };
  if (base) {
    execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: root, stdio: 'pipe' });
    const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-renames', '--unified=0', base, '--', ...COVERAGE_SOURCE_ROOTS.map((dir) => `packages/${name}/${dir}`)], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    result.changed = changedCoverage(coverage, changedLinesFromDiff(diff), root, CRITICAL.has(name) ? 90 : 80);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [name, option, base] = process.argv.slice(2);
    if (!name || (option && option !== '--base') || (option && !base)) throw new Error('usage: check-coverage.mjs PACKAGE [--base COMMIT]');
    console.log(JSON.stringify(checkPackageCoverage(name, { base }), null, 2));
  } catch (error) {
    console.error(`coverage: ${error.message}`);
    process.exitCode = 1;
  }
}
