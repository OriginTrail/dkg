// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  encodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type PublishAuthorCatalogExactSetSuccessorResultV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from '../dkg-agent-rfc64-catalog.js';
import { mapWithConcurrencyDrained } from '../map-with-concurrency.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../rfc64/persistence-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../rfc64/public-catalog-inventory-completeness-v1.js';
import { compareRfc64PublicCatalogSuccessorAssetsByKaIdV1 } from
  '../rfc64/public-catalog-successor-asset-v1.js';
import type { Rfc64PublicCatalogIssuerAuthorizationV1 } from
  '../rfc64/public-catalog-successor-producer-v1.js';
import {
  Rfc64VerifiedCatalogRowSetV1,
  type Rfc64VerifiedCatalogRowsV1,
  type VerifiedCatalogRowV1,
} from './verified-catalog-rows.js';

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
 * - the applied head and its delegation are still in the durable store, read and verified again;
 * - no mutation of the scope has failed between its read of the state and its applied-head CAS.
 *
 * It never replaces a check: the applied-head CAS on the expected digest stays the authority, and
 * the successor still reads its predecessor from the durable store and verifies it. A state
 * served from memory that ends work without a successor does the same first: the head's directory
 * root and bucket are read back and verified, and so is the bundle of every row the decision is
 * about, which is one row for a placement and every row for a projection of the whole set
 * ({@link Rfc64CatalogMutationMemoryV1.confirmDurable}). What a state served from memory never
 * reads again by itself is the bundles of the rows a placement is not about; a successor reads
 * every unchanged row's bundle back. Memory is bounded by a number of scopes and a number of
 * retained bytes, and nothing is persisted.
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

/**
 * One exact set is at most 64 MiB of bundles and 1,024 rows, so one full catalog always fits. The
 * bytes are what bounds the memory; the scope count only bounds how many small catalogs share it.
 */
export const DEFAULT_CATALOG_MUTATION_MEMORY_LIMITS_V1: Rfc64CatalogMutationMemoryLimitsV1 =
  Object.freeze({ maxScopes: 64, maxRetainedBytes: 96 * 1024 * 1024 });

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
  readonly rows: Rfc64VerifiedCatalogRowSetV1;
  /** What a production of the scope is given: lookups, and admission through this memory. */
  readonly verifiedRows: Rfc64VerifiedCatalogRowsV1;
}

function scopeBytesV1(scope: RememberedScopeV1): number {
  return scope.stateBytes + scope.rows.size * RETAINED_VERIFIED_ROW_BYTES_V1;
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

/**
 * The applied head and its delegation, read from the durable store and verified again. Everything
 * a kept state holds was derived from them.
 */
async function appliedHeadDurablyHeldV1(
  persistence: Rfc64PersistenceV1,
  state: Rfc64CatalogMutationStateV1,
): Promise<boolean> {
  try {
    const [head, delegation] = await Promise.all([
      state.previousHead.objectDigest,
      state.catalogIssuerAuthorization.catalogIssuerDelegation.objectDigest as Digest32V1,
    ].map((objectDigest) => persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    })));
    return head !== null && delegation !== null;
  } catch {
    // The read of the durable catalog that follows says what is wrong with the object.
    return false;
  }
}

