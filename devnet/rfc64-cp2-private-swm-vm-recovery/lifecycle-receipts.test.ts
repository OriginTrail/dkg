import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertColdMaterializedVmReceiptV1,
  computeFinalizedVmPostReadDigestV1,
  computeFinalizedVmPostReadDigestFromHarnessReadbackV1,
  decodeRetirementLifecycleReceiptsV1,
} from './lifecycle-receipts.ts';

const HEAD = `0x${'11'.repeat(32)}`;
const INVENTORY = `0x${'22'.repeat(32)}`;
const POST_READ = `0x${'33'.repeat(32)}`;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v1',
    catalogHeadDigest: HEAD,
    inventoryDigest: INVENTORY,
    contextGraphId: '0x1111111111111111111111111111111111111111/private',
    subGraphName: 'member-slice',
    kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1',
    assertionVersion: '1',
    vmGraphIri: 'urn:dkg:vm:1',
    vmPostReadDigest: POST_READ,
    vmMaterializationStatus: 'materialized',
    committedHead: {
      kind: 'rfc64-public-catalog-native-committed-head-token-v1',
      catalogHeadDigest: HEAD,
      inventoryDigest: INVENTORY,
    },
    swmReconciliationOutcome: 'retired',
    ...overrides,
  };
}

describe('private retirement lifecycle receipt decoder', () => {
  it('preserves every modeled field and builds a deterministic UAL index', () => {
    const second = receipt({
      kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2',
    });
    const decoded = decodeRetirementLifecycleReceiptsV1([receipt(), second]);
    assert.deepEqual(decoded.receipts, [receipt(), second]);
    assert.equal(decoded.byUal.get(receipt().kaUal)?.subGraphName, 'member-slice');
    assert.equal(Object.isFrozen(decoded.receipts), true);
    assert.equal(Object.isFrozen(decoded.receipts[0]?.committedHead), true);
  });

  it('rejects malformed, duplicate, out-of-order, and invalid committed-head evidence', () => {
    assert.throws(() => decodeRetirementLifecycleReceiptsV1({}), /bounded array/u);
    assert.throws(
      () => decodeRetirementLifecycleReceiptsV1([receipt(), receipt()]),
      /duplicates/u,
    );
    assert.throws(
      () => decodeRetirementLifecycleReceiptsV1([
        receipt({ kaUal: 'did:dkg:otp:20430/0x1/2' }),
        receipt({ kaUal: 'did:dkg:otp:20430/0x1/1' }),
      ]),
      /out of canonical UAL order/u,
    );
    assert.throws(
      () => decodeRetirementLifecycleReceiptsV1([receipt({
        committedHead: { kind: 'wrong', catalogHeadDigest: HEAD, inventoryDigest: INVENTORY },
      })]),
      /committed-head kind is invalid/u,
    );
  });

  it('binds the digest contract to exact canonical projection bytes', () => {
    const projection = '<urn:s> <urn:p> "value" .';
    assert.match(computeFinalizedVmPostReadDigestV1(projection), /^0x[0-9a-f]{64}$/u);
    assert.equal(
      computeFinalizedVmPostReadDigestFromHarnessReadbackV1(`${projection}\n`),
      computeFinalizedVmPostReadDigestV1(projection),
    );
    assert.notEqual(
      computeFinalizedVmPostReadDigestV1(projection),
      computeFinalizedVmPostReadDigestV1(`${projection}\n`),
    );
    assert.throws(
      () => computeFinalizedVmPostReadDigestFromHarnessReadbackV1(`${projection}\n\n`),
      /exactly one trailing LF/u,
    );
  });

  it('rejects stale status and wrong digest as cold-receiver lifecycle proof', () => {
    const projection = '<urn:s> <urn:p> "value" .\n';
    const valid = decodeRetirementLifecycleReceiptsV1([receipt({
      vmPostReadDigest: computeFinalizedVmPostReadDigestFromHarnessReadbackV1(projection),
    })]).receipts[0];
    assert.ok(valid);
    assert.doesNotThrow(() => assertColdMaterializedVmReceiptV1(valid, projection));
    assert.throws(
      () => assertColdMaterializedVmReceiptV1(
        { ...valid, vmMaterializationStatus: 'existing' },
        projection,
      ),
      /did not materialize/u,
    );
    assert.throws(
      () => assertColdMaterializedVmReceiptV1(
        {
          ...valid,
          vmPostReadDigest: computeFinalizedVmPostReadDigestV1(`${projection}\n`),
        },
        projection,
      ),
      /post-read digest differs/u,
    );
  });
});
