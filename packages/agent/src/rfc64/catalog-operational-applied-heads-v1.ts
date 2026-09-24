// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { mapWithConcurrency } from '../map-with-concurrency.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type {
  AppliedCatalogHeadSnapshotV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';

const RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1 = 8;

export interface Rfc64OperationalAppliedHeadV1 {
  readonly snapshot: AppliedCatalogHeadSnapshotV1;
  readonly issuedAt: TimestampMsV1;
  readonly contextGraphId: string;
  readonly scopeKey: string;
}

/** The persistence surface the operational applied-head view reads. */
export interface Rfc64OperationalAppliedHeadsStorageV1 {
  /**
   * With `readAppliedCatalogHeadsRevisionV1`, a call under an unchanged
   * revision is answered without listing; without it every call lists.
   */
  readonly inventory:
    & Pick<Rfc64InventoryV1OperationsV1, 'listAppliedCatalogHeadsV1'>
    & Partial<Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadsRevisionV1'>>;
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>;
}

type Rfc64OperationalAppliedHeadProjectionV1 = Omit<Rfc64OperationalAppliedHeadV1, 'snapshot'>;

interface Rfc64OperationalAppliedHeadsCacheV1 {
  /**
   * The last load in which every listed head verified, keyed by its inventory
   * and by the latest inventory revision that listed exactly that inventory.
   */
  complete: Readonly<{
    fingerprint: string;
    revision: number | undefined;
    heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[];
  }> | null;
  /**
   * Heads the newest settled load verified, by head digest, holding only heads
   * that load listed. A head that failed to load or verify never enters.
   */
  verifiedByDigest: ReadonlyMap<Digest32V1, Readonly<Rfc64OperationalAppliedHeadProjectionV1>>;
  /** The load concurrent callers that listed the same inventory share. */
  inFlight: Readonly<{
    fingerprint: string;
    revision: number | undefined;
    heads: Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]>;
  }> | null;
  /** Orders loads so a slower one for an older inventory never replaces a newer one. */
  generation: number;
}

/** Per persistence instance, so no agent reads another agent's heads. */
const rfc64OperationalAppliedHeadsCachesV1 =
  new WeakMap<Rfc64OperationalAppliedHeadsStorageV1, Rfc64OperationalAppliedHeadsCacheV1>();

/**
 * Every applied-head snapshot field. The `satisfies` clause fails the build
 * when `AppliedCatalogHeadSnapshotV1` gains a field the fingerprint does not
 * key, so an inventory change the cache could miss cannot compile.
 */
const RFC64_APPLIED_HEAD_FINGERPRINT_FIELDS_V1 = Object.freeze(Object.keys({
  catalogScopeDigest: true,
  authorAddress: true,
  currentCatalogHeadDigest: true,
  appliedInventoryDigest: true,
  catalogVersion: true,
  inventoryRowCount: true,
} satisfies Record<keyof AppliedCatalogHeadSnapshotV1, true>) as
  (keyof AppliedCatalogHeadSnapshotV1)[]);

/** Every field of every row, in listing order (the result keeps that order). */
function rfc64OperationalAppliedHeadsFingerprintV1(
  snapshots: readonly AppliedCatalogHeadSnapshotV1[],
): string {
  return snapshots
    .map((snapshot) => RFC64_APPLIED_HEAD_FINGERPRINT_FIELDS_V1
      .map((field) => snapshot[field])
      .join(':'))
    .join('\n');
}

export function rfc64CatalogTargetScopeKeyV1(input: Readonly<{
  networkId: string;
  contextGraphId: string;
  subGraphName: string | null;
  authorAddress: string;
  catalogEra: string;
}>): string {
  return [
    input.networkId,
    input.contextGraphId,
    input.subGraphName ?? '',
    input.authorAddress.toLowerCase(),
    input.catalogEra,
  ].join('\0');
}

/** Read, re-verify and project one stored head; `null` when it is missing or invalid. */
async function readRfc64OperationalAppliedHeadProjectionV1(
  storage: Rfc64OperationalAppliedHeadsStorageV1,
  objectDigest: Digest32V1,
): Promise<Readonly<Rfc64OperationalAppliedHeadProjectionV1> | null> {
  const stored = await storage.controlObjects.getVerifiedObjectByDigest({
    objectDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  }).catch(() => null);
  if (stored === null) return null;
  try {
    assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
  } catch {
    return null;
  }
  const payload = stored.envelope.payload;
  return Object.freeze({
    issuedAt: payload.issuedAt,
    contextGraphId: payload.contextGraphId,
    scopeKey: rfc64CatalogTargetScopeKeyV1({
      networkId: payload.networkId,
      contextGraphId: payload.contextGraphId,
      subGraphName: payload.subGraphName,
      authorAddress: payload.authorAddress,
      catalogEra: payload.era,
    }),
  });
}

