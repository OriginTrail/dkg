// SPDX-License-Identifier: Apache-2.0

/**
 * Keyed owner-signed unregistered authority seed access (RFC-64 replica
 * bootstrap). A wallet-namespaced, unregistered public Context Graph has no
 * finalized chain record; its replica read authority is an owner-signed
 * canonical policy envelope. These methods give every consumer (the author at
 * create, the replica reconcile path, and peer transports) one point-lookup
 * store keyed by (networkId, contextGraphId) instead of the deprecated ontology
 * system-graph scan. Nothing here grants authority: `persist` re-authenticates
 * before writing, `read` returns opaque bytes the consumer must authenticate,
 * and acceptance still flows through `reconcileRfc64CatalogAccessAuthorityV1`.
 */

import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  createOperationContext,
  type ContextGraphIdV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  Rfc64UnregisteredAuthoritySeedErrorV1,
  resolveRfc64WalletNamespaceOwnerV1,
} from './rfc64/unregistered-authority-seed-store-v1.js';
import {
  authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1,
  type Rfc64UnregisteredReplicaAuthoritySeedAccessV1,
} from './rfc64/unregistered-replica-authority-v1.js';

export interface PersistVerifiedRfc64UnregisteredAuthoritySeedInputV1 {
  readonly networkId: string;
  readonly contextGraphId: string;
  /** Exact canonical signed Context Graph policy envelope bytes. */
  readonly canonicalEnvelopeBytes: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface ReadRfc64UnregisteredAuthoritySeedInputV1 {
  readonly networkId: string;
  readonly contextGraphId: string;
  readonly signal?: AbortSignal;
}

function snapshotRfc64SeedKeyV1(input: Readonly<{
  readonly networkId: string;
  readonly contextGraphId: string;
}>): Readonly<{ networkId: NetworkIdV1; contextGraphId: ContextGraphIdV1 }> {
  const { networkId, contextGraphId } = input;
  assertNetworkIdV1(networkId, 'unregistered authority seed networkId');
  assertContextGraphIdV1(contextGraphId, 'unregistered authority seed contextGraphId');
  return Object.freeze({ networkId, contextGraphId });
}

/**
 * Scopes whose keyed read already failed once on this agent. The first failure
 * is a warning; repeats stay at debug so a wedged inventory cannot flood the
 * log from every reconcile of every graph.
 */
const rfc64SeedReadFailureWarnedV1 = new WeakMap<DKGAgent, Set<string>>();

export class Rfc64SeedStoreMethods extends DKGAgentBase {
  /**
   * Re-authenticate and durably store one owner-signed seed for its exact
   * (network, graph) key. Idempotent for identical bytes; fail-closed (throws)
   * on any verification failure, on a differing stored generation, and when
   * this agent has no RFC-64 persistence (no `dataDir`).
   */
  async persistVerifiedRfc64UnregisteredAuthoritySeedV1(
    this: DKGAgent,
    input: PersistVerifiedRfc64UnregisteredAuthoritySeedInputV1,
  ): Promise<void> {
    input.signal?.throwIfAborted();
    const key = snapshotRfc64SeedKeyV1(input);
    // Verification happens before any store access: issuer signature, issuer
    // equal to the wallet-namespace owner, network/graph binding, policy shape.
    const authenticated = await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(
      input.canonicalEnvelopeBytes,
      { ...key, signal: input.signal },
    );
    const seeds = this.rfc64PersistenceV1?.unregisteredAuthoritySeeds;
    if (seeds === undefined) {
      throw new Rfc64UnregisteredAuthoritySeedErrorV1(
        'seed-store-unavailable',
        'RFC-64 persistence is unavailable; the unregistered authority seed was not stored',
      );
    }
    input.signal?.throwIfAborted();
    await seeds.put({
      networkId: key.networkId,
      contextGraphId: key.contextGraphId,
      ownerAddress: authenticated.ownerAddress,
      policyDigest: authenticated.policyDigest,
      signedEnvelope: authenticated.canonicalEnvelopeBytes,
    });
  }

  /**
   * Point lookup of the stored canonical envelope bytes; `null` when absent,
   * when the graph is not wallet-namespaced, or when this agent has no RFC-64
   * persistence. Never scans the ontology graph. The bytes are opaque here:
   * consumers authenticate them before use.
   */
  async readRfc64UnregisteredAuthoritySeedV1(
    this: DKGAgent,
    input: ReadRfc64UnregisteredAuthoritySeedInputV1,
  ): Promise<Uint8Array | null> {
    input.signal?.throwIfAborted();
    const key = snapshotRfc64SeedKeyV1(input);
    // Only wallet-namespaced graphs can hold an owner-signed seed; other names
    // never touch the store, so a signature cannot self-assign them.
    if (resolveRfc64WalletNamespaceOwnerV1(key.contextGraphId) === null) return null;
    const seeds = this.rfc64PersistenceV1?.unregisteredAuthoritySeeds;
    if (seeds === undefined) return null;
    const record = await seeds.read(key.networkId, key.contextGraphId);
    return record === null ? null : Uint8Array.from(record.signedEnvelope);
  }

  /**
   * Loader adapter for `loadRfc64UnregisteredReplicaAuthorityV1`: contained
   * store-first read plus a contained write-through. Both only accelerate the
   * replica path (the deprecated ontology copy still authenticates on its
   * own), so a closed, stalled or corrupt inventory must never turn an
   * authenticatable authority into a reconcile failure: a failing read
   * reports absence (warned once per graph) and a failing write-through is
   * logged. Only the caller's own abort propagates.
   */
  rfc64UnregisteredAuthoritySeedAccessV1(
    this: DKGAgent,
  ): Rfc64UnregisteredReplicaAuthoritySeedAccessV1 {
    type SeedAccess = Rfc64UnregisteredReplicaAuthoritySeedAccessV1;
    return Object.freeze({
      read: async (input: Parameters<SeedAccess['read']>[0]) => {
        try {
          return await this.readRfc64UnregisteredAuthoritySeedV1(input);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          const key = `${input.networkId}\u0000${input.contextGraphId}`;
          let warned = rfc64SeedReadFailureWarnedV1.get(this);
          if (warned === undefined) {
            warned = new Set();
            rfc64SeedReadFailureWarnedV1.set(this, warned);
          }
          const message =
            `RFC-64 unregistered authority seed read for "${input.contextGraphId}" failed; ` +
            'falling back to the deprecated ontology copy: ' +
            (error instanceof Error ? error.message : String(error));
          if (warned.has(key)) {
            this.log.debug(createOperationContext('system'), message);
          } else {
            warned.add(key);
            this.log.warn(createOperationContext('system'), message);
          }
          return null;
        }
      },
      persist: async (input: Parameters<SeedAccess['persist']>[0]) => {
        if (this.rfc64PersistenceV1 === undefined) return;
        try {
          await this.persistVerifiedRfc64UnregisteredAuthoritySeedV1(input);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          this.log.warn(
            createOperationContext('system'),
            `RFC-64 unregistered authority seed write-through for "${input.contextGraphId}" failed: ` +
            (error instanceof Error ? error.message : String(error)),
          );
        }
      },
    });
  }
}
