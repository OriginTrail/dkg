// Node 24+: A/B the production decoder and its closed-data helpers, not a
// reimplementation. Optional --fixture=PATH accepts SPARQL Results JSON.
// node packages/storage/scripts/sparql-json-decode-benchmark.mjs --baseline=REF
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] === '--worker') {
  const { decodeSparqlJsonQueryResult } = await import(pathToFileURL(process.argv[3]));
  const text = readFileSync(process.argv[4], 'utf8');
  const iterations = Number(process.argv[5]);
  let result;
  for (let i = 0; i < 20; i++) result = decodeSparqlJsonQueryResult(text, 'select');
  global.gc();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) result = decodeSparqlJsonQueryResult(text, 'select');
  const ms = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  console.log(JSON.stringify({ ms, cpuMs: (cpu.user + cpu.system) / 1000, digest, rows: result.bindings.length, iterations }));
} else {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const ref = argument('baseline');
  if (!ref) throw new Error('Provide --baseline=REF (the PR base commit)');
  const iterations = Number(argument('iterations') ?? 300);
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('iterations must be positive');
  const directory = mkdtempSync(join(tmpdir(), 'dkg-decode-bench-'));
  symlinkSync(join(repo, 'packages/storage/node_modules'), join(directory, 'node_modules'), 'dir');
  const fixture = join(directory, 'fixture.json');
  const fixturePath = argument('fixture');
  const shape = argument('shape') ?? 'repeated';
  if (!['repeated', 'unique', 'single'].includes(shape)) throw new Error('shape must be repeated, unique or single');
  const uri = value => ({ type: 'uri', value });
  writeFileSync(fixture, fixturePath ? readFileSync(fixturePath) : JSON.stringify({
    head: { vars: ['g', 's', 'p', 'o'] },
    results: { bindings: Array.from({ length: shape === 'single' ? 1 : 1000 }, (_, i) => ({
      g: uri(shape === 'unique' ? `urn:benchmark:graph:${i}` : `did:dkg:context-graph:0x${'a'.repeat(40)}/benchmark/_shared_memory/0x${'b'.repeat(40)}/${Math.floor(i / 30)}`),
      s: uri(`urn:bb:benchmark:swm:${Math.floor(i / 30)}:r${i}`),
      p: uri(shape === 'unique' ? `urn:benchmark:predicate:${i}` : 'http://example.org/bb#note'),
      o: shape === 'unique' ? uri(`urn:benchmark:object:${i}`) : { type: 'literal', value: `row ${Math.floor(i / 30)} triple ${i} of run benchmark` },
    })) },
  }));
  const variants = {};
  for (const mode of ['baseline', 'candidate']) {
    const source = path => mode === 'baseline'
      ? execFileSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'utf8' })
      : readFileSync(join(repo, path), 'utf8');
    const snapshot = `${mode}-snapshot.mts`;
    const closed = `${mode}-closed.mts`;
    const decoder = `${mode}-decoder.mts`;
    writeFileSync(join(directory, snapshot), source('packages/core/src/sync-wire-objects.ts'));
    writeFileSync(join(directory, closed), source('packages/storage/src/closed-data-snapshot.ts')
      .replace("'@origintrail-official/dkg-core/closed-data-snapshot'", `'./${snapshot}'`));
    writeFileSync(join(directory, decoder), source('packages/storage/src/sparql-json-query-result.ts')
      .replace("'./closed-data-snapshot.js'", `'./${closed}'`));
    variants[mode] = join(directory, decoder);
  }
  const samples = [];
  for (let trial = 0; trial < 5; trial++) {
    for (const mode of trial % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
      const worker = spawnSync(process.execPath, ['--expose-gc', import.meta.filename, '--worker', variants[mode], fixture, String(iterations)], { encoding: 'utf8', timeout: 30000 });
      if (worker.status !== 0) throw new Error(worker.stderr || worker.stdout);
      samples.push({ trial, mode, ...JSON.parse(worker.stdout) });
    }
  }
  if (new Set(samples.map(s => s.digest)).size !== 1) throw new Error('Decoded outputs differ');
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = Object.fromEntries(Object.keys(variants).map(mode => [mode, {
    ms: median(samples.filter(s => s.mode === mode).map(s => s.ms)),
    cpuMs: median(samples.filter(s => s.mode === mode).map(s => s.cpuMs)),
  }]));
  console.log(JSON.stringify({ baselineRef: ref, nodeVersion: process.version,
    fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
    rows: samples[0].rows, iterations, decodedSha256: samples[0].digest, summary,
    reductionPct: (1 - summary.candidate.ms / summary.baseline.ms) * 100, samples }, null, 2));
}