async function readRfc64OperationalAppliedHeadsV1(
  storage: Rfc64OperationalAppliedHeadsStorageV1,
  cache: Rfc64OperationalAppliedHeadsCacheV1,
  snapshots: readonly AppliedCatalogHeadSnapshotV1[],
  fingerprint: string,
  revision: number | undefined,
  generation: number,
): Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const verified = cache.verifiedByDigest;
  let complete = true;
  const loaded = await mapWithConcurrency(
    snapshots,
    RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1,
    async (snapshot): Promise<Readonly<Rfc64OperationalAppliedHeadV1> | null> => {
      const projection = verified.get(snapshot.currentCatalogHeadDigest)
        ?? await readRfc64OperationalAppliedHeadProjectionV1(
          storage,
          snapshot.currentCatalogHeadDigest,
        );
      if (projection === null) {
        complete = false;
        return null;
      }
      return Object.freeze({ snapshot, ...projection });
    },
  );
  const heads = Object.freeze(loaded.filter(
    (head): head is Readonly<Rfc64OperationalAppliedHeadV1> => head !== null,
  ));
  if (generation === cache.generation) {
    cache.verifiedByDigest = new Map(heads.map(({ snapshot, ...projection }) => [
      snapshot.currentCatalogHeadDigest,
      Object.freeze(projection),
    ]));
    // A head that failed may be readable next time: only a load in which
    // every head verified answers later calls without reading.
    cache.complete = complete ? Object.freeze({ fingerprint, revision, heads }) : null;
  }
  return heads;
}

/**
 * Every applied catalog head whose stored head object reads back and verifies,
 * in inventory order. A head that is missing or fails verification is left
 * out, as before.
 *
 * Every field of every listed row keys the result, so applying, replacing or
 * removing a head is seen by the next call. The inventory is listed on every
 * call unless it reports a revision no write has moved since a listing that
 * produced the cached result; then that listing still describes it.
 * The stored head objects are content-addressed and never rewritten or
 * removed, so a head verified once is reused while its digest stays applied
 * instead of being re-read and re-verified per call. Only a load in which
 * every head verified is reused as a whole; heads that failed are retried.
 * Concurrent callers that list the same inventory share one load.
 */
export async function loadRfc64OperationalAppliedHeadsV1(
  storage: Rfc64OperationalAppliedHeadsStorageV1,
): Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  let cache = rfc64OperationalAppliedHeadsCachesV1.get(storage);
  if (cache === undefined) {
    cache = {
      complete: null,
      verifiedByDigest: new Map(),
      inFlight: null,
      generation: 0,
    };
    rfc64OperationalAppliedHeadsCachesV1.set(storage, cache);
  }
  // Read in the same synchronous turn as the listing below, so no write can
  // land between the revision and the rows it vouches for.
  const revision = storage.inventory.readAppliedCatalogHeadsRevisionV1?.();
  if (revision !== undefined) {
    if (cache.complete?.revision === revision) return cache.complete.heads;
    if (cache.inFlight?.revision === revision) return cache.inFlight.heads;
  }
  const snapshots = storage.inventory.listAppliedCatalogHeadsV1();
  const fingerprint = rfc64OperationalAppliedHeadsFingerprintV1(snapshots);
  if (cache.complete?.fingerprint === fingerprint) {
    // A write that left every row as it was: carry the result to this revision.
    if (revision !== undefined) {
      cache.complete = Object.freeze({ ...cache.complete, revision });
    }
    return cache.complete.heads;
  }
  if (cache.inFlight?.fingerprint === fingerprint) return cache.inFlight.heads;
  cache.generation += 1;
  const inFlight = Object.freeze({
    fingerprint,
    revision,
    heads: readRfc64OperationalAppliedHeadsV1(
      storage,
      cache,
      snapshots,
      fingerprint,
      revision,
      cache.generation,
    ),
  });
  cache.inFlight = inFlight;
  try {
    return await inFlight.heads;
  } finally {
    if (cache.inFlight === inFlight) cache.inFlight = null;
  }
}
