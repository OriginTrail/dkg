// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
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
  const workspaceGraphCounts = ASSET_NUMBERS.map((kaNumber) => ({
    kaNumber,
    swm: UPDATED_PROJECTION_EVIDENCE.count,
    swmDigest: UPDATED_PROJECTION_EVIDENCE.digest,
    swmGraph: `swm:${kaNumber}`,
    swmProof: {
      kind: 'workspace-head',
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
  assert.equal(hasExactSourceSwmContents({ graphCounts: workspaceGraphCounts }), true);
  assert.equal(hasExactMemoryContents(
    { graphCounts: workspaceGraphCounts },
    { swmProofKind: 'workspace-head' },
  ), true);
  assert.equal(hasExactMemoryContents({ graphCounts: workspaceGraphCounts }), false);
  const corruptions = [
    (evidence) => ({
      ...evidence,
      swmProof: { ...evidence.swmProof, assertionVersion: '1' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionVersion: '2' },
    }),
    (evidence) => ({
      ...evidence,
      swmProof: { ...evidence.swmProof, assertionGraph: 'urn:wrong:swm' },
    }),
    (evidence) => ({
      ...evidence,
      vmHead: { ...evidence.vmHead, assertionGraph: 'urn:wrong:vm' },
    }),
    (evidence) => ({
      ...evidence,
      swmProof: { ...evidence.swmProof, shareOperationId: 'wrong-operation' },
    }),
    (evidence) => ({ ...evidence, swmDigest: PROJECTION_EVIDENCE.digest }),
  ];
  for (const corrupt of corruptions) {
    assert.equal(hasExactMemoryContents({
      graphCounts: workspaceGraphCounts.map((evidence, index) => (
        index === 0 ? corrupt(evidence) : evidence
      )),
    }, { swmProofKind: 'workspace-head' }), false);
  }

  const appliedHeadDigest = `0x${'ab'.repeat(32)}`;
  const catalogGraphCounts = workspaceGraphCounts.map((evidence) => ({
    ...evidence,
    swmProof: {
      kind: 'catalog-row',
      assertionVersion: '2',
      catalogHeadDigest: appliedHeadDigest,
      kaId: ((BigInt(roleAgentAddress('owner')) << 96n) | BigInt(evidence.kaNumber))
        .toString(),
      projectionDigest: PRIVATE_CATALOG_MEMORY_EXPECTATION.swm.catalogProjectionDigest,
    },
  }));
  const productionState = {
    appliedHeadDigest,
    catalogVersion: '4',
    exactExpectedHead: true,
    graphCounts: catalogGraphCounts,
  };
  assert.equal(hasExactMemoryContents(productionState), true);
  const {
    projectionDigest: _missingProjectionDigest,
    ...missingProjectionDigest
  } = catalogGraphCounts[0].swmProof;
  for (const swmProof of [
    { kind: 'absent' },
    { ...catalogGraphCounts[0].swmProof, assertionVersion: '1' },
    { ...catalogGraphCounts[0].swmProof, catalogHeadDigest: `0x${'cd'.repeat(32)}` },
    { ...catalogGraphCounts[0].swmProof, kaId: '1' },
    { ...catalogGraphCounts[0].swmProof, kind: 'workspace-head' },
    { ...catalogGraphCounts[0].swmProof, projectionDigest: `0x${'00'.repeat(32)}` },
    missingProjectionDigest,
    { ...catalogGraphCounts[0].swmProof, assertionGraph: 'urn:mixed-proof' },
  ]) {
    assert.equal(hasExactMemoryContents({
      ...productionState,
      graphCounts: catalogGraphCounts.map((evidence, index) => (
        index === 0 ? { ...evidence, swmProof } : evidence
      )),
    }), false);
  }
  for (const graphCounts of [
    catalogGraphCounts.slice(0, 1),
    [catalogGraphCounts[0], catalogGraphCounts[0]],
    [...catalogGraphCounts, { ...catalogGraphCounts[0], kaNumber: 43 }],
  ]) {
    assert.equal(hasExactMemoryContents({ ...productionState, graphCounts }), false);
  }

  assert.equal(parsePrivateCatalogLiteralEvidenceV1('"line\\nvalue"'), 'line\nvalue');
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('"unterminated'), null);
  assert.equal(parsePrivateCatalogLiteralEvidenceV1('urn:not-a-literal'), null);

  const store = new OxigraphStore();
  const authorAddress = roleAgentAddress('owner');
  try {
    await seedExpectedPrivateMemoryV1(store);
    const storeEvidence = await readExpectedPrivateMemoryV1(store);
    assert.equal(hasExactMemoryContents(
      { graphCounts: storeEvidence },
      { swmProofKind: 'workspace-head' },
    ), true);
    await assert.rejects(
      readPrivateCatalogGraphCountEvidence(store, {
        assetNumbers: ASSET_NUMBERS,
        authorAddress,
        contextGraphId: CONTEXT_GRAPH_ID,
      }),
      /networkId is required/u,
    );
    await assert.rejects(
      readPrivateCatalogGraphCountEvidence(store, {
        assetNumbers: ASSET_NUMBERS,
        authorAddress,
        catalogClosure: {},
        contextGraphId: CONTEXT_GRAPH_ID,
        networkId: NETWORK_ID,
        swmProofMode: 'catalog-row',
      }),
      /not verifier-minted/u,
    );
  } finally {
    await store.close();
  }
});
