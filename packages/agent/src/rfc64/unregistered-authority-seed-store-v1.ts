// SPDX-License-Identifier: Apache-2.0

/**
 * CG-scoped keyed store for owner-signed unregistered authority seeds.
 *
 * A wallet-namespaced, unregistered public Context Graph has no finalized chain
 * record; its replica read authority is an owner-signed canonical policy
 * envelope ("seed"). Historically the seed travelled only as a literal inside
 * the ontology system graph, which is deprecated as a carrier and expensive to
 * scan. This store keeps the exact canonical envelope bytes keyed by
 * (networkId, contextGraphId) inside the RFC-64 inventory database so the
 * replica read path is a point lookup and peers can be served the bytes.
 *
 * The store is a durability primitive only. Callers MUST authenticate the
 * envelope (issuer == wallet-namespace owner, network/graph binding, policy
 * shape) before writing and again after reading; nothing here grants authority.
 */

import {
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

/** Hard byte bound for one stored seed; a minted seed is ~1.3 KiB. */
export const RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 = 4096;

/**
 * Wallet-namespace grammar: only `0x<wallet>` and `0x<wallet>/<name>` graphs
 * have an independently checkable owner before registration. A signature must
 * never be allowed to self-assign ownership of any other name.
 */
const EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1 = /^(0x[0-9a-f]{40})(?:\/|$)/iu;

/** Lowercase wallet owner of a wallet-namespaced Context Graph, else null. */
export function resolveRfc64WalletNamespaceOwnerV1(
  contextGraphId: string,
): EvmAddressV1 | null {
  const owner = contextGraphId.match(EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1)?.[1];
  return owner === undefined ? null : owner.toLowerCase() as EvmAddressV1;
}

export type Rfc64UnregisteredAuthoritySeedErrorCodeV1 =
  | 'seed-input'
  | 'seed-conflict'
  | 'seed-store-unavailable';

export class Rfc64UnregisteredAuthoritySeedErrorV1 extends Error {
  constructor(
    readonly code: Rfc64UnregisteredAuthoritySeedErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'Rfc64UnregisteredAuthoritySeedErrorV1';
  }
}

export interface Rfc64UnregisteredAuthoritySeedRecordV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  /** Lowercase wallet-namespace owner; must equal the envelope issuer. */
  readonly ownerAddress: EvmAddressV1;
  /** Policy object digest of the stored envelope (its RFC-64 policyDigest). */
  readonly policyDigest: Digest32V1;
  /** Exact canonical signed Context Graph policy envelope bytes. */
  readonly signedEnvelope: Uint8Array;
}

/** The keyed seed table is implemented by the single owned inventory connection. */
export interface Rfc64UnregisteredAuthoritySeedOperationsV1 {
  readUnregisteredAuthoritySeedV1(
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ): Readonly<Rfc64UnregisteredAuthoritySeedRecordV1> | null;
  /**
   * First verified writer wins. Replaying identical bytes is a no-op; a
   * differing policy digest for the same key throws `seed-conflict` and leaves
   * the stored row untouched.
   */
  putUnregisteredAuthoritySeedV1(
    record: Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>,
  ): void;
}

export interface Rfc64UnregisteredAuthoritySeedStoreV1 {
  read(
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ): Promise<Readonly<Rfc64UnregisteredAuthoritySeedRecordV1> | null>;
  put(record: Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>): Promise<void>;
}

/** Inventory error code raised inside the write transaction for a differing stored generation. */
const INVENTORY_SEED_CONFLICT_CODE_V1 = 'unregistered-authority-seed-conflict';

export function createRfc64UnregisteredAuthoritySeedStoreV1(
  operations: Rfc64UnregisteredAuthoritySeedOperationsV1,
): Rfc64UnregisteredAuthoritySeedStoreV1 {
  return Object.freeze({
    read: async (networkId: NetworkIdV1, contextGraphId: ContextGraphIdV1) =>
      operations.readUnregisteredAuthoritySeedV1(networkId, contextGraphId),
    put: async (record: Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>) => {
      try {
        operations.putUnregisteredAuthoritySeedV1(record);
      } catch (cause) {
        // The inventory raises the first-writer-wins fence as its own error
        // class so its write transaction rethrows it verbatim; surface it to
        // store callers under the seed-store error contract.
        if (
          cause instanceof Error
          && 'code' in cause
          && (cause as { code: unknown }).code === INVENTORY_SEED_CONFLICT_CODE_V1
        ) {
          throw new Rfc64UnregisteredAuthoritySeedErrorV1('seed-conflict', cause.message, { cause });
        }
        throw cause;
      }
    },
  });
}

/**
 * Snapshot and validate one seed record at the storage boundary. This checks
 * shape and the wallet-namespace/owner binding only; signature authentication
 * belongs to the caller.
 */
export function snapshotRfc64UnregisteredAuthoritySeedV1(
  input: Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>,
): Readonly<Rfc64UnregisteredAuthoritySeedRecordV1> {
  try {
    assertNetworkIdV1(input.networkId, 'unregistered authority seed networkId');
    assertContextGraphIdV1(input.contextGraphId, 'unregistered authority seed contextGraphId');
    assertCanonicalEvmAddress(input.ownerAddress, 'unregistered authority seed ownerAddress');
    assertCanonicalDigest(input.policyDigest, 'unregistered authority seed policyDigest');
  } catch (cause) {
    throw new Rfc64UnregisteredAuthoritySeedErrorV1(
      'seed-input',
      cause instanceof Error ? cause.message : 'unregistered authority seed is malformed',
      { cause },
    );
  }
  const namespaceOwner = resolveRfc64WalletNamespaceOwnerV1(input.contextGraphId);
  if (namespaceOwner === null) {
    throw new Rfc64UnregisteredAuthoritySeedErrorV1(
      'seed-input',
      'unregistered authority seed requires a wallet-namespaced Context Graph',
    );
  }
  if (namespaceOwner !== input.ownerAddress) {
    throw new Rfc64UnregisteredAuthoritySeedErrorV1(
      'seed-input',
      'unregistered authority seed owner differs from the Context Graph wallet namespace',
    );
  }
  if (
    !(input.signedEnvelope instanceof Uint8Array)
    || input.signedEnvelope.byteLength < 1
    || input.signedEnvelope.byteLength > RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1
  ) {
    throw new Rfc64UnregisteredAuthoritySeedErrorV1(
      'seed-input',
      `unregistered authority seed envelope must be 1..${RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1} bytes`,
    );
  }
  return Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    ownerAddress: input.ownerAddress,
    policyDigest: input.policyDigest,
    signedEnvelope: Uint8Array.from(input.signedEnvelope),
  });
}
