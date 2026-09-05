import type { ChainConfig } from './config.js';

type ChainFieldOwner = 'wizard' | 'mock' | 'network' | 'operator';

// New ChainConfig fields must choose a persistence policy. Addresses, monetary
// limits, approval and finality choices belong to a network. Read sizing and
// receipt deadlines are portable operator preferences.
const CHAIN_FIELD_OWNER = {
  type: 'wizard', rpcUrl: 'wizard', rpcUrls: 'wizard', hubAddress: 'wizard', chainId: 'wizard',
  mockIdentityId: 'mock',
  walletRpcUrls: 'network', tokenAddress: 'network', approvalPolicy: 'network',
  minPublisherNativeWei: 'network', minPublisherTracWei: 'network',
  finalityConfirmations: 'network', maxFeePerGasWei: 'network',
  cgRegistryScanPageSize: 'operator', receiptTimeoutMs: 'operator',
} as const satisfies Record<keyof ChainConfig, ChainFieldOwner>;

function copyField<K extends keyof ChainConfig>(target: Partial<ChainConfig>, source: Partial<ChainConfig>, key: K): void {
  if (source[key] !== undefined) target[key] = source[key];
}

function isScalarOverride(value: string | undefined, networkDefault: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== networkDefault;
}

/** Network defaults remain inherited so future network RPC/hub rotations can propagate. */
export function buildInitChainOverrides(
  answers: Pick<ChainConfig, 'rpcUrl' | 'hubAddress' | 'chainId'> & { rpcUrlsInput: string },
  networkDefaults: Partial<ChainConfig> | undefined,
  existing: Partial<ChainConfig> | undefined,
  context: { isNetworkSwitch: boolean },
): Partial<ChainConfig> | undefined {
  const sameNetworkExisting = context.isNetworkSwitch ? undefined : existing;
  // Mock mode deliberately has no RPC/Hub defaults. Keeping both prompts empty
  // continues that mode; entering an EVM endpoint or Hub replaces it.
  if (sameNetworkExisting?.type === 'mock' && !answers.rpcUrl && !answers.hubAddress) {
    return {
      type: 'mock',
      ...(answers.chainId ? { chainId: answers.chainId } : {}),
      ...(sameNetworkExisting.mockIdentityId !== undefined ? { mockIdentityId: sameNetworkExisting.mockIdentityId } : {}),
    };
  }
  const preserved: Partial<ChainConfig> = {};
  if (existing) {
    for (const key of Object.keys(CHAIN_FIELD_OWNER) as Array<keyof ChainConfig>) {
      const owner = CHAIN_FIELD_OWNER[key];
      if (owner === 'operator' || (owner === 'network' && !context.isNetworkSwitch)) {
        copyField(preserved, existing, key);
      }
    }
  }
  const defaultBackups = networkDefaults?.rpcUrls ?? [];
  const backupInput = answers.rpcUrlsInput.trim();
  const parsedBackups = backupInput.split(',').map((url) => url.trim()).filter(Boolean);
  const explicitlyCleared = backupInput.toLowerCase() === 'none';
  // A blank prompt can mean backups were suppressed by an off-overlay primary.
  // Only "none" or an existing explicit [] carries removal intent.
  const retainEmptyOverride = !backupInput && sameNetworkExisting?.type !== 'mock'
    && sameNetworkExisting?.rpcUrls?.length === 0;
  const backups = explicitlyCleared || retainEmptyOverride ? [] : parsedBackups;
  const hasBackupOverride = explicitlyCleared || retainEmptyOverride || (backups.length > 0 && (
    backups.length !== defaultBackups.length || backups.some((url, index) => url !== defaultBackups[index])
  ));
  const overrides: Partial<ChainConfig> = {
    ...preserved,
    ...(isScalarOverride(answers.rpcUrl, networkDefaults?.rpcUrl) ? { rpcUrl: answers.rpcUrl } : {}),
    ...(hasBackupOverride ? { rpcUrls: backups } : {}),
    ...(isScalarOverride(answers.hubAddress, networkDefaults?.hubAddress) ? { hubAddress: answers.hubAddress } : {}),
    ...(isScalarOverride(answers.chainId, networkDefaults?.chainId) ? { chainId: answers.chainId } : {}),
  };
  return Object.keys(overrides).length > 0 ? { type: 'evm', ...overrides } : undefined;
}
