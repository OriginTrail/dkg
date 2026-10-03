// Compare the production SPARQL JSON and TSV decoders on equivalent SELECT data.
// Run after building storage:
// node packages/storage/scripts/sparql-result-format-benchmark.mjs --iterations=500
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv[2] === '--worker') {
  const mode = process.argv[3];
  const fixture = readFileSync(process.argv[4], 'utf8');
  const iterations = Number(process.argv[5]);
  const storageDist = new URL('../dist/', import.meta.url);
  const decode = mode === 'json'
    ? (await import(new URL('sparql-json-query-result.js', storageDist))).decodeSparqlJsonQueryResult
    : (await import(new URL('sparql-tsv-query-result.js', storageDist))).decodeSparqlTsvSelectResult;
  let result;
  const run = () => mode === 'json' ? decode(fixture, 'select') : decode(fixture);
  for (let i = 0; i < 30; i += 1) result = run();
  global.gc();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) result = run();
  const ms = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  console.log(JSON.stringify({
    ms,
    cpuMs: (cpu.user + cpu.system) / 1000,
    digest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  }));
} else {
  const iterations = Number(argument('iterations') ?? 500);
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('iterations must be positive');
  const rows = Number(argument('rows') ?? 1000);
  if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('rows must be positive');
  const directory = mkdtempSync(join(tmpdir(), 'dkg-result-format-benchmark-'));
  const jsonFixture = join(directory, 'fixture.json');
  const tsvFixture = join(directory, 'fixture.tsv');
  const variables = ['g', 's', 'p', 'o'];
  const bindings = Array.from({ length: rows }, (_, i) => ({
    g: { type: 'uri', value: `did:dkg:context-graph:0x${'a'.repeat(40)}/benchmark/_shared_memory/0x${'b'.repeat(40)}/${Math.floor(i / 30)}` },
    s: { type: 'uri', value: `urn:bb:benchmark:swm:${Math.floor(i / 30)}:r${i}` },
    p: { type: 'uri', value: 'http://example.org/bb#note' },
    o: { type: 'literal', value: `row ${Math.floor(i / 30)} triple ${i} of run benchmark` },
  }));
  const json = JSON.stringify({ head: { vars: variables }, results: { bindings } });
  const tsv = `${variables.map(v => `?${v}`).join('\t')}\n${bindings.map(row => [
    `<${row.g.value}>`, `<${row.s.value}>`, `<${row.p.value}>`, `"${row.o.value}"`,
  ].join('\t')).join('\n')}\n`;
  writeFileSync(jsonFixture, json);
  writeFileSync(tsvFixture, tsv);
  try {
    const samples = [];
    for (let trial = 0; trial < 5; trial += 1) {
      for (const mode of trial % 2 === 0 ? ['json', 'tsv'] : ['tsv', 'json']) {
        const fixture = mode === 'json' ? jsonFixture : tsvFixture;
        const worker = spawnSync(
          process.execPath,
          ['--expose-gc', import.meta.filename, '--worker', mode, fixture, String(iterations)],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (worker.status !== 0) throw new Error(worker.stderr || worker.stdout);
        samples.push({ trial, mode, ...JSON.parse(worker.stdout) });
      }
    }
    if (new Set(samples.map(sample => sample.digest)).size !== 1) {
      throw new Error('JSON and TSV decoded outputs differ');
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const summary = Object.fromEntries(['json', 'tsv'].map(mode => [mode, {
      ms: median(samples.filter(sample => sample.mode === mode).map(sample => sample.ms)),
      cpuMs: median(samples.filter(sample => sample.mode === mode).map(sample => sample.cpuMs)),
    }]));
    console.log(JSON.stringify({
      nodeVersion: process.version,
      rows,
      iterations,
      bytes: { json: Buffer.byteLength(json), tsv: Buffer.byteLength(tsv) },
      summary,
      reductionPct: (1 - summary.tsv.ms / summary.json.ms) * 100,
      samples,
    }, null, 2));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
