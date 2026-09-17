// Node 24+: benchmark the real production helper against a git ref.
// node packages/core/scripts/closed-data-snapshot-benchmark.mjs --baseline=REF
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv[2] === '--worker') {
  const { snapshotExactDataRecord } = await import(pathToFileURL(process.argv[3]));
  const keys = Array.from({ length: Number(process.argv[4]) }, (_, i) => `field${i}`);
  const value = Object.fromEntries([...keys].reverse().map((key, i) => [key, i]));
  for (let i = 0; i < 10000; i++) snapshotExactDataRecord(value, keys, 'benchmark');
  global.gc();
  const iterations = 100000;
  const start = performance.now();
  let snapshot;
  for (let i = 0; i < iterations; i++) snapshot = snapshotExactDataRecord(value, keys, 'benchmark');
  console.log(JSON.stringify({ ms: performance.now() - start, iterations, fingerprint: JSON.stringify(snapshot) }));
} else {
  const repo = new URL('../../../', import.meta.url).pathname;
  const ref = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
  if (!ref) throw new Error('Provide --baseline=REF (e.g. the PR base commit)');
  const directory = mkdtempSync(join(tmpdir(), 'dkg-snapshot-bench-'));
  const source = 'packages/core/src/sync-wire-objects.ts';
  const files = {
    baseline: join(directory, 'baseline.mts'),
    candidate: join(directory, 'candidate.mts'),
  };
  writeFileSync(files.baseline, execFileSync('git', ['-C', repo, 'show', `${ref}:${source}`]));
  writeFileSync(files.candidate, readFileSync(join(repo, source)));
  const results = [];
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  for (const fields of [2, 3, 8, 32]) {
    const trials = { baseline: [], candidate: [] };
    let fingerprint;
    for (let trial = 0; trial < 5; trial++) {
      for (const mode of trial % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
        const worker = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--worker', files[mode], String(fields)], { encoding: 'utf8', timeout: 30000 });
        if (worker.status !== 0) throw new Error(worker.stderr || worker.stdout);
        const result = JSON.parse(worker.stdout);
        fingerprint ??= result.fingerprint;
        if (fingerprint !== result.fingerprint) throw new Error('Snapshot outputs differ');
        trials[mode].push(result.ms);
      }
    }
    const baselineMs = median(trials.baseline);
    const candidateMs = median(trials.candidate);
    results.push({ fields, baselineMs, candidateMs, reductionPct: (1 - candidateMs / baselineMs) * 100, trials });
  }
  console.log(JSON.stringify({ baselineRef: ref, results }, null, 2));
}
