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
