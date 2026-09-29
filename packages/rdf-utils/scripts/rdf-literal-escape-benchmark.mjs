#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] === '--worker') {
  const { escapeRdfLiteral } = await import(pathToFileURL(process.argv[3]));
  const value = process.argv[4];
  const iterations = Number(process.argv[5]);
  for (let index = 0; index < 100_000; index += 1) escapeRdfLiteral(value);
  const start = performance.now();
  let output = '';
  for (let index = 0; index < iterations; index += 1) output = escapeRdfLiteral(value);
  process.stdout.write(`${JSON.stringify({ ms: performance.now() - start, output })}\n`);
  process.exit(0);
}

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11);
if (!baseline) throw new Error('Provide --baseline=REF');
const iterations = Number(process.argv.find((arg) => arg.startsWith('--iterations='))?.slice(13) ?? 5_000_000);
const directory = mkdtempSync(join(tmpdir(), 'dkg-literal-escape-'));
const baselineFile = join(directory, 'baseline.mts');
const candidateFile = join(directory, 'candidate.mts');
for (const [mode, source] of [
  ['baseline', execFileSync('git', ['-C', repo, 'show', `${baseline}:packages/rdf-utils/src/index.ts`], { encoding: 'utf8' })],
  ['candidate', readFileSync(join(repo, 'packages/rdf-utils/src/index.ts'), 'utf8')],
]) {
  const dependency = mode === 'baseline'
    ? execFileSync('git', ['-C', repo, 'show', `${baseline}:packages/rdf-utils/src/absolute-rfc3987-iri.ts`], { encoding: 'utf8' })
    : readFileSync(join(repo, 'packages/rdf-utils/src/absolute-rfc3987-iri.ts'), 'utf8');
  writeFileSync(join(directory, `${mode}-absolute-rfc3987-iri.mts`), dependency);
  writeFileSync(mode === 'baseline' ? baselineFile : candidateFile,
    source.replace("'./absolute-rfc3987-iri.js'", `'./${mode}-absolute-rfc3987-iri.mts'`));
}

const fixtures = {
  plain: 'row 123 triple 456 of benchmark',
  escaped: 'some "quoted" value with\\slashes\nand newline',
};
const samples = [];
for (let trial = 0; trial < 5; trial += 1) {
  for (const mode of trial % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    for (const [shape, value] of Object.entries(fixtures)) {
      const file = mode === 'baseline' ? baselineFile : candidateFile;
      const child = spawnSync(process.execPath, [import.meta.filename, '--worker', file, value, String(iterations)], {
        encoding: 'utf8', timeout: 60_000,
      });
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
process.stdout.write(`${JSON.stringify({ baseline, iterations, summary, samples }, null, 2)}\n`);
