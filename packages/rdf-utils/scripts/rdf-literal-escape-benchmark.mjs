#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The embedded legacy implementation below is a frozen fixture from this
// exact testnet-canary commit. This benchmark has no ref-selection interface:
// its baseline never changes when callers run it from another Git revision.
const LEGACY_BASELINE_COMMIT = '12645248f49e8df2d27a17dc893a44862fad6ade';

// Dependency-free legacy implementation from the PR base. Keeping this small
// fixture explicit avoids copying/rewriting the package barrel and lets the
// worker execute on every supported Node 22+ release without a TS loader.
const LEGACY_SHORT_ESCAPES = Object.freeze({
  '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r',
  '"': '\\"', '\\': '\\\\',
});
const LEGACY_PATTERN = new RegExp(
  `["\\\\${String.fromCodePoint(0)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}]`,
  'g',
);
function legacyEscapeRdfLiteral(value) {
  return value.replace(LEGACY_PATTERN, character => {
    const shortEscape = LEGACY_SHORT_ESCAPES[character];
    if (shortEscape !== undefined) return shortEscape;
    return `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

if (process.argv[2] === '--worker') {
  const mode = process.argv[3];
  const escapeRdfLiteral = mode === 'baseline'
    ? legacyEscapeRdfLiteral
    : (await import(pathToFileURL(process.argv[4]))).escapeRdfLiteral;
  const value = process.argv[5];
  const iterations = Number(process.argv[6]);
  for (let index = 0; index < 100_000; index += 1) escapeRdfLiteral(value);
  const start = performance.now();
  let output = '';
  for (let index = 0; index < iterations; index += 1) output = escapeRdfLiteral(value);
  process.stdout.write(`${JSON.stringify({ ms: performance.now() - start, output })}\n`);
  process.exit(0);
}

const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv.slice(2).some((arg) => !arg.startsWith('--iterations='))) {
  throw new Error('Only --iterations=COUNT is supported; the legacy baseline is fixed');
}
const baselineCommit = execFileSync(
  'git', ['-C', repo, 'rev-parse', '--verify', `${LEGACY_BASELINE_COMMIT}^{commit}`], { encoding: 'utf8' },
).trim();
if (baselineCommit !== LEGACY_BASELINE_COMMIT) {
  throw new Error(
    `This benchmark's frozen legacy fixture represents only ${LEGACY_BASELINE_COMMIT}; `
    + `resolved ${baselineCommit}`,
  );
}
const iterations = Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.slice(13) ?? 5_000_000);
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error('--iterations must be a positive safe integer');
}
const candidateFile = fileURLToPath(new URL('../dist/rdf-literal-escape.js', import.meta.url));

const fixtures = {
  plain: 'row 123 triple 456 of benchmark',
  escaped: 'some "quoted" value with\\slashes\nand newline',
};
const samples = [];
for (let trial = 0; trial < 5; trial += 1) {
  for (const mode of trial % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    for (const [shape, value] of Object.entries(fixtures)) {
      const child = spawnSync(
        process.execPath,
        [import.meta.filename, '--worker', mode, candidateFile, value, String(iterations)],
        { encoding: 'utf8', timeout: 60_000 },
      );
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      samples.push({ trial, mode, shape, ...JSON.parse(child.stdout) });
    }
  }
}

for (const shape of Object.keys(fixtures)) {
  const outputs = new Set(samples.filter((sample) => sample.shape === shape).map((sample) => sample.output));
  if (outputs.size !== 1) throw new Error(`${shape} outputs differ`);
}
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(Object.keys(fixtures).map((shape) => {
  const before = median(samples.filter((sample) => sample.shape === shape && sample.mode === 'baseline').map((sample) => sample.ms));
  const after = median(samples.filter((sample) => sample.shape === shape && sample.mode === 'candidate').map((sample) => sample.ms));
  return [shape, { baselineMs: before, candidateMs: after, reductionPct: (1 - after / before) * 100 }];
}));
process.stdout.write(`${JSON.stringify({ baseline: 'frozen-legacy-fixture', baselineCommit, iterations, summary, samples }, null, 2)}\n`);
