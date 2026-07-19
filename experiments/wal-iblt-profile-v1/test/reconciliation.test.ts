import { describe, expect, it } from 'vitest';
import {
  DecodeFailure,
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  applyId,
  applyDecodedDifference,
  bytesToHex,
  deriveReconciliationSeed,
  emptySymbol,
  idChecksum,
  idMappingSeed,
  createMappingCursor,
  nextMappingIndex,
  reconcileSets,
  setCommitment,
  verifyDecodedDifference
} from '../src/index.js';
import { deterministicId, deterministicSet } from '../scripts/fixtures.js';

function seed(label: string): Uint8Array {
  return deriveReconciliationSeed(
    deterministicId(`requester:${label}`),
    deterministicId(`provider:${label}`),
    deterministicId(`nonce:${label}`)
  );
}

function hexSet(ids: readonly Uint8Array[]): Set<string> {
  return new Set(ids.map(bytesToHex));
}

describe('incremental rateless decoding', () => {
  it('recovers exact two-sided differences while preserving prior work', () => {
    const common = deterministicSet('incremental-common', 20);
    const providerOnly = deterministicSet('incremental-provider', 4);
    const receiverOnly = deterministicSet('incremental-receiver', 3);
    const provider = [...common, ...providerOnly];
    const receiver = [...common, ...receiverOnly];
    const reconciliationSeed = seed('incremental');
    const encoder = new RatelessIbltEncoder(provider, reconciliationSeed, PAPER_BASELINE_V0.mapping);
    const decoder = new RatelessIbltDecoder(receiver, reconciliationSeed, PAPER_BASELINE_V0.mapping, 100);
    decoder.addProviderSymbol(encoder.produceNext());
    const first = decoder.snapshot();
    expect(first.complete).toBe(false);
    for (let index = 1; index < 100 && !decoder.complete; index += 1) {
      decoder.addProviderSymbol(encoder.produceNext());
    }
    const decoded = decoder.snapshot();
    expect(decoded.complete).toBe(true);
    expect(hexSet(decoded.providerOnly)).toEqual(hexSet(providerOnly));
    expect(hexSet(decoded.receiverOnly)).toEqual(hexSet(receiverOnly));
    expect(decoded.peelTrace.length).toBe(decoded.receivedSymbols);
    expect(decoder.residualSymbols().every((symbol) => symbol.count === 0n)).toBe(true);
    verifyDecodedDifference(receiver, decoded, provider.length, setCommitment(provider));
  });

  it('rejects non-contiguous symbols and bounded output exhaustion', () => {
    const reconciliationSeed = seed('failure');
    const provider = deterministicSet('failure-provider', 2);
    const encoder = new RatelessIbltEncoder(provider, reconciliationSeed, PAPER_BASELINE_V0.mapping);
    const decoder = new RatelessIbltDecoder([], reconciliationSeed, PAPER_BASELINE_V0.mapping, 1);
    const first = encoder.produceNext();
    const second = encoder.produceNext();
    expect(() => decoder.addProviderSymbol(second)).toThrowError(DecodeFailure);
    decoder.addProviderSymbol(first);
    expect(() => decoder.addProviderSymbol(second)).toThrowError(/difference limit/i);
    expect(() => new RatelessIbltDecoder([], reconciliationSeed, PAPER_BASELINE_V0.mapping, 0)).toThrow('positive');
  });

  it('rejects a malicious stream that decodes the same ID twice', () => {
    const reconciliationSeed = seed('duplicate-output');
    const duplicate = deterministicId('duplicate-output-id');
    const checksum = idChecksum(reconciliationSeed, duplicate);
    const decoder = new RatelessIbltDecoder([], reconciliationSeed, PAPER_BASELINE_V0.mapping, 10);
    const first = emptySymbol(0);
    applyId(first, duplicate, checksum, 1n);
    decoder.addProviderSymbol(first);

    const cursor = createMappingCursor(idMappingSeed(reconciliationSeed, duplicate));
    const appearsInOne = nextMappingIndex(cursor, PAPER_BASELINE_V0.mapping) === 1;
    const second = emptySymbol(1);
    applyId(second, duplicate, checksum, 1n);
    if (appearsInOne) applyId(second, duplicate, checksum, 1n);
    expect(() => decoder.addProviderSymbol(second)).toThrowError(/more than once/);
  });

  it('does not treat a corrupted checksum cell as pure', () => {
    const reconciliationSeed = seed('checksum');
    const provider = [deterministicId('checksum-provider')];
    const encoder = new RatelessIbltEncoder(provider, reconciliationSeed, PAPER_BASELINE_V0.mapping);
    const corrupted = encoder.produceNext();
    corrupted.checksumXor[0] ^= 1;
    const decoder = new RatelessIbltDecoder([], reconciliationSeed, PAPER_BASELINE_V0.mapping, 10);
    decoder.addProviderSymbol(corrupted);
    expect(decoder.complete).toBe(false);
    expect(decoder.snapshot().providerOnly).toEqual([]);
  });
});

