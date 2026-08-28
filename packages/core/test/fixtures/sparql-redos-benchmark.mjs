import { classifySparqlOperation } from '../../dist/sparql-operation.js';

function detect(input) {
  const operation = classifySparqlOperation(input);
  return operation.kind === 'read' ? operation.form : 'UNKNOWN';
}

function inputFor(count) {
  return Array.from(
    { length: count },
    (_, index) => `PREFIX p${index}: <http://x.org/${index}/>`,
  ).join('\n') + '\n';
}

function variantsFor(input) {
  return Array.from(
    { length: 4 },
    (_, index) => `${input}# benchmark-${index}\n`,
  );
}

function runBatch(variants, iterations, sample) {
  const expectedLength = detect(variants[0]).length;
  let resultLength = 0;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index++) {
    resultLength += detect(variants[(index + sample) % variants.length]).length;
  }
  const elapsedMs = performance.now() - startedAt;
  if (resultLength !== expectedLength * iterations) {
    throw new Error(
      `SPARQL benchmark result mismatch: expected ` +
      `${expectedLength * iterations}, received ${resultLength}`,
    );
  }
  return elapsedMs;
}

function calibrate(variants) {
  for (let iterations = 1; iterations <= 4_096; iterations *= 2) {
    if (runBatch(variants, iterations, 0) >= 250 || iterations === 4_096) {
      return iterations;
    }
  }
  throw new Error('unreachable SPARQL benchmark calibration');
}

export function measureSparqlRedosGrowth() {
  // Keep both samples above V8's large-object allocation boundary. Crossing
  // that boundary made the old 1k/10k pair measure allocator regimes rather
  // than scanner growth on GitHub's coverage hosts. A 4x input range with a
  // strict 10x ceiling still rejects quadratic/backtracking regressions.
  const smallVariants = variantsFor(inputFor(2_500));
  const largeVariants = variantsFor(inputFor(10_000));
  for (const variant of [...smallVariants, ...largeVariants]) detect(variant);
  const smallIterations = calibrate(smallVariants);
  const largeIterations = calibrate(largeVariants);

  const smallSamples = [];
  const largeSamples = [];
  for (let sample = 0; sample < 3; sample++) {
    if (sample % 2 === 0) {
      smallSamples.push(runBatch(smallVariants, smallIterations, sample));
      largeSamples.push(runBatch(largeVariants, largeIterations, sample));
    } else {
      largeSamples.push(runBatch(largeVariants, largeIterations, sample));
      smallSamples.push(runBatch(smallVariants, smallIterations, sample));
    }
  }
  smallSamples.sort((a, b) => a - b);
  largeSamples.sort((a, b) => a - b);
  return {
    smallMs: smallSamples[1] / smallIterations,
    largeMs: largeSamples[1] / largeIterations,
  };
}

process.stdout.write(JSON.stringify(measureSparqlRedosGrowth()));
