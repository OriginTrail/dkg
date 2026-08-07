import { describe, expect, it } from 'vitest';
import {
  DecodeFailure,
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  ReconciliationBudget,
  ReconciliationError,
  applyDecodedDifference,
  applyId,
  bytesToHex,
  createMappingCursor,
  emptySymbol,
  idChecksum,
  idMappingSeed,
  nextMappingIndex,
  reconcileSets,
  reconciliationHead,
  setCommitmentRoot,
  verifyDecodedDifference,
  type ReconciliationLimits
} from '../../src/reconciliation/index.js';
import { MinIndexQueue } from '../../src/reconciliation/decoder.js';
import {
  deterministicHead,
  deterministicId,
  deterministicSeed,
  deterministicSet
} from '../support/fixtures.js';

const generousLimits: ReconciliationLimits = {
  maximumSymbols: 1_000,
  maximumDecodedDifference: 1_000,
  maximumOperations: 1_000_000,
  maximumMemoryBytes: 64 * 1024 * 1024,
  maximumElapsedMs: 60_000
};

function hexSet(ids: readonly Uint8Array[]): Set<string> {
  return new Set(ids.map(bytesToHex));
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    expect.fail('operation unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(ReconciliationError);
    expect((error as ReconciliationError).code).toBe(code);
  }
}

