import assert from 'node:assert/strict';
import { text } from 'node:stream/consumers';
import { detectSparqlQueryForm } from '../../dist/sparql-guard.js';

const { input, expectedForm } = JSON.parse(await text(process.stdin));

// Match the wrapper test's original warmup/sample counts without measuring
// Vitest transforms or V8 coverage collection. The parent owns the hard timeout.
for (let index = 0; index < 2; index++) {
  assert.equal(detectSparqlQueryForm(input), expectedForm);
}
let fastestMs = Infinity;
for (let index = 0; index < 5; index++) {
  const startedAt = performance.now();
  const result = detectSparqlQueryForm(input);
  fastestMs = Math.min(fastestMs, performance.now() - startedAt);
  assert.equal(result, expectedForm);
}
process.stdout.write(JSON.stringify({ fastestMs }));
