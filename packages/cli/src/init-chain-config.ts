import type { ChainConfig } from './config.js';

/** Network defaults remain inherited so future network RPC/hub rotations can propagate. */
export function buildInitChainOverrides(
  answers: Pick<ChainConfig, 'rpcUrl' | 'rpcUrls' | 'hubAddress' | 'chainId'>,
  networkDefaults: Partial<ChainConfig> | undefined,
  existing: Partial<ChainConfig> | undefined,
): Partial<ChainConfig> | undefined {
  const overrides: Partial<ChainConfig> = { ...existing };
  for (const key of ['rpcUrl', 'rpcUrls', 'hubAddress', 'chainId'] as const) {
    const value = answers[key];
    const sameAsDefault = key === 'rpcUrls'
      ? JSON.stringify(value ?? []) === JSON.stringify(networkDefaults?.[key] ?? [])
      : value === networkDefaults?.[key] || (!value && !networkDefaults?.[key]);
    if (sameAsDefault || value === undefined || value === '') delete overrides[key];
    else Object.assign(overrides, { [key]: value });
  }
  if (overrides.type === 'evm') delete overrides.type;
  return Object.keys(overrides).length > 0 ? { type: 'evm', ...overrides } : undefined;
}
