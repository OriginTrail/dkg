// SPDX-License-Identifier: Apache-2.0

import { assertSignedAuthorCatalogHeadEnvelopeV1 } from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { mapWithConcurrency } from '../map-with-concurrency.js';
import { RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1, type Rfc64OperationalAppliedHeadV1 } from './catalog-operational-applied-heads-v1.js';
import { rfc64CatalogTargetExactIdentityKeyV1 } from './catalog-operational-targets-v1.js';
import type { Rfc64PersistenceV1 } from './persistence-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export function groupRfc64OperationalAppliedHeadsV1(
  heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[],
): ReadonlyMap<string, readonly Readonly<Rfc64OperationalAppliedHeadV1>[]> {
  const byContextGraph = new Map<string, Readonly<Rfc64OperationalAppliedHeadV1>[]>();
  for (const head of heads) {
    const grouped = byContextGraph.get(head.contextGraphId) ?? [];
    grouped.push(head);
    byContextGraph.set(head.contextGraphId, grouped);
  }
  return byContextGraph;
}

export async function loadRfc64OperationalPromisedRowCountsV1(
  persistence: Rfc64PersistenceV1,
  targets: readonly Rfc64PublicCatalogHeadAnnouncementV1[],
): Promise<ReadonlyMap<string, string | null>> {
  const uniqueTargets = new Map(targets.map((target) => [
    rfc64CatalogTargetExactIdentityKeyV1(target),
    target,
  ]));
  const loaded = await mapWithConcurrency(
    [...uniqueTargets],
    RFC64_OPERATIONAL_STATUS_HEAD_READ_CONCURRENCY_V1,
    async ([identity, target]): Promise<readonly [string, string | null]> => {
      const stored = await persistence.controlObjects.getVerifiedObject({
        objectDigest: target.catalogHeadObjectDigest,
        signatureVariantDigest: target.signatureVariantDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      }).catch(() => null);
      if (stored === null) return [identity, null] as const;
      try {
        assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
        const payload = stored.envelope.payload;
        if (
          stored.envelope.objectDigest !== target.catalogHeadObjectDigest
          || payload.networkId !== target.networkId
          || payload.contextGraphId !== target.contextGraphId
          || payload.subGraphName !== target.subGraphName
          || payload.authorAddress !== target.authorAddress
          || payload.era !== target.catalogEra
          || payload.version !== target.catalogVersion
        ) return [identity, null] as const;
        return [identity, payload.totalRows] as const;
      } catch {
        return [identity, null] as const;
      }
    },
  );
  return new Map(loaded);
}

