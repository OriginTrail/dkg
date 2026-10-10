// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from '../dkg-agent-rfc64-catalog.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../rfc64/persistence-v1.js';
import { compareRfc64PublicCatalogSuccessorAssetsByKaIdV1 } from
  '../rfc64/public-catalog-successor-asset-v1.js';
import type { Rfc64PublicCatalogIssuerAuthorizationV1 } from
  '../rfc64/public-catalog-successor-producer-v1.js';
import { Rfc64VerifiedCatalogRowsV1 } from './verified-catalog-rows.js';

/**
 * GH#3081 / GH#3072 — what this process has verified about the author catalogs it mutates.
 *
 * Placing one asset read the whole applied catalog twice before producing its successor: once to
 * ask whether the row is already there and once more under the mutation lock. Each read verifies
 * the applied head, loads its history and reads and decodes every row's bundle. The applied head
 * digest names all of that content, so the verified state of one head is kept in memory and served
 * for as long as the durable applied head is still that head; after this path's own applied-head
 * CAS the successor's state takes its place.
 *
 * A kept state is served only when all of these hold:
 *
 * - the applied-head record just read from the inventory is field for field the one it was derived
 *   from, so a head moved by any other writer is read again from the durable store;
 * - the policy accepted for the scope is the one it was read under (a lane is a function of that
 *   policy and the scope, and the delegation is named by the head);
 * - no mutation of the scope has failed since.
 *
 * It never replaces a check: the applied-head CAS on the expected digest stays the authority, and
 * the successor still reads its predecessor from the durable store and verifies it. Memory is
 * bounded by a number of scopes and a number of retained bytes, and nothing is persisted.
 */

export interface Rfc64CatalogMutationStateV1 {
  readonly current: AppliedCatalogHeadSnapshotV1 | null;
  readonly previousHead: Rfc64StagedAuthorCatalogHeadRefV1;
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  /** In mathematical KA order, as the signed bucket lists them. */
  readonly assets: readonly Rfc64CatalogSuccessorAssetInputV1[];
  readonly expectedCurrentCatalogHeadDigest: Digest32V1 | null;
}

export interface Rfc64CatalogMutationMemoryLimitsV1 {
  /** Author catalog scopes remembered at once; zero remembers nothing. */
  readonly maxScopes: number;
  /** Projection bytes and per-row overhead retained over all scopes. */
  readonly maxRetainedBytes: number;
}

/**
 * What one row costs to keep beside its projection bytes: its seal in the state, and its verified
 * outcome with the seal's typed rows. Measured at about 14 KiB a row together.
 */
export const RETAINED_STATE_ROW_BYTES_V1 = 4 * 1024;
export const RETAINED_VERIFIED_ROW_BYTES_V1 = 12 * 1024;

/** One exact set is at most 64 MiB of bundles and 1,024 rows, so one full catalog always fits. */
export const DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1: Rfc64CatalogMutationMemoryLimitsV1 =
  Object.freeze({ maxScopes: 16, maxRetainedBytes: 96 * 1024 * 1024 });

/** `DKG_RFC64_CATALOG_MUTATION_MEMORY=0` makes every placement read and verify the durable catalog. */
export function resolveCatalogMutationMemoryLimitsV1(
  raw: string | undefined,
): Rfc64CatalogMutationMemoryLimitsV1 {
  return raw?.trim() === '0'
    ? Object.freeze({ maxScopes: 0, maxRetainedBytes: 0 })
    : DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1;
}

interface RememberedScopeV1 {
  state: Rfc64CatalogMutationStateV1 | undefined;
  authority: string | undefined;
  stateBytes: number;
  readonly verifiedRows: Rfc64VerifiedCatalogRowsV1;
}

function forgottenScopeV1(): RememberedScopeV1 {
  return {
    state: undefined,
    authority: undefined,
    stateBytes: 0,
    verifiedRows: new Rfc64VerifiedCatalogRowsV1(),
  };
}

function scopeBytesV1(scope: RememberedScopeV1): number {
  return scope.stateBytes + scope.verifiedRows.size * RETAINED_VERIFIED_ROW_BYTES_V1;
}

/** Where a state this memory handed out belongs, so only such a state can be carried forward. */
interface StateOriginV1 {
  readonly key: string;
  readonly authority: string;
}

function scopeKeyV1(catalogScopeDigest: Digest32V1, authorAddress: string): string {
  return `${catalogScopeDigest}\n${authorAddress}`;
}

function sameAppliedHeadV1(
  left: AppliedCatalogHeadSnapshotV1 | null,
  right: AppliedCatalogHeadSnapshotV1,
): boolean {
  return left !== null
    && left.catalogScopeDigest === right.catalogScopeDigest
    && left.authorAddress === right.authorAddress
    && left.currentCatalogHeadDigest === right.currentCatalogHeadDigest
    && left.appliedInventoryDigest === right.appliedInventoryDigest
    && left.catalogVersion === right.catalogVersion
    && left.inventoryRowCount === right.inventoryRowCount;
}