describe('verified reconciliation driver', () => {
  it('short-circuits equal roots with zero symbols', () => {
    const ids = deterministicSet('equal', 20);
    const result = reconcileSets(ids, [...ids].reverse(), seed('equal'));
    expect(result.path).toBe('equal');
    expect(result.symbolsReceived).toBe(0);
  });

  it('uses exact fallback for an empty receiver and can force IBLT for experiments', () => {
    const provider = deterministicSet('backfill', 10);
    const fallback = reconcileSets(provider, [], seed('backfill'), { fallbackPageSize: 3 });
    expect(fallback.path).toBe('fallback');
    expect(fallback.fallbackPages).toHaveLength(4);
    const iblt = reconcileSets(provider, [], seed('backfill-force'), { forceIbltForEmptyReceiver: true });
    expect(iblt.path).toBe('iblt');
    expect(hexSet(iblt.providerOnly)).toEqual(hexSet(provider));
  });

  it('recovers randomized oracle differences across deterministic seeds', () => {
    for (let repetition = 0; repetition < 250; repetition += 1) {
      const common = deterministicSet(`property-common:${repetition}`, repetition % 17);
      const providerOnly = deterministicSet(`property-provider:${repetition}`, repetition % 5);
      const receiverOnly = deterministicSet(`property-receiver:${repetition}`, repetition % 7);
      const provider = [...common, ...providerOnly];
      const receiver = [...common, ...receiverOnly];
      const result = reconcileSets(provider, receiver, seed(`property:${repetition}`), {
        forceIbltForEmptyReceiver: true
      });
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
      stream: { ...PAPER_BASELINE_V0.stream, initialWindowSymbols: 1, maximumSymbols: 1 }
    };
    const provider = deterministicSet('tiny-provider', 4);
    const receiver = deterministicSet('tiny-receiver', 4);
    const result = reconcileSets(provider, receiver, seed('tiny'), { profile: tinyBudget, fallbackPageSize: 2 });
    expect(result.path).toBe('fallback');
    expect(result.symbolsReceived).toBe(1);
    expect(result.fallbackPages).toHaveLength(2);
  });

  it('rejects invalid reconstructed differences, counts, roots, and incomplete decode', () => {
    const receiver = [deterministicId('receiver-existing')];
    const absent = deterministicId('absent');
    expect(() => applyDecodedDifference(receiver, [], [absent])).toThrow('absent');
    expect(() => applyDecodedDifference(receiver, [receiver[0]], [])).toThrow('already exists');
    expect(() => applyDecodedDifference([receiver[0], receiver[0]], [], [])).toThrow('duplicate');
    const incomplete = {
      complete: false,
      receivedSymbols: 1,
      decodedSymbols: 0,
      providerOnly: [],
      receiverOnly: [],
      peelTrace: []
    };
    expect(() => verifyDecodedDifference(receiver, incomplete, 1, setCommitment(receiver))).toThrow('incomplete');
    const complete = { ...incomplete, complete: true, decodedSymbols: 1 };
    expect(() => verifyDecodedDifference(receiver, complete, 2, setCommitment(receiver))).toThrow('count');
    expect(() => verifyDecodedDifference(receiver, complete, 1, deterministicId('wrong-root'))).toThrow('root');
  });
});
