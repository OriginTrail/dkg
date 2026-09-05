import type { ChainConfig } from './config.js';

function isScalarOverride(value: string | undefined, networkDefault: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== networkDefault;
}

/** Network defaults remain inherited so future network RPC/hub rotations can propagate. */
export function buildInitChainOverrides(
  answers: Pick<ChainConfig, 'rpcUrl' | 'rpcUrls' | 'hubAddress' | 'chainId'>,
  networkDefaults: Partial<ChainConfig> | undefined,
  existing: Partial<ChainConfig> | undefined,
): Partial<ChainConfig> | undefined {
  // Mock mode deliberately has no RPC/Hub defaults. Keeping both prompts empty
  // continues that mode; entering an EVM endpoint or Hub replaces it.
  if (existing?.type === 'mock' && !answers.rpcUrl && !answers.hubAddress) {
    return {
      type: 'mock',
      ...(answers.chainId ? { chainId: answers.chainId } : {}),
      ...(existing.mockIdentityId !== undefined ? { mockIdentityId: existing.mockIdentityId } : {}),
    };
  }
  const { type: _type, mockIdentityId: _mockIdentityId, rpcUrl: _rpcUrl, rpcUrls: _rpcUrls, hubAddress: _hubAddress, chainId: _chainId, ...advanced } = existing ?? {};
  const defaultBackups = networkDefaults?.rpcUrls ?? [];
  const backups = answers.rpcUrls;
  // Undefined inherits; [] explicitly removes network backups. Order is significant.
  const hasBackupOverride = backups !== undefined && (
    backups.length !== defaultBackups.length || backups.some((url, index) => url !== defaultBackups[index])
  );
  const overrides: Partial<ChainConfig> = {
    ...advanced,
    ...(isScalarOverride(answers.rpcUrl, networkDefaults?.rpcUrl) ? { rpcUrl: answers.rpcUrl } : {}),
    ...(hasBackupOverride ? { rpcUrls: backups } : {}),
    ...(isScalarOverride(answers.hubAddress, networkDefaults?.hubAddress) ? { hubAddress: answers.hubAddress } : {}),
    ...(isScalarOverride(answers.chainId, networkDefaults?.chainId) ? { chainId: answers.chainId } : {}),
  };
  return Object.keys(overrides).length > 0 ? { type: 'evm', ...overrides } : undefined;
}
