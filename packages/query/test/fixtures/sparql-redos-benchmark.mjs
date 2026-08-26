import { classifySparqlOperation } from '@origintrail-official/dkg-core/dist/sparql-operation.js';

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

function measureCpu(variants) {
  const expectedLength = detect(variants[0]).length;
  for (const variant of variants) detect(variant);

  for (let iterations = 1; iterations <= 4_096; iterations *= 2) {
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
      let resultLength = 0;
      const startedAt = process.cpuUsage();
      for (let index = 0; index < iterations; index++) {
        resultLength += detect(variants[(index + sample) % variants.length]).length;
      }
      const elapsed = process.cpuUsage(startedAt);
      if (resultLength !== expectedLength * iterations) {
        throw new Error(
          `SPARQL benchmark result mismatch: expected ` +
          `${expectedLength * iterations}, received ${resultLength}`,
        );
      }
      samples.push((elapsed.user + elapsed.system) / 1_000);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[1];
    if (medianMs >= 50 || iterations === 4_096) {
      return medianMs / iterations;
    }
  }
  throw new Error('unreachable SPARQL benchmark loop');
}

export function measureSparqlRedosGrowth() {
  const smallVariants = variantsFor(inputFor(1_000));
  const largeVariants = variantsFor(inputFor(10_000));
  return {
    smallMs: measureCpu(smallVariants),
    largeMs: measureCpu(largeVariants),
  };
}

process.stdout.write(JSON.stringify(measureSparqlRedosGrowth()));
