import { prepareSparql } from '../../dist/sparql-lexical-scanner.js';

const body = `urn:large:${'segment/'.repeat(32_768)}tail`;
const raw = `SELECT * WHERE { GRAPH <${body}> { ?s ?p ?o } }`;
const inertUchar = String.raw`${raw} # \u1234`;

function run(source, iterations) {
  let tokenCount = 0;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index++) {
    const prepared = prepareSparql(source);
    if (prepared.status !== 'valid') throw new Error('benchmark input must remain valid');
    tokenCount += prepared.tokens.length;
  }
  const elapsedMs = performance.now() - startedAt;
  if (tokenCount === 0) throw new Error('benchmark did not scan any tokens');
  return elapsedMs / iterations;
}

for (let index = 0; index < 3; index++) {
  run(raw, 1);
  run(inertUchar, 1);
}

const rawSamples = [];
const inertSamples = [];
for (let sample = 0; sample < 5; sample++) {
  if (sample % 2 === 0) {
    rawSamples.push(run(raw, 4));
    inertSamples.push(run(inertUchar, 4));
  } else {
    inertSamples.push(run(inertUchar, 4));
    rawSamples.push(run(raw, 4));
  }
}
rawSamples.sort((a, b) => a - b);
inertSamples.sort((a, b) => a - b);
process.stdout.write(JSON.stringify({
  rawMs: rawSamples[2],
  inertUcharMs: inertSamples[2],
}));
