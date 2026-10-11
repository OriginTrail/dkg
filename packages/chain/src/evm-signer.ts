// SPDX-License-Identifier: Apache-2.0

/**
 * The signer contract the EVM adapter needs from an operational wallet: an
 * ethers v6 `Signer` whose address is known synchronously (it keys the
 * per-wallet nonce lane and the signer pool) and whose `connect()` rebinds it
 * to one RPC endpoint per attempt. `ethers.Wallet` satisfies it, and so does
 * `RemoteSigner`, which delegates signing to an external signer.
 */
import { Wallet, type ethers } from 'ethers';

export interface EvmSigner extends ethers.Signer {
  /** Checksummed address, available without a round trip. */
  readonly address: string;
  connect(provider: ethers.Provider | null): EvmSigner;
}

/**
 * A signer whose key is held outside this process (a remote signing service,
 * an HSM, ...). The adapter keeps the RPC population of such a transaction
 * (nonce, gas, fees) under its per-endpoint deadline but never puts the
 * signing request itself under that deadline and never fails it over to
 * another endpoint: a signer failure is not an endpoint failure, and one
 * prepared transaction is signed at most once.
 */
export interface ExternalEvmSigner extends EvmSigner {
  readonly isExternalSigner: true;
}

/**
 * Author keys held outside the node. The author of a published knowledge
 * asset is its owner, and can be a different key than the operational wallets
 * paying for transactions: these keys only ever sign author attestations
 * (EIP-712 typed data) and never pay for a transaction.
 */
export interface ExternalAuthorSigners {
  /** Author for requests that name no agent, if one is configured. */
  readonly defaultAuthor?: EvmSigner;
  /** The signer for `address` when it is one of these author keys; otherwise undefined. */
  signerFor(address: string): Promise<EvmSigner | undefined>;
}

export function isExternalEvmSigner(signer: unknown): signer is ExternalEvmSigner {
  return typeof signer === 'object' && signer !== null
    && (signer as { isExternalSigner?: unknown }).isExternalSigner === true;
}

/** Thrown where a raw operational private key is requested but signing is external. */
export class OperationalKeyUnavailableError extends Error {
  readonly code = 'OPERATIONAL_KEY_UNAVAILABLE';

  constructor(
    message = 'No operational private key is available: EVM signing is delegated to an external signer.',
  ) {
    super(message);
    this.name = 'OperationalKeyUnavailableError';
  }
}

/** The private key of a local wallet signer, or undefined for an external one. */
export function localPrivateKeyOf(signer: EvmSigner): string | undefined {
  if (isExternalEvmSigner(signer)) return undefined;
  const privateKey = (signer as { privateKey?: unknown }).privateKey;
  return typeof privateKey === 'string' && privateKey.length > 0 ? privateKey : undefined;
}

/** The private key of a local wallet signer; throws for an external signer. */
export function operationalPrivateKeyOf(signer: EvmSigner): string {
  const privateKey = localPrivateKeyOf(signer);
  if (privateKey === undefined) throw new OperationalKeyUnavailableError();
  return privateKey;
}

export interface OperationalSignerSource {
  /** Primary operational key; mutually exclusive with `signers`. */
  privateKey?: string;
  /** Additional operational keys; only together with `privateKey`. */
  additionalKeys?: readonly string[];
  /** Operational signers that hold their keys elsewhere; the first is the primary. */
  signers?: readonly EvmSigner[];
}

/**
 * Build the adapter's operational signer pool from local keys or external
 * signers, each bound to `provider`. Exactly one source must be configured.
 */
export function createOperationalSignerPool(
  source: OperationalSignerSource,
  provider: ethers.Provider,
): EvmSigner[] {
  const external = source.signers ?? [];
  if (external.length === 0) {
    if (!source.privateKey) {
      throw new Error('EVMChainAdapter requires an operational privateKey or at least one signer');
    }
    return [source.privateKey, ...(source.additionalKeys ?? [])]
      .map((key) => new Wallet(key, provider));
  }
  if (source.privateKey || (source.additionalKeys?.length ?? 0) > 0) {
    throw new Error('EVMChainAdapter accepts either privateKey/additionalKeys or signers, not both');
  }
  const seen = new Set<string>();
  return external.map((signer) => {
    const key = signer.address.toLowerCase();
    if (seen.has(key)) throw new Error(`EVMChainAdapter signers contain ${signer.address} more than once`);
    seen.add(key);
    return signer.connect(provider);
  });
}
