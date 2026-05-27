import { describe, expect, it } from 'vitest';
import { formatTracSymbol } from '../src/ui/lib/formatTrac.js';

describe('formatTracSymbol (BUG-013)', () => {
  it('returns "TRAC" for empty/null/undefined symbol', () => {
    expect(formatTracSymbol('', '8453')).toBe('TRAC');
    expect(formatTracSymbol(null, '8453')).toBe('TRAC');
    expect(formatTracSymbol(undefined, '8453')).toBe('TRAC');
  });

  it('appends "(testnet)" qualifier on testnet chain ids when symbol does not already say so', () => {
    expect(formatTracSymbol('v9TRAC', '84532')).toBe('v9TRAC (testnet)');
    expect(formatTracSymbol('TRAC', '11155111')).toBe('TRAC (testnet)');
    expect(formatTracSymbol('xTRAC', '31337')).toBe('xTRAC (testnet)');
  });

  it('does NOT double-qualify when the symbol already announces test status', () => {
    expect(formatTracSymbol('test-TRAC', '84532')).toBe('test-TRAC');
    expect(formatTracSymbol('TestTRAC', '84532')).toBe('TestTRAC');
  });

  it('returns the raw symbol for production chain ids', () => {
    expect(formatTracSymbol('TRAC', '8453')).toBe('TRAC');
    expect(formatTracSymbol('TRAC', '1')).toBe('TRAC');
    expect(formatTracSymbol('TRAC', '100')).toBe('TRAC');
  });

  it('handles compound chain ids ("base:84532")', () => {
    expect(formatTracSymbol('v9TRAC', 'base:84532')).toBe('v9TRAC (testnet)');
    expect(formatTracSymbol('TRAC', 'eth:1')).toBe('TRAC');
  });
});
