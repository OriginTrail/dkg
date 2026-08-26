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
    { length: 8 },
    (_, index) => `${input}# benchmark-${index}\n`,
  );
}

function measureOne(input, expectedLength) {
  const startedAt = performance.now();
  const resultLength = detect(input).length;
  const elapsedMs = performance.now() - startedAt;
  if (resultLength !== expectedLength) {
    throw new Error(
      `SPARQL benchmark result mismatch: expected ` +
      `${expectedLength}, received ${resultLength}`,
    );
  }
  return elapsedMs;
}

export function measureSparqlRedosGrowth() {
  const smallVariants = variantsFor(inputFor(1_000));
  const largeVariants = variantsFor(inputFor(10_000));
  for (const variant of [...smallVariants, ...largeVariants]) detect(variant);
  const smallExpectedLength = detect(smallVariants[0]).length;
  const largeExpectedLength = detect(largeVariants[0]).length;

  const iterations = 16;
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    let smallTotalMs = 0;
    let largeTotalMs = 0;
    for (let index = 0; index < iterations; index++) {
      const variant = (index + sample) % smallVariants.length;
      if ((index + sample) % 2 === 0) {
        smallTotalMs += measureOne(smallVariants[variant], smallExpectedLength);
        largeTotalMs += measureOne(largeVariants[variant], largeExpectedLength);
      } else {
        largeTotalMs += measureOne(largeVariants[variant], largeExpectedLength);
        smallTotalMs += measureOne(smallVariants[variant], smallExpectedLength);
      }
    }
    samples.push({
      smallMs: smallTotalMs / iterations,
      largeMs: largeTotalMs / iterations,
    });
  }
  samples.sort((a, b) => (a.largeMs / a.smallMs) - (b.largeMs / b.smallMs));
  return samples[1];
}

process.stdout.write(JSON.stringify(measureSparqlRedosGrowth()));
