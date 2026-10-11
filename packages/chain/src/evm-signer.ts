// SPDX-License-Identifier: Apache-2.0

/**
 * The signer contract the EVM adapter needs from an operational wallet: an
 * ethers v6 `Signer` whose address is known synchronously (it keys the
 * per-wallet nonce lane and the signer pool) and whose `connect()` rebinds it
 * to one RPC endpoint per attempt. `ethers.Wallet` satisfies it, and so does
 * `RemoteSigner`, which delegates signing to an external signer.
 */
import { Transaction, Wallet, type ethers } from 'ethers';
import { RemoteSignerError, isRemoteSignerError } from './remote-signer-errors.js';

export interface EvmSigner extends ethers.Signer {
  /** Checksummed address, available without a round trip. */
  readonly address: string;
  connect(provider: ethers.Provider | null): EvmSigner;
}

/**
 * A signer whose key is held outside this process (a remote signing service,
 * an HSM, ...). As for every signer, the adapter bounds the RPC population of
 * a transaction (nonce, gas, fees) by its per-endpoint deadline and never puts
 * the signing request under that deadline. A failure of such a signer is never
 * failed over to another endpoint either: it is not an endpoint failure, and
 * one prepared transaction is signed at most once.
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
  /** The author accounts known so far, in the signer's order. */
  readonly addresses: readonly string[];
  /** The signer for `address` when it is one of these author keys; otherwise undefined. */
  signerFor(address: string): Promise<EvmSigner | undefined>;
  /**
   * The first of `addresses`, in order, that is one of these author keys, with
   * its signer: one selection over one view of the author accounts, however
   * many of the addresses are not author keys.
   */
  firstSignerOf(addresses: readonly string[]): Promise<{ address: string; signer: EvmSigner } | undefined>;
}

export function isExternalEvmSigner(signer: unknown): signer is ExternalEvmSigner {
  return typeof signer === 'object' && signer !== null
    && (signer as { isExternalSigner?: unknown }).isExternalSigner === true;
}

/**
 * Sign a fully populated transaction once and decode the signed bytes. A
 * failure of an external signer is final, whatever it looks like (a reset
 * connection is not an RPC endpoint failure, and neither are bytes that do not
 * decode): one that is not already a signer error is wrapped in one, so no
 * endpoint failover or retry loop asks the signer for a second signature.
 */
export async function signTransactionOnce(
  signer: EvmSigner,
  tx: ethers.TransactionRequest,
): Promise<{ signedTx: string; parsed: Transaction }> {
  try {
    const signedTx = await signer.signTransaction(tx);
    return { signedTx, parsed: Transaction.from(signedTx) };
  } catch (err) {
    if (!isExternalEvmSigner(signer) || isRemoteSignerError(err)) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new RemoteSignerError('REMOTE_SIGNER_FAILED', `External signer for ${signer.address} failed to sign: ${reason}`, { cause: err });
  }
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

/** Operational wallets whose keys this process holds. */
export interface LocalOperationalSignerSource {
  /** Primary operational wallet key (identity registration, staking, ...). */
  privateKey: string;
  /** Additional operational wallet keys for parallel transaction submission. */
  additionalKeys?: readonly string[];
  signers?: never;
}

/**
 * Operational signers whose keys are held outside this process, for example
 * `RemoteSigner`s backed by an external signing service. The first is the
 * primary and all of them are used for parallel transaction submission;
 * raw-key accessors such as `getOperationalPrivateKey()` then throw
 * `OperationalKeyUnavailableError`.
 */
export interface ExternalOperationalSignerSource {
  signers: readonly EvmSigner[];
  privateKey?: never;
  additionalKeys?: never;
}

/** Where an adapter's operational wallets come from: local keys or external signers, never both. */
export type OperationalSignerSource = LocalOperationalSignerSource | ExternalOperationalSignerSource;

/**
 * Build the adapter's operational signer pool from local keys or external
 * signers, each bound to `provider`. Exactly one source must be configured;
 * that is checked here too, for callers the types do not reach.
 */
export function createOperationalSignerPool(
  source: OperationalSignerSource,
  provider: ethers.Provider,
): EvmSigner[] {
  const { privateKey, additionalKeys, signers } = source as {
    privateKey?: string;
    additionalKeys?: readonly string[];
    signers?: readonly EvmSigner[];
  };
  const external = signers ?? [];
  if (external.length === 0) {
    if (!privateKey) {
      throw new Error('EVMChainAdapter requires an operational privateKey or at least one signer');
    }
    return [privateKey, ...(additionalKeys ?? [])]
      .map((key) => new Wallet(key, provider));
  }
  if (privateKey || (additionalKeys?.length ?? 0) > 0) {
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
