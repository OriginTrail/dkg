import { describe, expect, it } from 'vitest';
import {
  I64_MAX,
  I64_MIN,
  PAPER_BASELINE_V0,
  CodingWindow,
  RatelessIbltEncoder,
  applyId,
  cloneSymbol,
  detectPureSymbol,
  emptySymbol,
  idChecksum,
  isZeroSymbol,
  subtractSymbols,
  validateSymbol
} from '../src/index.js';
import { deterministicId } from '../scripts/fixtures.js';

const seed = deterministicId('seed');
const id = deterministicId('symbol-id');

describe('reconciliation symbols', () => {
  it('applies and cancels signed IDs with checksum validation', () => {
    const checksum = idChecksum(seed, id);
    const symbol = emptySymbol(0);
    applyId(symbol, id, checksum, 1n);
    expect(detectPureSymbol(symbol, seed)).toMatchObject({ direction: 'provider-only' });
    applyId(symbol, id, checksum, -1n);
    expect(isZeroSymbol(symbol)).toBe(true);
    applyId(symbol, id, checksum, -1n);
    expect(detectPureSymbol(symbol, seed)).toMatchObject({ direction: 'receiver-only' });
    symbol.checksumXor[0] ^= 1;
    expect(detectPureSymbol(symbol, seed)).toBeNull();
    symbol.count = 2n;
    expect(detectPureSymbol(symbol, seed)).toBeNull();
  });

  it('subtracts matching symbol indices and does not alias inputs', () => {
    const checksum = idChecksum(seed, id);
    const provider = emptySymbol(7);
    const receiver = emptySymbol(7);
    applyId(provider, id, checksum, 1n);
    applyId(receiver, id, checksum, 1n);
    const residual = subtractSymbols(provider, receiver);
    expect(isZeroSymbol(residual)).toBe(true);
    residual.idXor[0] = 9;
    expect(provider.idXor[0]).not.toBe(9);
    expect(() => subtractSymbols(provider, emptySymbol(8))).toThrow('indices');
  });

  it('rejects malformed and overflowing symbols', () => {
    expect(() => emptySymbol(-1)).toThrow('symbolIndex');
    expect(() => validateSymbol({ ...emptySymbol(0), symbolIndex: 1.5 })).toThrow('symbolIndex');
    expect(() => validateSymbol({ ...emptySymbol(0), count: I64_MAX + 1n })).toThrow('signed 64-bit');
    expect(() => validateSymbol({ ...emptySymbol(0), count: 0 as never })).toThrow('signed 64-bit');
    expect(() => validateSymbol({ ...emptySymbol(0), idXor: new Uint8Array(31) })).toThrow('idXor');
    expect(() => validateSymbol({ ...emptySymbol(0), checksumXor: new Uint8Array(31) })).toThrow('checksumXor');
    expect(() => applyId({ ...emptySymbol(0), count: I64_MAX }, id, idChecksum(seed, id), 1n)).toThrow('overflow');
    expect(() => applyId({ ...emptySymbol(0), count: I64_MIN }, id, idChecksum(seed, id), -1n)).toThrow('overflow');
    expect(() => applyId(emptySymbol(0), new Uint8Array(31), idChecksum(seed, id), 1n)).toThrow();
    expect(() => applyId(emptySymbol(0), id, new Uint8Array(31), 1n)).toThrow();
    expect(() => subtractSymbols({ ...emptySymbol(0), count: I64_MAX }, { ...emptySymbol(0), count: -1n })).toThrow('overflow');
    const clone = cloneSymbol(emptySymbol(0));
    expect(isZeroSymbol(clone)).toBe(true);
    clone.idXor[0] = 1;
    expect(isZeroSymbol(clone)).toBe(false);
  });
});

describe('rateless encoder', () => {
  it('is insertion-order independent and emits contiguous windows', () => {
    const ids = [deterministicId('a'), deterministicId('b'), deterministicId('c')];
    const first = new RatelessIbltEncoder(ids, seed, PAPER_BASELINE_V0.mapping);
    const second = new RatelessIbltEncoder([...ids].reverse(), seed, PAPER_BASELINE_V0.mapping);
    expect(first.produceWindow(20)).toEqual(second.produceWindow(20));
    expect(first.nextSymbolIndex).toBe(20);
    expect(() => first.produceWindow(0)).toThrow('positive safe integer');
  });

  it('rejects duplicate IDs', () => {
    expect(() => new RatelessIbltEncoder([id, id], seed, PAPER_BASELINE_V0.mapping)).toThrow('duplicate');
  });

  it('exposes window size and rejects an out-of-order local application', () => {
    const window = new CodingWindow(seed, PAPER_BASELINE_V0.mapping);
    expect(window.size).toBe(0);
    window.addId(id);
    expect(window.size).toBe(1);
    expect(() => window.applyNext(emptySymbol(1), 1n)).toThrow('expected symbol 0');
  });
});
