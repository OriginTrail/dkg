import {
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  projectRfc64OperationalRowCountsV1,
  rfc64CatalogTargetExactIdentityKeyV1,
} from '../src/dkg-agent-rfc64-catalog.js';
import {
  rfc64CatalogTargetScopeKeyV1,
  type Rfc64OperationalAppliedHeadV1,
} from '../src/rfc64/catalog-operational-applied-heads-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID = (
  '0x1111111111111111111111111111111111111111/row-projection'
) as ContextGraphIdV1;
const AUTHOR = `0x${'22'.repeat(20)}` as EvmAddressV1;

function catalogTarget(
  catalogVersion: string,
  headDigestByte: string,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogEra: '0',
    catalogVersion,
    policyDigest: `0x${'71'.repeat(32)}` as Digest32V1,
    catalogHeadObjectDigest: `0x${headDigestByte.repeat(32)}` as Digest32V1,
    signatureVariantDigest: `0x${'99'.repeat(32)}` as Digest32V1,
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
}

function appliedHead(
  catalogVersion: string,
  headDigestByte: string,
  inventoryRowCount: string,
): Readonly<Rfc64OperationalAppliedHeadV1> {
  return Object.freeze({
    snapshot: {
      catalogScopeDigest: `0x${'01'.repeat(32)}`,
      authorAddress: AUTHOR,
      currentCatalogHeadDigest: `0x${headDigestByte.repeat(32)}`,
      appliedInventoryDigest: `0x${'02'.repeat(32)}`,
      catalogVersion,
      inventoryRowCount,
    },
    issuedAt: '0',
    contextGraphId: CONTEXT_GRAPH_ID,
    scopeKey: rfc64CatalogTargetScopeKeyV1(catalogTarget(catalogVersion, headDigestByte)),
  }) as unknown as Readonly<Rfc64OperationalAppliedHeadV1>;
}

describe('projectRfc64OperationalRowCountsV1', () => {
  it('projects the newest head per scope whatever order a superseded fork arrives in', () => {
    const heads = [appliedHead('5', 'aa', '10')];
    const supersededFork = catalogTarget('5', 'bb');
    const newest = catalogTarget('7', 'cc');
    const promisedRowCounts = new Map([
      [rfc64CatalogTargetExactIdentityKeyV1(newest), '20'],
    ]);

    // `authoritativeTargets` keeps insertion order and the promised half
    // arrives in peer-completion order, so both orders are reachable for the
    // same state and must project the same pair.
    expect(projectRfc64OperationalRowCountsV1(
      heads,
      [supersededFork, newest],
      promisedRowCounts,
    )).toEqual({ expectedRowCount: '20', missingRowCount: '10' });
    expect(projectRfc64OperationalRowCountsV1(
      heads,
      [newest, supersededFork],
      promisedRowCounts,
    )).toEqual({ expectedRowCount: '20', missingRowCount: '10' });
  });

  it('reports a fork at the newest version as ambiguous in either order', () => {
    const heads = [appliedHead('5', 'aa', '10')];
    const left = catalogTarget('7', 'bb');
    const right = catalogTarget('7', 'cc');
    const promisedRowCounts = new Map([
      [rfc64CatalogTargetExactIdentityKeyV1(left), '20'],
      [rfc64CatalogTargetExactIdentityKeyV1(right), '30'],
    ]);

    expect(projectRfc64OperationalRowCountsV1(heads, [left, right], promisedRowCounts))
      .toEqual({ expectedRowCount: null, missingRowCount: null });
    expect(projectRfc64OperationalRowCountsV1(heads, [right, left], promisedRowCounts))
      .toEqual({ expectedRowCount: null, missingRowCount: null });
  });
});
