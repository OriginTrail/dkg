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
  AppliedCatalogHeadsTokenV1,
  Rfc64InventoryV1OperationsV1,
} from './inventory-v1/index.js';

export const RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1 = 8;

export interface Rfc64OperationalAppliedHeadV1 {
  readonly snapshot: AppliedCatalogHeadSnapshotV1;
  readonly issuedAt: TimestampMsV1;
  readonly contextGraphId: string;
  readonly scopeKey: string;
}

/** The persistence surface the operational applied-head view reads. */
export interface Rfc64OperationalAppliedHeadsStorageV1 {
  readonly inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadsSnapshotV1'>;
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>;
}

type Rfc64OperationalAppliedHeadProjectionV1 = Omit<Rfc64OperationalAppliedHeadV1, 'snapshot'>;

interface Rfc64OperationalAppliedHeadsCacheV1 {
  /** The last load in which every listed head verified, keyed by its inventory. */
  complete: Readonly<{
    token: AppliedCatalogHeadsTokenV1;
    heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[];
  }> | null;
  /**
   * Heads the newest settled load verified, by head digest, holding only heads
   * that load listed. A head that failed to load or verify never enters.
   */
  verifiedByDigest: ReadonlyMap<Digest32V1, Readonly<Rfc64OperationalAppliedHeadProjectionV1>>;
  /** The load concurrent callers that read the same inventory share. */
  inFlight: Readonly<{
    token: AppliedCatalogHeadsTokenV1;
    heads: Promise<readonly Readonly<Rfc64OperationalAppliedHeadV1>[]>;
  }> | null;
  /** Orders loads so a slower one for an older inventory never replaces a newer one. */
  generation: number;
}

/** Per persistence instance, so no agent reads another agent's heads. */
const rfc64OperationalAppliedHeadsCachesV1 =
  new WeakMap<Rfc64OperationalAppliedHeadsStorageV1, Rfc64OperationalAppliedHeadsCacheV1>();

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
  token: AppliedCatalogHeadsTokenV1,
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
    cache.complete = complete ? Object.freeze({ token, heads }) : null;
  }
  return heads;
}

/**
 * Every applied catalog head whose stored head object reads back and verifies,
 * in inventory order. A head that is missing or fails verification is left
 * out, as before.
 *
 * The inventory snapshot's token keys the result, so applying, replacing or
 * removing a head is seen by the next call, and a write that left every row
 * as it was keeps the cached result.
 * The stored head objects are content-addressed and never rewritten or
 * removed, so a head verified once is reused while its digest stays applied
 * instead of being re-read and re-verified per call. Only a load in which
 * every head verified is reused as a whole; heads that failed are retried.
 * Concurrent callers that read the same inventory share one load.
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
  const { token, heads: snapshots } = storage.inventory.readAppliedCatalogHeadsSnapshotV1();
  if (cache.complete?.token === token) return cache.complete.heads;
  if (cache.inFlight?.token === token) return cache.inFlight.heads;
  cache.generation += 1;
  const inFlight = Object.freeze({
    token,
    heads: readRfc64OperationalAppliedHeadsV1(
      storage,
      cache,
      snapshots,
      token,
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
