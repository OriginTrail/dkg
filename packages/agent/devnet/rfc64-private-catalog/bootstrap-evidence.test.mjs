// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';

import {
  composeBootstrapEvidenceV1,
  runRfc64PrivateBootstrapRetryLoopV1,
} from './catalog-evidence-handlers.mjs';
import {
  createPrivateCatalogScope,
  createPrivateCatalogSyncScope,
  createPrivatePolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  assertAuthorityEvidenceParityV1,
  assertInitialFinalizedAuthorityV1,
} from './initial-authority.mjs';

const PROTOCOL_TEST_DIGEST = `0x${'ab'.repeat(32)}`;

test('publication and synchronization derive the exact canonical catalog scope', () => {
  const scope = createPrivateCatalogScope();
  const syncScope = createPrivateCatalogSyncScope();
  assert.equal(
    computeAuthorCatalogScopeDigestV1(scope),
    '0x7dbdfe9c09c959661b0d26d5353d14e55336429a26d75da593f9ca680d127f52',
  );
  assert.deepEqual(syncScope, {
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogEra: scope.era,
  });
});

test('bootstrap evidence preserves already-applied provider nullability', () => {
  const common = {
    currentCatalogHeadDigest: PROTOCOL_TEST_DIGEST,
    catalogVersion: '2',
    inventoryRowCount: '2',
  };
  assert.deepEqual(composeBootstrapEvidenceV1({
    ...common,
    completionOutcome: 'applied',
    appliedProviderPeerId: 'provider-peer',
  }, 1, 'provider-peer'), {
    outcome: 'applied',
    providerPeerId: 'provider-peer',
    appliedTransferProviderPeerId: 'provider-peer',
    appliedHeadDigest: PROTOCOL_TEST_DIGEST,
    catalogVersion: '2',
    inventoryRowCount: '2',
    attempts: 1,
  });
  assert.deepEqual(composeBootstrapEvidenceV1({
    ...common,
    completionOutcome: 'already-applied',
    appliedProviderPeerId: null,
  }, 2, 'provider-peer'), {
    outcome: 'already-applied',
    providerPeerId: null,
    appliedTransferProviderPeerId: null,
    appliedHeadDigest: PROTOCOL_TEST_DIGEST,
    catalogVersion: '2',
    inventoryRowCount: '2',
    attempts: 2,
  });
  assert.deepEqual(composeBootstrapEvidenceV1({
    ...common,
    completionOutcome: 'already-applied',
    appliedProviderPeerId: null,
  }, 3, 'provider-peer', 'provider-peer'), {
    outcome: 'already-applied',
    providerPeerId: null,
    appliedTransferProviderPeerId: 'provider-peer',
    appliedHeadDigest: PROTOCOL_TEST_DIGEST,
    catalogVersion: '2',
    inventoryRowCount: '2',
    attempts: 3,
  });
  for (const result of [
    { ...common, completionOutcome: 'applied', appliedProviderPeerId: null },
    { ...common, completionOutcome: 'applied', appliedProviderPeerId: 'different-peer' },
    { ...common, completionOutcome: 'already-applied', appliedProviderPeerId: 'provider-peer' },
  ]) {
    assert.throws(
      () => composeBootstrapEvidenceV1(result, 1, 'provider-peer'),
      /inconsistent provider provenance/u,
    );
  }
  assert.throws(
    () => composeBootstrapEvidenceV1({
      ...common,
      completionOutcome: 'already-applied',
      appliedProviderPeerId: null,
    }, 1, 'provider-peer', 'different-peer'),
    /inconsistent applied-transfer provenance/u,
  );
});

test('bootstrap retry defers strict memory proof until synchronization succeeds', async () => {
  const transientFailure = new Error('transient provider failure');
  const synchronized = Object.freeze({ completionOutcome: 'applied' });
  let attempts = 0;
  let proofReads = 0;
  const result = await runRfc64PrivateBootstrapRetryLoopV1({
    timeoutMs: 1_000,
    synchronize: async () => {
      attempts += 1;
      if (attempts === 1) throw transientFailure;
      return synchronized;
    },
    isSynchronized: (candidate) => candidate?.error === undefined,
    verify: async (candidate) => {
      proofReads += 1;
      assert.equal(candidate, synchronized);
      return true;
    },
    wait: async () => {},
  });

  assert.deepEqual(result, { accepted: true, attempts: 2, last: synchronized });
  assert.equal(proofReads, 1);
});

test('initial authority rejects a finalized-chain roster fault before readiness', () => {
  const expected = createPrivatePolicyAndRoster();
  const expectedAuthority = {
    policy: expected.policy,
    policyDigest: expected.policyDigest,
    roster: expected.roster,
    source: 'finalized-chain',
  };
  assert.doesNotThrow(() => assertInitialFinalizedAuthorityV1({
    acceptedAuthority: expectedAuthority,
    finalizedAuthority: expectedAuthority,
    expectedAuthority,
  }));
  const sourceMismatch = {
    ...expectedAuthority,
    policy: {
      ...expectedAuthority.policy,
      source: {
        ...expectedAuthority.policy.source,
        blockHash: `0x${'00'.repeat(32)}`,
      },
    },
  };
  assert.throws(
    () => assertInitialFinalizedAuthorityV1({
      acceptedAuthority: expectedAuthority,
      finalizedAuthority: sourceMismatch,
      expectedAuthority,
    }),
    /differs from the finalized chain snapshot/u,
  );
  const finalizedAuthority = {
    ...expectedAuthority,
    roster: {
      ...expected.roster,
      members: expected.roster.members.filter(
        ({ agentAddress }) => agentAddress !== roleAgentAddress('receiver'),
      ),
    },
  };
  assert.throws(
    () => assertInitialFinalizedAuthorityV1({
      acceptedAuthority: expectedAuthority,
      finalizedAuthority,
      expectedAuthority,
    }),
    /differs from the finalized chain snapshot/u,
  );
  const laterGeneration = {
    ...expectedAuthority,
    roster: { ...expectedAuthority.roster, version: '10000000000000' },
  };
  assert.throws(
    () => assertAuthorityEvidenceParityV1({
      actual: laterGeneration,
      expected: expectedAuthority,
      message: 'test authority mismatch',
    }),
    /test authority mismatch/u,
  );
  assert.doesNotThrow(() => assertAuthorityEvidenceParityV1({
    actual: laterGeneration,
    expected: expectedAuthority,
    expectedRosterVersion: laterGeneration.roster.version,
    message: 'test authority mismatch',
  }));
});