function sameBytesV1(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

type SignedCatalogBucketRowV1 =
  NonNullable<BoundedAuthorCatalogHistoryV1['previousBucket']>['payload']['rows'][number];

/** Bundles of a whole set read back at once: as many as a successor reads or stages at once. */
const CONFIRMED_BUNDLE_READ_CONCURRENCY_V1 = 8;

/** `row` is the signed row of `asset`, and the bundle it names is in the durable store, byte for byte. */
async function bundleDurablyHeldV1(
  persistence: Rfc64PersistenceV1,
  row: SignedCatalogBucketRowV1 | undefined,
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Promise<void> {
  const encoded = encodeOpaqueKaBundleV1(
    asset.projectionBytes,
    canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal),
  );
  // The blob digest covers the projection and the seal, which names its KA: the same digest is
  // the same row's bundle.
  if (row?.transfer.blobDigest !== encoded.blobDigest) {
    throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
  }
  const stored = await persistence.kaBundles.readKaBundleByDigest(encoded.blobDigest);
  if (stored === null) {
    throw new Error(`RFC-64 applied catalog bundle ${encoded.blobDigest} is unavailable`);
  }
  if (!sameBytesV1(stored, encoded.bundleBytes)) {
    throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
  }
}

/** The successor this path signed, as `advance` reads it. */
export type Rfc64SignedCatalogSuccessorV1 = Pick<
  PublishAuthorCatalogExactSetSuccessorResultV1,
  'headObjectDigest' | 'signatureVariantDigest' | 'assets'
>;

/**
 * One serialized mutation of a scope, as the memory follows it. The mutation says when it asks for
 * a successor, when that successor's applied-head CAS returned and whether it failed; what a
 * failure forgets is decided from those three alone.
 *
 * A failure forgets everything remembered about the scope, with one exception: a failure after
 * `committed`, before `producing` is called again, says nothing about the catalog (handing the
 * committed head to its peers, a cancellation between two successors). What the commit left
 * remembered stays.
 */
export interface Rfc64CatalogMutationV1 {
  /** A successor is asked for: from here to `committed` a failure may come from the catalog. */
  producing(): void;
  /** The applied-head CAS of that successor returned: the state after it (see `advance`). */
  committed(
    previous: Rfc64CatalogMutationStateV1,
    applied: AppliedCatalogHeadSnapshotV1,
    successor: Rfc64SignedCatalogSuccessorV1,
    assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
  ): Rfc64CatalogMutationStateV1;
  /** The mutation failed. */
  failed(): void;
}

export class Rfc64CatalogMutationMemoryV1 {
  readonly #limits: Rfc64CatalogMutationMemoryLimitsV1;
  readonly #readVerified: typeof readVerifiedRfc64CatalogMutationStateV1;
  /** Least recently used first. */
  readonly #scopes = new Map<string, RememberedScopeV1>();
  readonly #origins = new WeakMap<Rfc64CatalogMutationStateV1, StateOriginV1>();
  /** The seal digest of an asset a state holds; such an asset is the mutation's own copy and never changes. */
  readonly #sealDigests = new WeakMap<Rfc64CatalogSuccessorAssetInputV1, Digest32V1>();
  /**
   * States read from the durable store and not handed out from memory since: whoever holds one
   * has read everything it rests on, bundles and all, in the call it is deciding in.
   */
  readonly #readByItsHolder = new WeakSet<Rfc64CatalogMutationStateV1>();

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
      this.#forget(key);
      return null;
    }
    const remembered = this.#scopes.get(key);
    const state = remembered?.state;
    if (remembered !== undefined && state !== undefined) {
      if (
        authority !== undefined
        && remembered.authority === authority
        && sameAppliedHeadV1(state.current, current)
        && await appliedHeadDurablyHeldV1(persistence, state)
      ) {
        // The durable check gave other work a turn: only a scope still in place is refreshed.
        if (this.#scopes.get(key) === remembered) this.#touch(key, remembered);
        this.#readByItsHolder.delete(state);
        return state;
      }
      // Another writer moved the head, the scope's policy changed, or the head's own objects are
      // no longer in the durable store: start over from the store.
      if (this.#scopes.get(key) === remembered) this.#forget(key);
    }
    let read: Rfc64CatalogMutationStateV1;
    try {
      read = await this.#readVerified(persistence, current);
    } catch (cause) {
      this.#forget(key);
      throw cause;
    }
    this.#readByItsHolder.add(read);
    if (authority !== undefined) this.#keep(key, authority, read);
    return read;
  }

  /** One serialized mutation of the scope starts. */
  mutation(catalogScopeDigest: Digest32V1, authorAddress: string): Rfc64CatalogMutationV1 {
    const key = scopeKeyV1(catalogScopeDigest, authorAddress);
    // Whether the last thing this mutation did was to commit a successor. `advance` has by then
    // kept what the commit proves and forgotten the scope if the commit proves nothing.
    let afterCommit = false;
    return Object.freeze({
      producing: (): void => {
        afterCommit = false;
      },
      committed: (
        previous: Rfc64CatalogMutationStateV1,
        applied: AppliedCatalogHeadSnapshotV1,
        successor: Rfc64SignedCatalogSuccessorV1,
        assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
      ): Rfc64CatalogMutationStateV1 => {
        afterCommit = true;
        return this.advance(previous, applied, successor, assets);
      },
      failed: (): void => {
        if (!afterCommit) this.#forget(key);
      },
    });
  }

  /**
   * The state after this path's own applied-head CAS: the committed head, the set that was signed
   * and the unchanged authorization. It is kept only as the successor of a state this memory
   * handed out, under the authority that state was read under, and only when the committed record
   * names the successor that was signed and `assets` hold, row for row, the seals of that
   * successor's rows. A committed record that says anything else leaves nothing remembered about
   * the scope.
   */
  advance(
    previous: Rfc64CatalogMutationStateV1,
    applied: AppliedCatalogHeadSnapshotV1,
    successor: Rfc64SignedCatalogSuccessorV1,
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
    if (origin === undefined) return next;
    if (this.#namesTheSignedSet(applied, successor, next.assets)) {
      this.#keep(origin.key, origin.authority, next);
    } else {
      this.#forget(origin.key);
    }
    return next;
  }

  /**
   * Before a state ends work without producing a successor: a covered repair retires its durable
   * marker, an upsert finds its asset already placed, a projection finds nothing to do. The
   * applied head's directory root and bucket are read from the durable store and verified again,
   * as a successor would read them. The bucket must name the remembered bundle of every row the
   * decision is about, and each of those bundles must be in the store, byte for byte: the row of
   * `asset`, or with no `asset` every row of the state, which must then be the bucket's rows and
   * no other. Anything else forgets the scope and fails the decision, as a read of the durable
   * catalog would.
   *
   * A state that `read` took from the durable store for this very decision is not read a second
   * time: that read is the whole catalog, bundles included. So a decision never reads more than
   * it does without the memory.
   */
  async confirmDurable(
    persistence: Rfc64PersistenceV1,
    catalogScopeDigest: Digest32V1,
    authorAddress: string,
    state: Rfc64CatalogMutationStateV1,
    asset?: Rfc64CatalogSuccessorAssetInputV1,
  ): Promise<void> {
    if (this.#readByItsHolder.has(state)) return;
    try {
      const history = await loadBoundedAuthorCatalogHistoryV1(persistence, state.previousHead);
      const rows = history.previousBucket?.payload.rows ?? [];
      if (asset !== undefined) {
        await bundleDurablyHeldV1(
          persistence,
          rows.find(({ kaId }) => kaId === asset.seal.reservedKaId),
          asset,
        );
        return;
      }
      if (rows.length !== state.assets.length) {
        throw new Error('RFC-64 applied catalog rows differ from its signed predecessor bucket');
      }
      // Both are in mathematical KA order. A read that fails lets the reads under way finish.
      await mapWithConcurrencyDrained(
        state.assets,
        CONFIRMED_BUNDLE_READ_CONCURRENCY_V1,
        (held, index) => bundleDurablyHeldV1(persistence, rows[index], held),
      );
    } catch (cause) {
      this.forget(catalogScopeDigest, authorAddress);
      throw cause;
    }
  }

  /** Its state and its verified rows are read and verified again. */
  forget(catalogScopeDigest: Digest32V1, authorAddress: string): void {
    this.#forget(scopeKeyV1(catalogScopeDigest, authorAddress));
  }

  /** The durable stores are closing: nothing read from them is served to whoever opens them next. */
  clear(): void {
    // A Map may lose entries while it is walked.
    for (const key of this.#scopes.keys()) this.#forget(key);
  }

  /**
   * Where a production of the scope looks up the rows verified so far and files the rows of the
   * successor it completes, or undefined when nothing is remembered.
   */
  verifiedRows(
    catalogScopeDigest: Digest32V1,
    authorAddress: string,
  ): Rfc64VerifiedCatalogRowsV1 | undefined {
    if (this.#limits.maxScopes < 1) return undefined;
    const key = scopeKeyV1(catalogScopeDigest, authorAddress);
    const scope = this.#scope(key);
    this.#touch(key, scope);
    this.#evict();
    return scope.verifiedRows;
  }

  /** The committed record and the signed successor agree, and `assets` are that successor's seals. */
  #namesTheSignedSet(
    applied: AppliedCatalogHeadSnapshotV1,
    successor: Rfc64SignedCatalogSuccessorV1,
    assets: readonly Rfc64CatalogSuccessorAssetInputV1[],
  ): boolean {
    const rows = successor.assets;
    try {
      return applied.currentCatalogHeadDigest === successor.headObjectDigest
        && applied.inventoryRowCount === String(rows.length)
        && rows.length === assets.length
        // The seal names its KA, UAL and assertion version: the same digest is the same row's seal.
        && assets.every((asset, index) => rows[index]!.sealDigest === this.#sealDigestOf(asset))
        && applied.appliedInventoryDigest === computeRfc64AppliedInventoryDigestV1({
          catalogScopeDigest: applied.catalogScopeDigest,
          rows,
        });
    } catch {
      // Rows or seals that cannot be hashed name nothing.
      return false;
    }
  }

  /** One hash per asset object: a successor repeats every object of its predecessor's state but one. */
  #sealDigestOf(asset: Rfc64CatalogSuccessorAssetInputV1): Digest32V1 {
    let digest = this.#sealDigests.get(asset);
    if (digest === undefined) {
      digest = computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal);
      this.#sealDigests.set(asset, digest);
    }
    return digest;
  }

  /** The scope's entry, new when nothing is remembered about it; the caller places it. */
  #scope(key: string): RememberedScopeV1 {
    const known = this.#scopes.get(key);
    if (known !== undefined) return known;
    const rows = new Rfc64VerifiedCatalogRowSetV1();
    const scope: RememberedScopeV1 = {
      state: undefined,
      authority: undefined,
      stateBytes: 0,
      rows,
      // A production keeps this for as long as it runs. Once the scope is forgotten or evicted
      // its rows are gone, and the production files nothing back.
      verifiedRows: Object.freeze({
        get size(): number {
          return rows.size;
        },
        find: (binding: string | undefined, canonicalRow: string) => rows.find(binding, canonicalRow),
        replace: (binding: string | undefined, verified: ReadonlyMap<string, VerifiedCatalogRowV1>) => {
          if (this.#scopes.get(key) !== scope) return;
          rows.replace(binding, verified);
          this.#settle(key, scope);
        },
        invalidate: () => {
          if (this.#scopes.get(key) === scope) this.#forget(key);
        },
      }),
    };
    return scope;
  }

  #forget(key: string): void {
    const scope = this.#scopes.get(key);
    if (scope === undefined) return;
    this.#scopes.delete(key);
    this.#dropState(scope);
    scope.rows.clear();
  }

  #dropState(scope: RememberedScopeV1): void {
    scope.state = undefined;
    scope.authority = undefined;
    scope.stateBytes = 0;
  }

  /** Keep `state` for the scope if it fits; says whether it was kept. */
  #keep(key: string, authority: string, state: Rfc64CatalogMutationStateV1): boolean {
    if (this.#limits.maxScopes < 1) return false;
    const scope = this.#scope(key);
    this.#dropState(scope);
    scope.state = state;
    scope.authority = authority;
    scope.stateBytes = stateBytesV1(state);
    this.#settle(key, scope);
    if (scope.state !== state) return false;
    this.#origins.set(state, { key, authority });
    return true;
  }

  /**
   * The scope grew, by its state or by its verified rows: make both bounds hold again, here and
   * now. The scope itself comes first. Rows that do not fit the whole budget are not kept; a state
   * that does not fit beside its own rows is read every time and the rows stay verified. Then the
   * least recently used other scopes go.
   */
  #settle(key: string, scope: RememberedScopeV1): void {
    const budget = this.#limits.maxRetainedBytes;
    if (scope.rows.size * RETAINED_VERIFIED_ROW_BYTES_V1 > budget) scope.rows.clear();
    if (scopeBytesV1(scope) > budget) this.#dropState(scope);
    this.#touch(key, scope);
    this.#evict();
  }

  #touch(key: string, scope: RememberedScopeV1): void {
    this.#scopes.delete(key);
    this.#scopes.set(key, scope);
  }

  /**
   * Drop the least recently used scopes until both bounds hold. The scope just used is the last
   * in line, and it fits on its own.
   */
  #evict(): void {
    let bytes = 0;
    for (const scope of this.#scopes.values()) bytes += scopeBytesV1(scope);
    for (const [key, scope] of this.#scopes) {
      if (this.#scopes.size <= this.#limits.maxScopes && bytes <= this.#limits.maxRetainedBytes) return;
      bytes -= scopeBytesV1(scope);
      this.#forget(key);
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
      seal: Object.freeze(parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes)),
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
