// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  PROJECTION_EVIDENCE,
  UPDATED_PROJECTION_EVIDENCE,
  privateCatalogSwmShareOperationId,
  roleAgentAddress,
} from './fixture.mjs';
import {
  EXPECTED_MEMORY_CONTENTS,
  hasExactMemoryContents,
  hasExactSourceSwmContents,
} from './run.mjs';
import {
  parsePrivateCatalogLiteralEvidenceV1,
  readPrivateCatalogGraphCountEvidence,
} from './memory-evidence.mjs';
import {
  readExpectedPrivateMemoryV1,
  seedExpectedPrivateMemoryV1,
} from './fixtures/private-memory-fixture.mjs';

test('memory evidence distinguishes finalized VM v1 from newer SWM v2', async () => {
  const graphCounts = ASSET_NUMBERS.map((kaNumber) => ({
    kaNumber,
    swm: UPDATED_PROJECTION_EVIDENCE.count,
    swmDigest: UPDATED_PROJECTION_EVIDENCE.digest,
    swmGraph: `swm:${kaNumber}`,
    swmHead: {
      assertionVersion: '2',
      assertionGraph: `swm:${kaNumber}`,
      shareOperationId: privateCatalogSwmShareOperationId(kaNumber),
    },
    vm: PROJECTION_EVIDENCE.count,
    vmDigest: PROJECTION_EVIDENCE.digest,
    vmGraph: `vm:${kaNumber}`,
    vmHead: {
      assertionVersion: '1',
      assertionGraph: `vm:${kaNumber}`,
    },
  }));
  assert.equal(EXPECTED_MEMORY_CONTENTS.swm.assertionVersion, '2');
  assert.equal(EXPECTED_MEMORY_CONTENTS.vm.assertionVersion, '1');
  assert.equal(EXPECTED_MEMORY_CONTENTS, PRIVATE_CATALOG_MEMORY_EXPECTATION);
  assert.equal(hasExactSourceSwmContents({ graphCounts }), true);
  assert.equal(hasExactMemoryContents({ graphCounts }), true);
  const corruptions = [
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, assertionVersion: '1' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionVersion: '2' },
    }),
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, assertionGraph: 'urn:wrong:swm' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionGraph: 'urn:wrong:vm' },
    }),
    (evidence) => ({
      ...evidence,
      swmHead: { ...evidence.swmHead, shareOperationId: 'wrong-operation' },
    }),
    (evidence) => ({ ...evidence, swmDigest: PROJECTION_EVIDENCE.digest }),
  ];
  for (const corrupt of corruptions) {
    assert.equal(hasExactMemoryContents({
      graphCounts: graphCounts.map((evidence, index) => (
        index === 0 ? corrupt(evidence) : evidence
      )),
    }), false);
  }

  assert.equal(parsePrivateCatalogLiteralEvidenceV1('"line\\nvalue"'), 'line\nvalue');
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('"unterminated'), null);
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('urn:not-a-literal'), null);

  const store = new OxigraphStore();
  const authorAddress = roleAgentAddress('owner');
  try {
    await seedExpectedPrivateMemoryV1(store);
    const storeEvidence = await readExpectedPrivateMemoryV1(store);
    assert.equal(hasExactMemoryContents({ graphCounts: storeEvidence }), true);
    await assert.rejects(
      readPrivateCatalogGraphCountEvidence(store, {
        assetNumbers: ASSET_NUMBERS,
        authorAddress,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
      /networkId is required/u,
    );
  } finally {
    await store.close();
  }
});
