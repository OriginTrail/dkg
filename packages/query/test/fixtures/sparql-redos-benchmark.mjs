import { classifySparqlOperation } from '@origintrail-official/dkg-core';

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
    { length: 16 },
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
  if (resultLength !== expectedLength * iterations) {
    throw new Error(
      `SPARQL benchmark result mismatch: expected ` +
      `${expectedLength * iterations}, received ${resultLength}`,
    );
  }
  return performance.now() - startedAt;
}

export function measureSparqlRedosGrowth() {
  const smallVariants = variantsFor(inputFor(1_000));
  const largeVariants = variantsFor(inputFor(10_000));
  for (const variant of [...smallVariants, ...largeVariants]) detect(variant);

  let iterations = 1;
  while (iterations < 4_096 && runBatch(smallVariants, iterations, 0) < 25) {
    iterations *= 2;
  }

  const smallSamples = [];
  const largeSamples = [];
  for (let sample = 0; sample < 3; sample++) {
    if (sample % 2 === 0) {
      smallSamples.push(runBatch(smallVariants, iterations, sample));
      largeSamples.push(runBatch(largeVariants, iterations, sample));
    } else {
      largeSamples.push(runBatch(largeVariants, iterations, sample));
      smallSamples.push(runBatch(smallVariants, iterations, sample));
    }
  }
  smallSamples.sort((a, b) => a - b);
  largeSamples.sort((a, b) => a - b);
  return {
    smallMs: smallSamples[1] / iterations,
    largeMs: largeSamples[1] / iterations,
  };
}

process.stdout.write(JSON.stringify(measureSparqlRedosGrowth()));
