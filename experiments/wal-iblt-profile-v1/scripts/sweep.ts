import { performance } from 'node:perf_hooks';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  deriveReconciliationSeed,
  type ReconciliationConfiguration,
  type ReconciliationSeed,
  type WalObjectId
} from '@origintrail-official/dkg-wal/reconciliation';
import { deterministicHeadId, deterministicId, deterministicSet } from './fixtures.js';

interface SweepRow {
  profile: string;
  setSize: number;
  symmetricDifference: number;
  repetition: number;
  exactSymbols: number;
  exactOverhead: number;
  wireSymbolsByWindow: Record<string, number>;
  elapsedMs: number;
}

const configurations: ReconciliationConfiguration[] = [1.25, 1.5, 1.75].map((indexOffset) => ({
  ...PAPER_BASELINE_V0,
  candidateName: `paper-mapping-offset-${indexOffset}`,
  algorithm: {
    ...PAPER_BASELINE_V0.algorithm,
    mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, indexOffset }
  }
}));
const cases = [
  { setSize: 100, difference: 2 },
  { setSize: 1_000, difference: 10 },
  { setSize: 10_000, difference: 100 }
];
const rows: SweepRow[] = [];
const windowPolicies = [4, 8, 16, 32].map((initialWindowSymbols) => ({
  name: `initial-${initialWindowSymbols}-growth-2x`,
  initialWindowSymbols,
  growthNumerator: 2,
  growthDenominator: 1
}));

function symbolsSentForWindows(required: number, initial: number, numerator: number, denominator: number): number {
  let sent = 0;
  let window = initial;
  while (sent < required) {
    sent += window;
    window = Math.max(1, Math.ceil(window * numerator / denominator));
  }
  return sent;
}

function exactDecodeSymbols(
  provider: readonly WalObjectId[],
  receiver: readonly WalObjectId[],
  seed: ReconciliationSeed,
  configuration: ReconciliationConfiguration
): number {
  const encoder = new RatelessIbltEncoder({
    ids: provider,
    reconciliationSeed: seed,
    algorithm: configuration.algorithm,
    limits: configuration.limits
  });
  const decoder = new RatelessIbltDecoder({
    receiverIds: receiver,
    reconciliationSeed: seed,
    algorithm: configuration.algorithm,
    limits: configuration.limits
  });
  while ((decoder.receivedSymbols === 0 || !decoder.complete) && decoder.receivedSymbols < configuration.limits.maximumSymbols) {
    decoder.addProviderSymbol(encoder.produceNext());
  }
  if (!decoder.complete) throw new Error(`candidate ${configuration.candidateName} exhausted the symbol budget`);
  return decoder.receivedSymbols;
}

for (const configuration of configurations) {
  for (const scenario of cases) {
    for (let repetition = 0; repetition < 3; repetition += 1) {
      const oneSided = scenario.difference / 2;
      const common = deterministicSet(`common:${scenario.setSize}:${repetition}`, scenario.setSize - oneSided);
      const provider = [...common, ...deterministicSet(`provider:${scenario.setSize}:${repetition}`, oneSided)];
      const receiver = [...common, ...deterministicSet(`receiver:${scenario.setSize}:${repetition}`, oneSided)];
      const seed = deriveReconciliationSeed(
        deterministicHeadId(`requester-head:${repetition}`),
        deterministicHeadId(`provider-head:${repetition}`),
        deterministicId(`nonce:${repetition}`)
      );
      const started = performance.now();
      const exactSymbols = exactDecodeSymbols(provider, receiver, seed, configuration);
      rows.push({
        profile: configuration.candidateName,
        setSize: scenario.setSize,
        symmetricDifference: scenario.difference,
        repetition,
        exactSymbols,
        exactOverhead: exactSymbols / scenario.difference,
        wireSymbolsByWindow: Object.fromEntries(windowPolicies.map((policy) => [
          policy.name,
          symbolsSentForWindows(
            exactSymbols,
            policy.initialWindowSymbols,
            policy.growthNumerator,
            policy.growthDenominator
          )
        ])),
        elapsedMs: performance.now() - started
      });
    }
  }
}

const summaries = configurations.map((configuration) => {
  const profileRows = rows.filter((row) => row.profile === configuration.candidateName);
  return {
    profile: configuration.candidateName,
    meanExactOverhead: profileRows.reduce((sum, row) => sum + row.exactOverhead, 0) / profileRows.length,
    maximumExactOverhead: Math.max(...profileRows.map((row) => row.exactOverhead)),
    meanElapsedMs: profileRows.reduce((sum, row) => sum + row.elapsedMs, 0) / profileRows.length
  };
});

const baselineRows = rows.filter((row) => row.profile === 'paper-mapping-offset-1.5');
const windowSummaries = windowPolicies.map((policy) => ({
  policy: policy.name,
  meanWireOverhead: baselineRows.reduce(
    (sum, row) => sum + row.wireSymbolsByWindow[policy.name] / row.symmetricDifference,
    0
  ) / baselineRows.length,
  maximumWireOverhead: Math.max(...baselineRows.map(
    (row) => row.wireSymbolsByWindow[policy.name] / row.symmetricDifference
  ))
}));

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), cases, summaries, windowSummaries, rows }, null, 2));
