import { describe, expect, it } from 'vitest';
import { formatEth, formatEthTooltip } from '../src/ui/lib/formatEth.js';

describe('formatEth', () => {
  it('returns em-dash for null/undefined/empty (BUG-006: never crash on missing balance)', () => {
    expect(formatEth(null)).toBe('—');
    expect(formatEth(undefined)).toBe('—');
    expect(formatEth('')).toBe('—');
  });

  it('returns em-dash for non-numeric input (regression guard against silent NaN render)', () => {
    expect(formatEth('not-a-number')).toBe('—');
    expect(formatEth({} as unknown)).toBe('—');
    expect(formatEth(NaN)).toBe('—');
    expect(formatEth(Infinity)).toBe('—');
    expect(formatEth(-Infinity)).toBe('—');
  });

  it('renders zero as "0" exactly (avoids "0.000000" and "<" prefix on a real zero)', () => {
    expect(formatEth(0)).toBe('0');
    expect(formatEth('0')).toBe('0');
    expect(formatEth('0.000000000000000000')).toBe('0');
  });

  it('truncates the 17-digit dump from the daemon (BUG-006 reproducer)', () => {
    expect(formatEth('0.040583524997839496')).toBe('0.040584');
    expect(formatEth('0.000000000000000001')).toBe('< 0.000001');
    expect(formatEth('1.234567890123456789')).toBe('1.234568');
  });

  it('respects custom precision and trims trailing zeros', () => {
    expect(formatEth('0.04', 2)).toBe('0.04');
    expect(formatEth('0.040000', 4)).toBe('0.04');
    expect(formatEth('0.04', 6)).toBe('0.04');
  });

  it('keeps integer-only balances readable (no spurious decimal)', () => {
    expect(formatEth('1')).toBe('1');
    expect(formatEth(2)).toBe('2');
    expect(formatEth('1234567')).toBe('1234567');
  });

  it('uses < threshold hint for sub-precision values so the user doesn\'t mistake them for zero', () => {
    expect(formatEth('0.0000001')).toBe('< 0.000001');
    expect(formatEth('0.000001', 6)).toBe('0.000001');
    expect(formatEth('0.0000005', 6)).toBe('< 0.000001');
  });

  it('handles negative balances literally (chain rarely produces these but we shouldn\'t lie)', () => {
    expect(formatEth('-0.5')).toBe('-0.5');
    expect(formatEth(-1)).toBe('-1');
  });
});

describe('formatEthTooltip', () => {
  it('returns undefined for missing values so the title attribute is omitted', () => {
    expect(formatEthTooltip(null)).toBeUndefined();
    expect(formatEthTooltip('')).toBeUndefined();
  });

  it('preserves the raw daemon value verbatim so users can copy full precision', () => {
    expect(formatEthTooltip('0.040583524997839496'))
      .toBe('Exact balance: 0.040583524997839496 (full precision from chain)');
  });
});
