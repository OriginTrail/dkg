/** Typed Hub lookup miss; callers must not infer this state from provider prose. */
export class HubBindingNotFoundError extends Error {
  constructor(
    readonly bindingKind: 'contract' | 'asset-storage',
    readonly bindingName: string,
    readonly hubAddress: string,
    options?: ErrorOptions,
  ) {
    super(`${bindingKind === 'contract' ? 'Contract' : 'Asset storage'} "${bindingName}" not found in Hub at ${hubAddress}`, options);
    this.name = 'HubBindingNotFoundError';
  }
}

/** Historical contract-miss type retained for capability callers. */
export class HubContractNotFoundError extends HubBindingNotFoundError {
  constructor(readonly contractName: string, hubAddress: string, options?: ErrorOptions) {
    super('contract', contractName, hubAddress, options);
    this.name = 'HubContractNotFoundError';
  }
}

export class HubAssetStorageNotFoundError extends HubBindingNotFoundError {
  constructor(readonly assetStorageName: string, hubAddress: string, options?: ErrorOptions) {
    super('asset-storage', assetStorageName, hubAddress, options);
    this.name = 'HubAssetStorageNotFoundError';
  }
}

/**
 * Whether `err` is the Hub's own answer that it names no such contract or asset storage. Only
 * the typed miss counts: a failed RPC call, or any other error, says nothing about the Hub.
 */
export function isHubBindingNotFoundError(err: unknown): err is HubBindingNotFoundError {
  return err instanceof HubBindingNotFoundError;
}
