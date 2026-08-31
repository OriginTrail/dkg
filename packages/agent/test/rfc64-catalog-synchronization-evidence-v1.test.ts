// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { Digest32V1 } from '@origintrail-official/dkg-core';

import {
  reduceRfc64CatalogSynchronizationEvidenceReplayV1,
  snapshotRfc64CatalogSynchronizationEvidenceV1,
} from
  '../src/rfc64/catalog-synchronization-evidence-v1.js';
import type { Rfc64FinalizedSwmRetirementLifecycleReceiptV2 } from
  '../src/rfc64/finalized-swm-retirement-lifecycle-receipt-v1.js';

const digest = (byte: string): Digest32V1 => `0x${byte.repeat(32)}` as Digest32V1;

function receipt(
  kaUal = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1',
) {
  return {
    kind: 'rfc64-finalized-swm-retirement-lifecycle-receipt-v2' as const,
    contextGraphId: 'private-evidence-v1',
    kaUal,
    assertionVersion: '1',
    vmGraphIri: 'did:dkg:context-graph:private-evidence-v1/ka/1/vm',
    vmPostReadDigest: digest('33'),
    vmMaterializationStatus: 'materialized' as const,
    swmReconciliationOutcome: 'retired' as const,
  } satisfies Rfc64FinalizedSwmRetirementLifecycleReceiptV2;
}

function evidence(
  receipts: readonly Rfc64FinalizedSwmRetirementLifecycleReceiptV2[],
  committedCatalogHeadDigest = digest('11'),
) {
  return {
    inventoryDigest: digest('22'),
    catalogHeadDigest: digest('11'),
    inventoryRowCount: 0 as const,
    activatedTripleCount: 0 as const,
    stagedObjectCount: 3 as const,
    appliedHeadStatus: 'applied' as const,
    postAppliedHeadExtension: {
      kind: 'rfc64-catalog-applied-head-evidence-v1',
      committedHead: {
        kind: 'rfc64-public-catalog-native-committed-head-token-v1' as const,
        catalogHeadDigest: committedCatalogHeadDigest,
        inventoryDigest: digest('22'),
      },
      finalizedSwmRetirementLifecycleReceipts: receipts,
    },
  };
}

describe('RFC-64 catalog synchronization evidence', () => {
  it('snapshots immutable receipts owned by the exact synchronization head', () => {
    const source = receipt();
    const snapshot = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence([source]));

    source.kaUal = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2';

    expect(snapshot.finalizedSwmRetirementLifecycleReceipts).toEqual([expect.objectContaining({
      kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1',
    })]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.finalizedSwmRetirementLifecycleReceipts)).toBe(true);
    expect(Object.isFrozen(snapshot.finalizedSwmRetirementLifecycleReceipts[0])).toBe(true);
  });

  it('rejects applied-head evidence associated with a different synchronization head', () => {
    expect(() => snapshotRfc64CatalogSynchronizationEvidenceV1(
      evidence([receipt()], digest('44')),
    )).toThrow('applied-head evidence differs from its synchronization evidence head');
  });

  it('rejects duplicate per-KA lifecycle receipts', () => {
    const same = receipt();
    expect(() => snapshotRfc64CatalogSynchronizationEvidenceV1(
      evidence([same, receipt()]),
    )).toThrow('duplicates receipt');
  });

  it('preserves original materialization proof across an exact-head replay', () => {
    const first = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence([receipt()]));
    const replayReceipt = {
      ...receipt(),
      vmMaterializationStatus: 'existing' as const,
      swmReconciliationOutcome: 'already-retired-finalized' as const,
    };
    const replay = reduceRfc64CatalogSynchronizationEvidenceReplayV1(
      first,
      snapshotRfc64CatalogSynchronizationEvidenceV1(
        { ...evidence([replayReceipt]), appliedHeadStatus: 'existing' as const },
      ),
    );

    expect(replay.appliedHeadStatus).toBe('existing');
    expect(replay.finalizedSwmRetirementLifecycleReceipts).toEqual([
      expect.objectContaining({
        vmMaterializationStatus: 'materialized',
        swmReconciliationOutcome: 'retired',
      }),
    ]);
  });

  it.each([
    ['content mismatch', { swmReconciliationOutcome: 'content-mismatch' as const }],
    ['VM change', { swmReconciliationOutcome: 'vm-changed' as const }],
    ['head-version mismatch', { swmReconciliationOutcome: 'head-version-mismatch' as const }],
    ['VM metadata mismatch', { swmReconciliationOutcome: 'vm-metadata-mismatch' as const }],
    ['receipt metadata mismatch', { assertionVersion: '2' }],
    ['post-read mismatch', { vmPostReadDigest: digest('55') }],
  ])('keeps current %s evidence visible instead of retaining stale success', (_label, change) => {
    const first = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence([receipt()]));
    const currentReceipt = {
      ...receipt(),
      vmMaterializationStatus: 'existing' as const,
      swmReconciliationOutcome: 'already-retired-finalized' as const,
      ...change,
    };
    const current = snapshotRfc64CatalogSynchronizationEvidenceV1({
      ...evidence([currentReceipt]),
      appliedHeadStatus: 'existing' as const,
    });

    const reduced = reduceRfc64CatalogSynchronizationEvidenceReplayV1(first, current);

    expect(reduced.finalizedSwmRetirementLifecycleReceipts).toEqual([currentReceipt]);
  });

  it('rejects replay accumulation across different synchronization heads', () => {
    const first = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence([receipt()]));
    const otherHead = digest('66');
    const current = snapshotRfc64CatalogSynchronizationEvidenceV1({
      ...evidence([receipt()], otherHead),
      catalogHeadDigest: otherHead,
      appliedHeadStatus: 'existing' as const,
    });

    expect(() => reduceRfc64CatalogSynchronizationEvidenceReplayV1(first, current))
      .toThrow('belongs to a different head');
  });

  it('uses a repaired rematerialization receipt as the new current proof', () => {
    const first = snapshotRfc64CatalogSynchronizationEvidenceV1(evidence([receipt()]));
    const rematerializedReceipt = {
      ...receipt(),
      vmPostReadDigest: digest('77'),
    };
    const current = snapshotRfc64CatalogSynchronizationEvidenceV1({
      ...evidence([rematerializedReceipt]),
      appliedHeadStatus: 'existing' as const,
    });

    expect(reduceRfc64CatalogSynchronizationEvidenceReplayV1(first, current)
      .finalizedSwmRetirementLifecycleReceipts).toEqual([rematerializedReceipt]);
  });
});
