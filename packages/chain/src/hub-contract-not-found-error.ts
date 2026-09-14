/** Typed Hub lookup miss; callers must not infer this state from provider prose. */
export class HubContractNotFoundError extends Error {
  constructor(
    readonly contractName: string,
    readonly hubAddress: string,
    options?: ErrorOptions,
  ) {
    super(`Contract "${contractName}" not found in Hub at ${hubAddress}`, options);
    this.name = 'HubContractNotFoundError';
  }
}
