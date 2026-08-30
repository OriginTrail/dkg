import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Digest32V1 } from '@origintrail-official/dkg-core';

import {
  assertPrivateColdRetirementLifecycleV1,
  computeFinalizedVmPostReadDigestV1,
  computeFinalizedVmPostReadDigestFromHarnessReadbackV1,
} from './lifecycle-receipts.ts';

const HEAD = `0x${'11'.repeat(32)}` as Digest32V1;
const INVENTORY = `0x${'22'.repeat(32)}` as Digest32V1;
const CONTEXT_GRAPH = '0x1111111111111111111111111111111111111111/private';
const UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
const VM_GRAPH = 'urn:dkg:vm:1';
const PROJECTION = '<urn:s> <urn:p> "value" .\n';
const FIXED_POST_READ_DIGEST =
  '0xacc5e282bd297a4e0a9039f00cf699e500b0d0c7992b28133693cd3b1a95be00';

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
    committedHead: {
      kind: 'rfc64-public-catalog-native-committed-head-token-v1',
      catalogHeadDigest: HEAD,
      inventoryDigest: INVENTORY,
    },
    contextGraphId: CONTEXT_GRAPH,
    kaUal: UAL,
    assertionVersion: '1',
    vmGraphIri: VM_GRAPH,
    vmPostReadDigest: FIXED_POST_READ_DIGEST,
    vmMaterializationStatus: 'materialized',
    swmReconciliationOutcome: 'retired',
    ...overrides,
  };
}

function expected() {
  return {
    catalogHeadDigest: HEAD,
    inventoryDigest: INVENTORY,
    contextGraphId: CONTEXT_GRAPH,
    byUal: new Map([[UAL, {
      assertionVersion: '1',
      vmGraphIri: VM_GRAPH,
      lineFramedProjectionNQuads: PROJECTION,
    }]]),
  };
}

describe('private cold retirement lifecycle certification', () => {
  it('pins the exact domain-separated Keccak-256 digest contract', () => {
    assert.equal(
      computeFinalizedVmPostReadDigestV1(PROJECTION.slice(0, -1)),
      FIXED_POST_READ_DIGEST,
    );
    assert.equal(
      computeFinalizedVmPostReadDigestFromHarnessReadbackV1(PROJECTION),
      FIXED_POST_READ_DIGEST,
    );
    assert.notEqual(
      computeFinalizedVmPostReadDigestV1(PROJECTION),
      FIXED_POST_READ_DIGEST,
    );
  });

  it('accepts and freezes only the exact cold root-lane PASS evidence', () => {
    const decoded = assertPrivateColdRetirementLifecycleV1([receipt()], expected());
    assert.deepEqual(decoded.receipts, [receipt()]);
    assert.equal(decoded.byUal.get(UAL)?.vmGraphIri, VM_GRAPH);
    assert.equal(Object.isFrozen(decoded.receipts), true);
    assert.equal(Object.isFrozen(decoded.receipts[0]?.committedHead), true);
  });

  it('rejects malformed, duplicate, out-of-order, and non-root evidence', () => {
    assert.throws(
      () => assertPrivateColdRetirementLifecycleV1({}, expected()),
      /exact bounded asset set/u,
    );
    const secondUal = `${UAL.slice(0, -1)}2`;
    const twoExpected = {
      ...expected(),
      byUal: new Map([
        [UAL, expected().byUal.get(UAL)!],
        [secondUal, { ...expected().byUal.get(UAL)!, vmGraphIri: 'urn:dkg:vm:2' }],
      ]),
    };
    assert.throws(
      () => assertPrivateColdRetirementLifecycleV1([receipt(), receipt()], twoExpected),
      /unexpected or duplicate KA UAL/u,
    );
    assert.throws(
      () => assertPrivateColdRetirementLifecycleV1(
        [receipt({ kaUal: secondUal, vmGraphIri: 'urn:dkg:vm:2' }), receipt()],
        twoExpected,
      ),
      /canonical UAL order/u,
    );
    assert.throws(
      () => assertPrivateColdRetirementLifecycleV1(
        [receipt({ subGraphName: 'unrelated-slice' })],
        expected(),
      ),
      /unexpected or missing fields/u,
    );
  });

  it('rejects every lifecycle state that cannot certify CP2 PASS', () => {
    const invalid = [
      { committedHead: { ...receipt().committedHead, catalogHeadDigest: `0x${'44'.repeat(32)}` } },
      { committedHead: { ...receipt().committedHead, inventoryDigest: `0x${'55'.repeat(32)}` } },
      { contextGraphId: 'different-private-context' },
      { assertionVersion: '2' },
      { vmGraphIri: 'urn:dkg:vm:different' },
      { vmPostReadDigest: `0x${'66'.repeat(32)}` },
      { vmMaterializationStatus: 'existing' },
      { swmReconciliationOutcome: 'already-retired-finalized' },
      { swmReconciliationOutcome: 'vm-changed' },
    ];
    for (const mutation of invalid) {
      assert.throws(
        () => assertPrivateColdRetirementLifecycleV1([receipt(mutation)], expected()),
      );
    }
    assert.throws(
      () => computeFinalizedVmPostReadDigestFromHarnessReadbackV1(`${PROJECTION}\n`),
      /exactly one trailing LF/u,
    );
  });
});