describe('incremental rateless decoding', () => {
  it('recovers exact two-sided differences while preserving prior work', () => {
    const common = deterministicSet('incremental-common', 20);
    const providerOnly = deterministicSet('incremental-provider', 4);
    const receiverOnly = deterministicSet('incremental-receiver', 3);
    const provider = [...common, ...providerOnly];
    const receiver = [...common, ...receiverOnly];
    const reconciliationSeed = deterministicSeed('incremental');
    const encoder = new RatelessIbltEncoder({
      ids: provider,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const decoder = new RatelessIbltDecoder({
      receiverIds: receiver,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    expect(decoder.snapshot().state).toBe('awaiting-symbols');
    decoder.addEncodedProviderWindow(encoder.produceEncodedWindow(1));
    const first = decoder.snapshot();
    expect(first.complete).toBe(false);
    expect(first.state).toBe('needs-more-symbols');
    expect(first.providerOnly).toEqual([]);
    expect(first.receiverOnly).toEqual([]);
    for (let index = 1; index < 100 && !decoder.complete; index += 1) {
      decoder.addEncodedProviderSymbol(encoder.produceEncodedWindow(1)[0]);
    }
    const decoded = decoder.snapshot();
    expect(decoded.state).toBe('complete');
    expect(decoded.complete).toBe(true);
    expect(decoder.decodedDifferenceSize).toBe(7);
    expect(hexSet(decoded.providerOnly)).toEqual(hexSet(providerOnly));
    expect(hexSet(decoded.receiverOnly)).toEqual(hexSet(receiverOnly));
    expect(decoded.peelTrace.length).toBe(decoded.receivedSymbols);
    expect(decoder.residualSymbols().every((symbol) => symbol.count === 0n)).toBe(true);
    verifyDecodedDifference(receiver, decoded, deterministicHead('incremental-provider-head', provider));
  });

  it('rejects non-contiguous symbols and bounded output exhaustion', () => {
    const reconciliationSeed = deterministicSeed('failure');
    const provider = deterministicSet('failure-provider', 2);
    const encoder = new RatelessIbltEncoder({
      ids: provider,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const decoder = new RatelessIbltDecoder({
      receiverIds: [],
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: { ...generousLimits, maximumDecodedDifference: 1 }
    });
    const first = encoder.produceNext();
    const second = encoder.produceNext();
    expect(() => decoder.addProviderSymbol(second)).toThrowError(DecodeFailure);
    decoder.addProviderSymbol(first);
    let limitError: unknown;
    for (let index = 1; index < 100 && limitError === undefined; index += 1) {
      try {
        decoder.addProviderSymbol(index === 1 ? second : encoder.produceNext());
      } catch (error) {
        limitError = error;
      }
    }
    expect(limitError).toBeInstanceOf(ReconciliationError);
    expect((limitError as ReconciliationError).code).toBe('DECODED_DIFFERENCE_LIMIT');
  });

  it('rejects a malicious stream that decodes the same ID twice', () => {
    const reconciliationSeed = deterministicSeed('duplicate-output');
    const duplicate = deterministicId('duplicate-output-id');
    const checksum = idChecksum(reconciliationSeed, duplicate);
    const decoder = new RatelessIbltDecoder({
      receiverIds: [],
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const first = emptySymbol(0);
    applyId(first, duplicate, checksum, 1n);
    decoder.addProviderSymbol(first);

    const cursor = createMappingCursor(idMappingSeed(reconciliationSeed, duplicate));
    const appearsInOne = nextMappingIndex(cursor, PAPER_BASELINE_V0.algorithm.mapping) === 1;
    const second = emptySymbol(1);
    applyId(second, duplicate, checksum, 1n);
    if (appearsInOne) applyId(second, duplicate, checksum, 1n);
    expectCode(() => decoder.addProviderSymbol(second), 'DUPLICATE_DECODED_ID');
  });

  it('does not treat a corrupted checksum cell as pure', () => {
    const reconciliationSeed = deterministicSeed('checksum');
    const provider = [deterministicId('checksum-provider')];
    const encoder = new RatelessIbltEncoder({
      ids: provider,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const corrupted = encoder.produceNext();
    corrupted.checksumXor[0] ^= 1;
    const decoder = new RatelessIbltDecoder({
      receiverIds: [],
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    decoder.addProviderWindow([corrupted]);
    expect(decoder.complete).toBe(false);
    expect(decoder.snapshot().providerOnly).toEqual([]);
  });

  it('preserves a non-peelable core across continuation without exposing partial output', () => {
    const providerOnly = deterministicSet('continuation-provider', 8);
    const receiverOnly = deterministicSet('continuation-receiver', 8);
    const reconciliationSeed = deterministicSeed('continuation');
    const encoder = new RatelessIbltEncoder({
      ids: providerOnly,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const decoder = new RatelessIbltDecoder({
      receiverIds: receiverOnly,
      reconciliationSeed,
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    decoder.addProviderSymbol(encoder.produceNext());
    const core = decoder.residualSymbols();
    expect(decoder.snapshot()).toMatchObject({
      state: 'needs-more-symbols',
      complete: false,
      providerOnly: [],
      receiverOnly: []
    });
    expect(core).toHaveLength(1);
    for (let index = 1; index < 256 && !decoder.complete; index += 1) {
      decoder.addProviderSymbol(encoder.produceNext());
    }
    expect(decoder.complete).toBe(true);
    expect(decoder.receivedSymbols).toBeGreaterThan(1);
    expect(hexSet(decoder.snapshot().providerOnly)).toEqual(hexSet(providerOnly));
    expect(hexSet(decoder.snapshot().receiverOnly)).toEqual(hexSet(receiverOnly));
  });

  it('fails closed for a symbol stream derived under the wrong seed', () => {
    const provider = deterministicSet('wrong-seed-provider', 4);
    const receiver = deterministicSet('wrong-seed-receiver', 4);
    const encoder = new RatelessIbltEncoder({
      ids: provider,
      reconciliationSeed: deterministicSeed('right-seed'),
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const decoder = new RatelessIbltDecoder({
      receiverIds: receiver,
      reconciliationSeed: deterministicSeed('wrong-seed'),
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    decoder.addProviderWindow(encoder.produceWindow(128));
    const result = decoder.snapshot();
    expect(result.complete).toBe(false);
    expect(result.providerOnly).toEqual([]);
    expect(result.receiverOnly).toEqual([]);
    expectCode(
      () => verifyDecodedDifference(receiver, result, deterministicHead('wrong-seed-head', provider)),
      'INCOMPLETE_DECODE'
    );
  });

  it('peels queued cells in deterministic lowest-index order', () => {
    const queue = new MinIndexQueue();
    for (const value of [7, 3, 9, 1, 8, 2, 6, 4, 5, 0, 7]) queue.add(value);
    expect(queue.length).toBe(10);
    expect(Array.from({ length: 10 }, () => queue.take())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(queue.length).toBe(0);
  });
});

describe('verified reconciliation driver', () => {
  it('covers one-ID, one-sided, disjoint, and high-overlap set shapes', () => {
    const scenarios = [
      {
        name: 'one-id-provider-only',
        provider: [deterministicId('shape-one')],
        receiver: []
      },
      {
        name: 'one-sided-receiver-only',
        provider: [],
        receiver: deterministicSet('shape-receiver-only', 5)
      },
      {
        name: 'disjoint',
        provider: deterministicSet('shape-disjoint-provider', 20),
        receiver: deterministicSet('shape-disjoint-receiver', 20)
      },
      {
        name: 'high-overlap',
        provider: [
          ...deterministicSet('shape-overlap-common', 100),
          deterministicId('shape-overlap-provider')
        ],
        receiver: [
          ...deterministicSet('shape-overlap-common', 100),
          deterministicId('shape-overlap-receiver')
        ]
      }
    ];
    const configuration = {
      ...PAPER_BASELINE_V0,
      fallback: { ...PAPER_BASELINE_V0.fallback, maximumOverheadRatio: Number.MAX_VALUE }
    };
    for (const scenario of scenarios) {
      const providerOracle = new Set(scenario.provider.map(bytesToHex));
      const receiverOracle = new Set(scenario.receiver.map(bytesToHex));
      const expectedProvider = new Set([...providerOracle].filter((id) => !receiverOracle.has(id)));
      const expectedReceiver = new Set([...receiverOracle].filter((id) => !providerOracle.has(id)));
      const result = reconcileSets(
        scenario.provider,
        scenario.receiver,
        deterministicSeed(`shape:${scenario.name}`),
        deterministicHead(`shape-head:${scenario.name}`, scenario.provider),
        { configuration, forceIbltForEmptyReceiver: true }
      );
      expect(result.path, scenario.name).toBe('iblt');
      expect(hexSet(result.providerOnly), scenario.name).toEqual(expectedProvider);
      expect(hexSet(result.receiverOnly), scenario.name).toEqual(expectedReceiver);
    }
  });

  it('short-circuits equal roots with zero symbols', () => {
    const ids = deterministicSet('equal', 20);
    const head = deterministicHead('equal-head', ids);
    const result = reconcileSets(ids, [...ids].reverse(), deterministicSeed('equal'), head);
    expect(result.path).toBe('equal');
    expect(result.symbolsReceived).toBe(0);
    expect(result.providerHead).toEqual(head);
  });

  it('uses exact fallback for an empty receiver and can force IBLT', () => {
    const provider = deterministicSet('backfill', 10);
    const head = deterministicHead('backfill-head', provider);
    const fallback = reconcileSets(provider, [], deterministicSeed('backfill'), head, { fallbackPageSize: 3 });
    expect(fallback.path).toBe('fallback');
    expect(fallback.fallbackReason).toBe('EMPTY_RECEIVER');
    expect(fallback.fallbackPages).toHaveLength(4);
    const iblt = reconcileSets(provider, [], deterministicSeed('backfill-force'), head, {
      forceIbltForEmptyReceiver: true
    });
    expect(iblt.path).toBe('iblt');
    expect(hexSet(iblt.providerOnly)).toEqual(hexSet(provider));
  });

  it('recovers randomized oracle differences across deterministic seeds', () => {
    const propertyConfiguration = {
      ...PAPER_BASELINE_V0,
      fallback: { ...PAPER_BASELINE_V0.fallback, maximumOverheadRatio: Number.MAX_VALUE }
    };
    for (let repetition = 0; repetition < 250; repetition += 1) {
      const common = deterministicSet(`property-common:${repetition}`, repetition % 17);
      const providerOnly = deterministicSet(`property-provider:${repetition}`, repetition % 5);
      const receiverOnly = deterministicSet(`property-receiver:${repetition}`, repetition % 7);
      const provider = [...common, ...providerOnly];
      const receiver = [...common, ...receiverOnly];
      const result = reconcileSets(
        provider,
        receiver,
        deterministicSeed(`property:${repetition}`),
        deterministicHead(`property-head:${repetition}`, provider),
        { configuration: propertyConfiguration, forceIbltForEmptyReceiver: true }
      );
      if (providerOnly.length === 0 && receiverOnly.length === 0) {
        expect(result.path).toBe('equal');
      } else {
        expect(result.path).toBe('iblt');
        expect(hexSet(result.providerOnly)).toEqual(hexSet(providerOnly));
        expect(hexSet(result.receiverOnly)).toEqual(hexSet(receiverOnly));
      }
    }
  });

  it('falls back when the candidate symbol budget is exhausted', () => {
    const tinyBudget = {
      ...PAPER_BASELINE_V0,
      stream: { ...PAPER_BASELINE_V0.stream, initialWindowSymbols: 1 },
      limits: { ...PAPER_BASELINE_V0.limits, maximumSymbols: 1 }
    };
    const provider = deterministicSet('tiny-provider', 4);
    const receiver = deterministicSet('tiny-receiver', 4);
    const result = reconcileSets(
      provider,
      receiver,
      deterministicSeed('tiny'),
      deterministicHead('tiny-head', provider),
      { configuration: tinyBudget, fallbackPageSize: 2 }
    );
    expect(result.path).toBe('fallback');
    expect(result.fallbackReason).toBe('SYMBOL_LIMIT');
    expect(result.symbolsReceived).toBe(1);
    expect(result.fallbackPages).toHaveLength(2);
  });

  it('rejects invalid provider heads and reconstructed differences', () => {
    const provider = deterministicSet('bad-head-provider', 2);
    const receiver = [deterministicId('receiver-existing')];
    const validHead = deterministicHead('bad-head', provider);
    const wrongCount = reconciliationHead(validHead.headId, 3, validHead.objectSetRoot);
    expectCode(
      () => reconcileSets(provider, receiver, deterministicSeed('bad-count'), wrongCount),
      'COUNT_MISMATCH'
    );
    const wrongRoot = reconciliationHead(
      validHead.headId,
      provider.length,
      setCommitmentRoot(deterministicId('wrong-root'))
    );
    expectCode(
      () => reconcileSets(provider, receiver, deterministicSeed('bad-root'), wrongRoot),
      'ROOT_MISMATCH'
    );

    const absent = deterministicId('absent');
    expectCode(() => applyDecodedDifference(receiver, [], [absent]), 'ROOT_MISMATCH');
    expectCode(() => applyDecodedDifference(receiver, [receiver[0]], []), 'ROOT_MISMATCH');
    expectCode(() => applyDecodedDifference([receiver[0], receiver[0]], [], []), 'DUPLICATE_WAL_OBJECT_ID');

    const decoder = new RatelessIbltDecoder({
      receiverIds: receiver,
      reconciliationSeed: deterministicSeed('incomplete'),
      algorithm: PAPER_BASELINE_V0.algorithm,
      limits: generousLimits
    });
    const incomplete = decoder.snapshot();
    expectCode(
      () => verifyDecodedDifference(receiver, incomplete, deterministicHead('receiver-head', receiver)),
      'INCOMPLETE_DECODE'
    );
    const emptyComplete = { ...incomplete, state: 'complete' as const, complete: true };
    const countMismatch = reconciliationHead(
      deterministicHead('receiver-head', receiver).headId,
      2,
      deterministicHead('receiver-head', receiver).objectSetRoot
    );
    expectCode(() => verifyDecodedDifference(receiver, emptyComplete, countMismatch), 'COUNT_MISMATCH');
    const rootMismatch = reconciliationHead(
      deterministicHead('receiver-head', receiver).headId,
      1,
      setCommitmentRoot(deterministicId('another-root'))
    );
    expectCode(() => verifyDecodedDifference(receiver, emptyComplete, rootMismatch), 'ROOT_MISMATCH');
  });

  it('uses overhead fallback and rethrows non-resource algorithm failures', () => {
    let overheadResult: ReturnType<typeof reconcileSets> | undefined;
    for (let repetition = 0; repetition < 250 && overheadResult === undefined; repetition += 1) {
      const common = deterministicSet(`property-common:${repetition}`, repetition % 17);
      const provider = [...common, ...deterministicSet(`property-provider:${repetition}`, repetition % 5)];
      const receiver = [...common, ...deterministicSet(`property-receiver:${repetition}`, repetition % 7)];
      const result = reconcileSets(
        provider,
        receiver,
        deterministicSeed(`property:${repetition}`),
        deterministicHead(`property-head:${repetition}`, provider),
        { forceIbltForEmptyReceiver: true }
      );
      if (result.fallbackReason === 'OVERHEAD_POLICY') overheadResult = result;
    }
    expect(overheadResult?.path).toBe('fallback');

    const provider = deterministicSet('algorithm-failure-provider', 2);
    const receiver = deterministicSet('algorithm-failure-receiver', 2);
    const unsafeConfiguration = {
      ...PAPER_BASELINE_V0,
      algorithm: {
        ...PAPER_BASELINE_V0.algorithm,
        mapping: {
          ...PAPER_BASELINE_V0.algorithm.mapping,
          inverseSqrtNumerator: Number.MAX_VALUE
        }
      }
    };
    expectCode(
      () => reconcileSets(
        provider,
        receiver,
        deterministicSeed('algorithm-failure'),
        deterministicHead('algorithm-failure-head', provider),
        { configuration: unsafeConfiguration }
      ),
      'INTEGER_OUT_OF_RANGE'
    );
  });
});

describe('deterministic resource limits', () => {
  it('enforces symbol, operation, memory, elapsed-time, and release accounting', () => {
    const limits = { ...generousLimits, maximumSymbols: 1 };
    const budget = new ReconciliationBudget(limits, { now: () => 0 });
    budget.acceptSymbol();
    expectCode(() => budget.acceptSymbol(), 'SYMBOL_LIMIT');

    const operationBudget = new ReconciliationBudget(
      { ...generousLimits, maximumOperations: 1 },
      { now: () => 0 }
    );
    operationBudget.chargeOperations();
    expectCode(() => operationBudget.chargeOperations(), 'OPERATION_LIMIT');
    expectCode(() => operationBudget.chargeOperations(0), 'INVALID_CONFIGURATION');

    const memoryBudget = new ReconciliationBudget(
      { ...generousLimits, maximumMemoryBytes: 128 },
      { now: () => 0 }
    );
    memoryBudget.reserveMemory(64);
    memoryBudget.releaseMemory(32);
    expect(memoryBudget.snapshot().accountedMemoryBytes).toBe(32);
    expectCode(() => memoryBudget.reserveMemory(128), 'MEMORY_LIMIT');
    expectCode(() => memoryBudget.reserveMemory(0), 'INVALID_CONFIGURATION');
    expectCode(() => memoryBudget.releaseMemory(1_000), 'INVALID_CONFIGURATION');

    let now = 0;
    const elapsedBudget = new ReconciliationBudget(
      { ...generousLimits, maximumElapsedMs: 1 },
      { now: () => now }
    );
    now = 2;
    expectCode(() => elapsedBudget.checkElapsed(), 'ELAPSED_TIME_LIMIT');
  });

  it('converts an integrated memory exhaustion into exact fallback', () => {
    const provider = deterministicSet('memory-provider', 2);
    const receiver = deterministicSet('memory-receiver', 2);
    const configuration = {
      ...PAPER_BASELINE_V0,
      limits: { ...PAPER_BASELINE_V0.limits, maximumMemoryBytes: 127 }
    };
    const result = reconcileSets(
      provider,
      receiver,
      deterministicSeed('memory'),
      deterministicHead('memory-head', provider),
      { configuration }
    );
    expect(result.path).toBe('fallback');
    expect(result.fallbackReason).toBe('MEMORY_LIMIT');
  });

  it('uses decoder defaults when explicit limits are omitted', () => {
    const decoder = new RatelessIbltDecoder({
      receiverIds: [],
      reconciliationSeed: deterministicSeed('defaults'),
      algorithm: PAPER_BASELINE_V0.algorithm
    });
    expect(decoder.usage.symbols).toBe(0);
  });
});
