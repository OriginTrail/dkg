import { describe, it, expect } from 'vitest';
import { chainByChainId, chainLabel } from '../src/ui/wallet/chains.js';

describe('wallet chains map', () => {
  it('resolves the known DKG chains by numeric id', () => {
    expect(chainByChainId(8453)?.name).toBe('Base');
    expect(chainByChainId(100)?.name).toBe('Gnosis');
    expect(chainByChainId(84532)?.id).toBe(84532);
    expect(chainByChainId(31337)?.id).toBe(31337); // hardhat / local devnet
    expect(chainByChainId(2043)?.name).toBe('NeuroWeb');
  });

  it('returns undefined for an unknown chain id', () => {
    expect(chainByChainId(999999)).toBeUndefined();
  });

  it('chainLabel falls back to "Chain <id>" for unknown, "—" for null', () => {
    expect(chainLabel(8453)).toBe('Base');
    expect(chainLabel(999999)).toBe('Chain 999999');
    expect(chainLabel(null)).toBe('—');
  });
});