function stateBytesV1(state: Rfc64CatalogMutationStateV1): number {
  let bytes = 0;
  for (const asset of state.assets) {
    bytes += asset.projectionBytes.byteLength + RETAINED_STATE_ROW_BYTES_V1;
  }
  return bytes;
}

export class Rfc64CatalogMutationMemoryV1 {
  readonly #limits: Rfc64CatalogMutationMemoryLimitsV1;
  readonly #readVerified: typeof readVerifiedRfc64CatalogMutationStateV1;
  /** Least recently used first. */
  readonly #scopes = new Map<string, RememberedScopeV1>();
  readonly #origins = new WeakMap<Rfc64CatalogMutationStateV1, StateOriginV1>();

  constructor(
    limits: Rfc64CatalogMutationMemoryLimitsV1 = DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1,
    readVerified: typeof readVerifiedRfc64CatalogMutationStateV1 = readVerifiedRfc64CatalogMutationStateV1,
  ) {
    this.#limits = limits;
    this.#readVerified = readVerified;
  }

  /** Scopes and bytes held now. */
  get retained(): Readonly<{ scopes: number; states: number; bytes: number }> {
    let states = 0;
    let bytes = 0;
    for (const scope of this.#scopes.values()) {
      if (scope.state !== undefined) states += 1;
      bytes += scopeBytesV1(scope);
    }
    return { scopes: this.#scopes.size, states, bytes };
  }

  /**
   * The verified state of the scope's applied head, or null when it has none. `authority` is the
   * digest of the policy accepted for the scope; without one nothing is served from memory or kept.
   */
  async read(
    persistence: Rfc64PersistenceV1,
    catalogScopeDigest: Digest32V1,
    authorAddress: AuthorCatalogScopeV1['authorAddress'],
    authority: string | undefined,
  ): Promise<Rfc64CatalogMutationStateV1 | null> {
    const key = scopeKeyV1(catalogScopeDigest, authorAddress);
    const current = persistence.inventory.readAppliedCatalogHeadV1(catalogScopeDigest, authorAddress);
    if (current === null) {
      this.#scopes.delete(key);
      return null;
    }
    const remembered = this.#scopes.get(key);
    if (remembered?.state !== undefined) {
      if (
        authority !== undefined
        && remembered.authority === authority
        && sameAppliedHeadV1(remembered.state.current, current)
      ) {
        this.#touch(key, remembered);
        return remembered.state;
      }
      // Another writer moved the head, or the scope's policy changed: start over from the store.
      this.#scopes.delete(key);
    }
    const state = await this.#readVerified(persistence, current);
    if (authority !== undefined) this.#keep(key, authority, state);
    return state;
  }

  /**
   * The state after this path's own applied-head CAS: the committed head, the set that was signed
   * and the unchanged authorization. It is kept only as the successor of a state this memory
   * handed out, under the authority that state was read under, and only when the committed
   * record names the successor that was signed.
   */
  advance(
    previous: Rfc64CatalogMutationStateV1,
    applied: AppliedCatalogHeadSnapshotV1,
    successor: Readonly<{ headObjectDigest: Digest32V1; signatureVariantDigest: Digest32V1 }>,
    assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
  ): Rfc64CatalogMutationStateV1 {
    const next: Rfc64CatalogMutationStateV1 = Object.freeze({
      current: applied,
      previousHead: Object.freeze({
        objectDigest: successor.headObjectDigest,
        signatureVariantDigest: successor.signatureVariantDigest,
      }),
      catalogIssuerAuthorization: previous.catalogIssuerAuthorization,
      assets: Object.freeze([...assets].sort(compareRfc64PublicCatalogSuccessorAssetsByKaIdV1)),
      expectedCurrentCatalogHeadDigest: applied.currentCatalogHeadDigest,
    });
    const origin = this.#origins.get(previous);
    if (origin !== undefined && applied.currentCatalogHeadDigest === successor.headObjectDigest) {
      this.#keep(origin.key, origin.authority, next);
    }
    return next;
  }

  /** A mutation of the scope failed: its state and its verified rows are read and verified again. */
  forget(catalogScopeDigest: Digest32V1, authorAddress: string): void {
    this.#scopes.delete(scopeKeyV1(catalogScopeDigest, authorAddress));
  }

  /** The rows of this scope verified so far, or undefined when nothing is remembered. */
  verifiedRows(
    catalogScopeDigest: Digest32V1,
    authorAddress: string,
  ): Rfc64VerifiedCatalogRowsV1 | undefined {
    if (this.#limits.maxScopes < 1) return undefined;
    const key = scopeKeyV1(catalogScopeDigest, authorAddress);
    const remembered = this.#scopes.get(key) ?? forgottenScopeV1();
    this.#touch(key, remembered);
    this.#evict(key);
    return remembered.verifiedRows;
  }

  #keep(key: string, authority: string, state: Rfc64CatalogMutationStateV1): void {
    if (this.#limits.maxScopes < 1) return;
    const remembered = this.#scopes.get(key) ?? forgottenScopeV1();
    const stateBytes = stateBytesV1(state);
    remembered.state = undefined;
    remembered.authority = undefined;
    remembered.stateBytes = 0;
    // A state that does not fit the whole budget beside its own verified rows is read every
    // time; the rows stay verified.
    if (stateBytes + scopeBytesV1(remembered) <= this.#limits.maxRetainedBytes) {
      remembered.state = state;
      remembered.authority = authority;
      remembered.stateBytes = stateBytes;
      this.#origins.set(state, { key, authority });
    }
    this.#touch(key, remembered);
    this.#evict(key);
  }

  #touch(key: string, remembered: RememberedScopeV1): void {
    this.#scopes.delete(key);
    this.#scopes.set(key, remembered);
  }

  /** Drop the least recently used scopes, never `keep`, until both bounds hold. */
  #evict(keep: string): void {
    let bytes = 0;
    for (const scope of this.#scopes.values()) bytes += scopeBytesV1(scope);
    for (const [key, scope] of this.#scopes) {
      if (this.#scopes.size <= this.#limits.maxScopes && bytes <= this.#limits.maxRetainedBytes) return;
      if (key === keep) continue;
      bytes -= scopeBytesV1(scope);
      this.#scopes.delete(key);
    }
  }
}

/** Read and verify the applied head's state from the durable store. */
export async function readVerifiedRfc64CatalogMutationStateV1(
  persistence: Rfc64PersistenceV1,
  current: AppliedCatalogHeadSnapshotV1,
): Promise<Rfc64CatalogMutationStateV1> {
  const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
    objectDigest: current.currentCatalogHeadDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) throw new Error('RFC-64 applied author head is not durably staged');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const previousHead = Object.freeze({
    objectDigest: storedHead.envelope.objectDigest as Digest32V1,
    signatureVariantDigest: computeControlSignatureVariantDigestHex(
      storedHead.envelope.objectDigest,
      storedHead.envelope.signature,
    ) as Digest32V1,
  });
  const history = await loadBoundedAuthorCatalogHistoryV1(persistence, previousHead);
  const assets = await loadRfc64CatalogSuccessorAssetsV1(persistence, history);
  const storedDelegation = await persistence.controlObjects.getVerifiedObjectByDigest({
    objectDigest: history.previousHead.payload.catalogIssuerDelegationDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedDelegation === null) {
    throw new Error('RFC-64 applied author head delegation is not durably staged');
  }
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
  return Object.freeze({
    current,
    previousHead,
    catalogIssuerAuthorization: Object.freeze({
      catalogIssuerDelegation: storedDelegation.envelope,
      parentAuthorAgentEvidence: null,
    }),
    assets: Object.freeze(assets),
    expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
  });
}

async function loadRfc64CatalogSuccessorAssetsV1(
  persistence: Rfc64PersistenceV1,
  history: BoundedAuthorCatalogHistoryV1,
): Promise<Rfc64CatalogSuccessorAssetInputV1[]> {
  const assets: Rfc64CatalogSuccessorAssetInputV1[] = [];
  for (const row of history.previousBucket?.payload.rows ?? []) {
    const bundleBytes = await persistence.kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
    if (bundleBytes === null) {
      throw new Error(`RFC-64 applied catalog bundle ${row.transfer.blobDigest} is unavailable`);
    }
    const decoded = decodeOpaqueKaBundleV1(bundleBytes);
    if (
      decoded.blobDigest !== row.transfer.blobDigest
      || decoded.projectionDigest !== row.projectionDigest
    ) {
      throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
    }
    assets.push(Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: new Uint8Array(decoded.projectionBytes),
      seal: parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes),
    }));
  }
  return assets;
}

const MEMORIES_V1 = new WeakMap<object, Rfc64CatalogMutationMemoryV1>();

/** The catalog mutation memory of one agent, created on first use. */
export function rfc64CatalogMutationMemoryV1(owner: object): Rfc64CatalogMutationMemoryV1 {
  let memory = MEMORIES_V1.get(owner);
  if (memory === undefined) {
    memory = new Rfc64CatalogMutationMemoryV1(
      resolveCatalogMutationMemoryLimitsV1(process.env.DKG_RFC64_CATALOG_MUTATION_MEMORY),
    );
    MEMORIES_V1.set(owner, memory);
  }
  return memory;
}

/** Replace `owner`'s memory, for example with other limits. */
export function installRfc64CatalogMutationMemoryV1(
  owner: object,
  memory: Rfc64CatalogMutationMemoryV1,
): void {
  MEMORIES_V1.set(owner, memory);
}
