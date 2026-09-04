// Run after building publisher: node --expose-gc bench/entity-grouping.mjs [baseline-git-ref]
// This measures the entity-index helper, not end-to-end publishing throughput.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { skolemizeByEntity } from '../packages/publisher/dist/auto-partition.js';
import { canonicalPublishPayload } from '../packages/publisher/dist/canonical-publish-payload.js';

const baselineRef = process.argv[2];
const dist = new URL('../packages/publisher/dist/', import.meta.url);
async function historicalModule(file) {
  const source = execFileSync('git', ['show', `${baselineRef}:packages/publisher/src/${file}.ts`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }}).outputText.replaceAll(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, dist)}'`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
const baseline = baselineRef ? (await historicalModule('auto-partition')).skolemizeByEntity : undefined;
const canonicalBaseline = baselineRef ? (await historicalModule('canonical-publish-payload')).canonicalPublishPayload : undefined;
const quad = (subject, object) => ({ subject, predicate: 'urn:p', object, graph: 'urn:g' });
let seed = 0xabc123;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
if (baseline) {
  const terms = ['urn:a', 'urn:b', 'urn:c', '_:x', '_:y', '_:z', 'urn:a/.well-known/genid/old'];
  for (let n = 0; n < 1000; n++) {
    const input = Array.from({ length: Math.floor(random() * 60) }, () =>
      quad(terms[Math.floor(random() * terms.length)], random() < .6 ? terms[Math.floor(random() * terms.length)] : '"literal"'));
    assert.deepEqual([...skolemizeByEntity(input)], [...baseline(input)]);
  }
}
if (canonicalBaseline) {
  // Public grouping is checked independently above. This comparison pins the
  // private index, manifests, and Merkle roots against the previous filter path.
  for (let n = 0; n < 100; n++) {
    const publicQuads = [], privateQuads = [];
    for (let i = 0; i <= n % 10; i++) {
      const root = `urn:root:${i}`;
      publicQuads.push(quad(root, `_:b${i}`), quad(`_:b${i}`, `"value-${n}"`));
      privateQuads.push(quad(root, `"private-${n}"`), quad(`${root}/.well-known/genid/x/.well-known/genid/y`, '"nested"'));
    }
    privateQuads.push(quad('urn:orphan/.well-known/genid/x', '"orphan"'));
    if (n % 2) { publicQuads.reverse(); privateQuads.reverse(); }
    assert.deepEqual(canonicalPublishPayload(publicQuads, privateQuads), canonicalBaseline(publicQuads, privateQuads));
  }
}
function sample(fn, input) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = fn(input);
  const elapsedMs = performance.now() - start;
  // Heap at return includes the result and garbage not yet collected, not peak heap.
  const heapDeltaAtReturn = process.memoryUsage().heapUsed - heapBefore;
  assert.equal(result.size, input.length / 5);
  return { elapsedMs, heapDeltaAtReturn };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const roots of [100, 1000, 5000]) {
  const input = Array.from({ length: roots }, (_, i) => Array.from({ length: 5 }, (_, j) => quad(`urn:root:${i}`, `"${j}"`))).flat();
  if (baseline) assert.deepEqual([...skolemizeByEntity(input)], [...baseline(input)]);
  for (const [name, fn] of [['current', skolemizeByEntity], ['baseline', baseline]]) {
    if (!fn) continue;
    for (let n = 0; n < 2; n++) fn(input);
    const samples = Array.from({ length: 5 }, () => sample(fn, input));
    rows.push({ name, roots, quads: input.length, medianMs: median(samples.map(s => s.elapsedMs)),
      medianHeapDeltaAtReturn: median(samples.map(s => s.heapDeltaAtReturn)), samples });
  }
}
console.log(JSON.stringify({ node: process.version, baselineRef, randomizedParityCases: baseline ? 1000 : 0,
  canonicalPayloadParityCases: canonicalBaseline ? 100 : 0,
  gcEnabled: Boolean(global.gc), rows }, null, 2));
