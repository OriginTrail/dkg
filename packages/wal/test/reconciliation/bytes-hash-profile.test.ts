import { describe, expect, it } from 'vitest';
import {
  INTEGER_ONLY_V1_CANDIDATE,
  PAPER_BASELINE_V0,
  assertLength,
  bytesToHex,
  compareBytes,
  concatBytes,
  copyBytes,
  createMappingCursor,
  deriveReconciliationSeed,
  equalBytes,
  expectedMembershipProbability,
  hexToBytes,
  idChecksum,
  idMappingSeed,
  isReconciliationError,
  integerSquareRoot,
  mappingIndexForState,
  isZero,
  nextMappingIndex,
  readU64le,
  u64be,
  validateReconciliationConfiguration,
  validateReconciliationLimits,
  ReconciliationError,
  xorInto
} from '../../src/reconciliation/index.js';
import { deterministicHeadId, deterministicId } from '../support/fixtures.js';

describe('byte primitives and domain-separated hashing', () => {
  it('copies, concatenates, compares, XORs, and converts bytes', () => {
    const left = Uint8Array.of(1, 2);
    const copied = copyBytes(left);
    copied[0] = 9;
    expect(left).toEqual(Uint8Array.of(1, 2));
    expect(concatBytes(left, Uint8Array.of(3))).toEqual(Uint8Array.of(1, 2, 3));
    expect(compareBytes(left, Uint8Array.of(1, 3))).toBeLessThan(0);
    expect(compareBytes(left, Uint8Array.of(1, 2, 0))).toBeLessThan(0);
    expect(equalBytes(left, Uint8Array.of(1, 2))).toBe(true);
    expect(equalBytes(left, Uint8Array.of(1))).toBe(false);
    expect(equalBytes(left, Uint8Array.of(1, 3))).toBe(false);
    xorInto(left, Uint8Array.of(1, 3));
    expect(left).toEqual(Uint8Array.of(0, 1));
    expect(isZero(left)).toBe(false);
    expect(isZero(new Uint8Array(2))).toBe(true);
    expect(bytesToHex(hexToBytes('00ff'))).toBe('00ff');
  });

  it('rejects malformed byte operations and integer ranges', () => {
    expect(() => assertLength(new Uint8Array(1), 2, 'fixture')).toThrow('fixture');
    expect(() => xorInto(new Uint8Array(1), new Uint8Array(2))).toThrow('equal length');
    expect(() => hexToBytes('0')).toThrow('hexadecimal');
    expect(() => hexToBytes('zz')).toThrow('hexadecimal');
    expect(() => hexToBytes('00', 2)).toThrow('exactly 2');
    expect(() => u64be(-1n)).toThrow('out of range');
    expect(() => u64be(1n << 64n)).toThrow('out of range');
    expect(() => readU64le(new Uint8Array(7))).toThrow('exactly 8');
    expect(u64be(0x0102_0304_0506_0708n)).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    expect(readU64le(Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1))).toBe(0x0102_0304_0506_0708n);
  });

  it('binds seed, role ordering, checksum, and mapping seed', () => {
    const requester = deterministicHeadId('requester');
    const provider = deterministicHeadId('provider');
    const nonce = deterministicId('nonce');
    const id = deterministicId('id');
    const seed = deriveReconciliationSeed(requester, provider, nonce);
    expect(seed).toHaveLength(32);
    expect(equalBytes(seed, deriveReconciliationSeed(provider, requester, nonce))).toBe(false);
    expect(idChecksum(seed, id)).toHaveLength(32);
    expect(idMappingSeed(seed, id)).toBeGreaterThanOrEqual(0n);
    expect(() => deriveReconciliationSeed(new Uint8Array(31) as never, provider, nonce)).toThrow();
    expect(() => deriveReconciliationSeed(requester, new Uint8Array(31) as never, nonce)).toThrow();
    expect(() => deriveReconciliationSeed(requester, provider, new Uint8Array(31))).toThrow();
    expect(() => idChecksum(new Uint8Array(31) as never, id)).toThrow();
    expect(() => idChecksum(seed, new Uint8Array(31) as never)).toThrow();
    expect(() => idMappingSeed(new Uint8Array(31) as never, id)).toThrow();
    expect(() => idMappingSeed(seed, new Uint8Array(31) as never)).toThrow();
  });
});

