import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  bytesToHex,
  hashBytes,
  reconciliationSeed,
  u64be,
  walObjectId,
  type ReconciliationUsage,
  type ReconciliationLimits,
  type WalObjectId
} from '../src/reconciliation/index.js';

export interface FixedDifferenceScenario {
  provider: WalObjectId[];
  receiver: WalObjectId[];
  providerOnly: WalObjectId[];
  receiverOnly: WalObjectId[];
}

export interface ReconciliationBenchmarkResult {
  setSize: number;
  differenceSize: number;
  inputMode: 'sorted-stream';
  scenarioBuildMs: number;
  encoderSetupMs: number;
  decoderSetupMs: number;
  setupMs: number;
  streamMs: number;
  totalMs: number;
  setupIdsPerSecond: number;
  symbols: number;
  canonicalWireBytes: number;
  symbolsPerDifference: number;
  bytesPerDifference: number;
  limits: ReconciliationLimits;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
  };
  encoderUsage: ReconciliationUsage;
  decoderUsage: ReconciliationUsage;
}

export function sequentialWalObjectId(index: number, domain: number): WalObjectId {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, domain, false);
  view.setBigUint64(24, BigInt(index), false);
  return walObjectId(bytes);
}

export function createFixedDifferenceScenario(setSize: number, eachSideDifference: number): FixedDifferenceScenario {
  if (!Number.isSafeInteger(setSize) || setSize <= eachSideDifference) {
    throw new RangeError('setSize must be an integer larger than the one-sided difference');
  }
  const common = Array.from(
    { length: setSize - eachSideDifference },
    (_, index) => sequentialWalObjectId(index, 1)
  );
  const providerOnly = Array.from(
    { length: eachSideDifference },
    (_, index) => sequentialWalObjectId(index, 2)
  );
  const receiverOnly = Array.from(
    { length: eachSideDifference },
    (_, index) => sequentialWalObjectId(index, 3)
  );
  return {
    provider: [...common, ...providerOnly],
    receiver: [...common, ...receiverOnly],
    providerOnly,
    receiverOnly
  };
}

export interface FixedDifferenceStreamingInput {
  providerIds: Iterable<WalObjectId>;
  receiverIds: Iterable<WalObjectId>;
  providerOnly: WalObjectId[];
  receiverOnly: WalObjectId[];
}

function sequentialIds(count: number, domain: number): Iterable<WalObjectId> {
  return {
    *[Symbol.iterator](): Iterator<WalObjectId> {
      for (let index = 0; index < count; index += 1) yield sequentialWalObjectId(index, domain);
    }
  };
}

function combinedIds(commonCount: number, uniqueCount: number, uniqueDomain: number): Iterable<WalObjectId> {
  return {
    *[Symbol.iterator](): Iterator<WalObjectId> {
      yield* sequentialIds(commonCount, 1);
      yield* sequentialIds(uniqueCount, uniqueDomain);
    }
  };
}

export function createFixedDifferenceStreamingInput(
  setSize: number,
  eachSideDifference: number
): FixedDifferenceStreamingInput {
  if (!Number.isSafeInteger(setSize) || setSize <= eachSideDifference) {
    throw new RangeError('setSize must be an integer larger than the one-sided difference');
  }
  const commonCount = setSize - eachSideDifference;
  return {
    providerIds: combinedIds(commonCount, eachSideDifference, 2),
    receiverIds: combinedIds(commonCount, eachSideDifference, 3),
    providerOnly: Array.from(
      { length: eachSideDifference },
      (_, index) => sequentialWalObjectId(index, 2)
    ),
    receiverOnly: Array.from(
      { length: eachSideDifference },
      (_, index) => sequentialWalObjectId(index, 3)
    )
  };
}

export function runReconciliationBenchmark(
  setSize: number,
  eachSideDifference = 16,
  maximumSymbols = 4_096
): ReconciliationBenchmarkResult {
  const startedAt = performance.now();
  const scenario = createFixedDifferenceStreamingInput(setSize, eachSideDifference);
  const scenarioBuiltAt = performance.now();
  const seed = reconciliationSeed(hashBytes(u64be(BigInt(setSize))));
  const limits: ReconciliationLimits = {
    ...PAPER_BASELINE_V0.limits,
    maximumMemoryBytes: Math.max(
      PAPER_BASELINE_V0.limits.maximumMemoryBytes,
      setSize * 128 + maximumSymbols * 128 + eachSideDifference * 128
    ),
    maximumElapsedMs: 30 * 60 * 1_000
  };
  const encoder = new RatelessIbltEncoder({
    ids: scenario.providerIds,
    idCount: setSize,
    idsAreSorted: true,
    reconciliationSeed: seed,
    algorithm: PAPER_BASELINE_V0.algorithm,
    limits
  });
  const encoderBuiltAt = performance.now();
  const decoder = new RatelessIbltDecoder({
    receiverIds: scenario.receiverIds,
    idCount: setSize,
    idsAreSorted: true,
    reconciliationSeed: seed,
    algorithm: PAPER_BASELINE_V0.algorithm,
    limits
  });
  const streamingStartedAt = performance.now();
  let canonicalWireBytes = 0;
  while (!decoder.complete && decoder.receivedSymbols < maximumSymbols) {
    const encoded = encoder.produceEncodedWindow(1)[0];
    canonicalWireBytes += encoded.length;
    decoder.addEncodedProviderSymbol(encoded);
  }
  const finishedAt = performance.now();
  const snapshot = decoder.snapshot();
  if (!snapshot.complete) throw new Error(`benchmark did not decode N=${setSize}`);
  const actualProvider = new Set(snapshot.providerOnly.map(bytesToHex));
  const actualReceiver = new Set(snapshot.receiverOnly.map(bytesToHex));
  if (
    actualProvider.size !== eachSideDifference ||
    actualReceiver.size !== eachSideDifference ||
    scenario.providerOnly.some((id) => !actualProvider.has(bytesToHex(id))) ||
    scenario.receiverOnly.some((id) => !actualReceiver.has(bytesToHex(id)))
  ) {
    throw new Error(`benchmark decoded the wrong difference for N=${setSize}`);
  }
  const setupMs = streamingStartedAt - startedAt;
  const streamMs = finishedAt - streamingStartedAt;
  const totalMs = finishedAt - startedAt;
  const differenceSize = eachSideDifference * 2;
  const memory = process.memoryUsage();
  const resourceUsage = process.resourceUsage();
  return {
    setSize,
    differenceSize,
    inputMode: 'sorted-stream',
    scenarioBuildMs: scenarioBuiltAt - startedAt,
    encoderSetupMs: encoderBuiltAt - scenarioBuiltAt,
    decoderSetupMs: streamingStartedAt - encoderBuiltAt,
    setupMs,
    streamMs,
    totalMs,
    setupIdsPerSecond: Math.round((setSize * 2 / setupMs) * 1_000),
    symbols: snapshot.receivedSymbols,
    canonicalWireBytes,
    symbolsPerDifference: snapshot.receivedSymbols / differenceSize,
    bytesPerDifference: canonicalWireBytes / differenceSize,
    limits,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      maxRssBytes: resourceUsage.maxRSS * 1024
    },
    encoderUsage: encoder.usage,
    decoderUsage: decoder.usage
  };
}