describe('candidate profile and mapping schedule', () => {
  it('generates a deterministic increasing membership sequence', () => {
    const first = createMappingCursor(123n);
    const second = createMappingCursor(123n);
    const indices = Array.from({ length: 20 }, () => nextMappingIndex(first, PAPER_BASELINE_V0.algorithm.mapping));
    expect(indices).toEqual(Array.from({ length: 20 }, () => nextMappingIndex(second, PAPER_BASELINE_V0.algorithm.mapping)));
    expect(indices.every((value, index) => index === 0 || value > indices[index - 1])).toBe(true);
    expect(expectedMembershipProbability(0)).toBe(1);
    expect(expectedMembershipProbability(2)).toBe(0.5);
  });

  it('generates the integer-only candidate with exact square roots', () => {
    expect(integerSquareRoot(0n)).toBe(0n);
    expect(integerSquareRoot(1n)).toBe(1n);
    expect(integerSquareRoot(2n)).toBe(1n);
    expect(integerSquareRoot(16n)).toBe(4n);
    expect(integerSquareRoot(17n)).toBe(4n);
    expect(() => integerSquareRoot(-1n)).toThrow('negative integer');

    const first = createMappingCursor(123n);
    const second = createMappingCursor(123n);
    const indices = Array.from(
      { length: 20 },
      () => nextMappingIndex(first, INTEGER_ONLY_V1_CANDIDATE.algorithm.mapping)
    );
    expect(indices).toEqual(Array.from(
      { length: 20 },
      () => nextMappingIndex(second, INTEGER_ONLY_V1_CANDIDATE.algorithm.mapping)
    ));
    expect(indices.every((value, index) => index === 0 || value > indices[index - 1])).toBe(true);
    expect(mappingIndexForState(
      0xffff_ffff_ffff_ffffn,
      7,
      INTEGER_ONLY_V1_CANDIDATE.algorithm.mapping
    )).toBe(8);

    const unsafe = createMappingCursor(1n);
    unsafe.lastIndex = Number.MAX_SAFE_INTEGER;
    expect(() => nextMappingIndex(unsafe, INTEGER_ONLY_V1_CANDIDATE.algorithm.mapping)).toThrow('safe integer');
  });

  it('rejects invalid cursor, index, and profile values', () => {
    expect(() => createMappingCursor(-1n)).toThrow('unsigned 64-bit');
    expect(() => createMappingCursor(1n << 64n)).toThrow('unsigned 64-bit');
    expect(() => expectedMembershipProbability(-1)).toThrow('non-negative');
    expect(() => expectedMembershipProbability(1.5)).toThrow('non-negative');
    const unsafe = createMappingCursor(1n);
    unsafe.lastIndex = Number.MAX_SAFE_INTEGER;
    expect(() => nextMappingIndex(unsafe, PAPER_BASELINE_V0.algorithm.mapping)).toThrow('safe integer');

    const invalidProfiles = [
      { ...PAPER_BASELINE_V0, candidateName: '' },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, name: 'invalid' as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, idLength: 31 as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, checksumLength: 31 as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, countEncoding: 'invalid' as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, symbolEncoding: 'invalid' as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, peelOrder: 'invalid' as never } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, multiplier: 0n } } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, multiplier: 2n } } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, indexOffset: 0 } } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, inverseSqrtNumerator: Number.NaN } } },
      { ...PAPER_BASELINE_V0, algorithm: { ...PAPER_BASELINE_V0.algorithm, mapping: { ...PAPER_BASELINE_V0.algorithm.mapping, arithmetic: 'decimal' as never } } },
      { ...PAPER_BASELINE_V0, stream: { ...PAPER_BASELINE_V0.stream, initialWindowSymbols: 0 } },
      { ...PAPER_BASELINE_V0, fallback: { ...PAPER_BASELINE_V0.fallback, maximumOverheadRatio: 1 } },
      {
        ...PAPER_BASELINE_V0,
        fallback: { ...PAPER_BASELINE_V0.fallback, preferEnumerationWhenReceiverCountIsZero: 'yes' as never }
      }
    ];
    for (const configuration of invalidProfiles) expect(() => validateReconciliationConfiguration(configuration)).toThrow();
    expect(() => validateReconciliationLimits({ ...PAPER_BASELINE_V0.limits, maximumSymbols: 0 })).toThrow();
    const failure = new ReconciliationError('ROOT_MISMATCH', 'fixture');
    expect(isReconciliationError(failure)).toBe(true);
    expect(isReconciliationError(failure, 'ROOT_MISMATCH')).toBe(true);
    expect(isReconciliationError(failure, 'COUNT_MISMATCH')).toBe(false);
    expect(isReconciliationError(new Error('fixture'))).toBe(false);
  });
});
