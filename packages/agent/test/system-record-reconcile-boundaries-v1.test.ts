import { peerIdFromMultihash } from '@libp2p/peer-id';
import { describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_RECORD_MAX_CONTINUATION_SLICES,
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordStableKeyHashV1,
  encodeInventoryRowBase64UrlV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  createAgentProfileAdmittedSliceContextAuthorityV1,
} from '../src/system-records/admitted-slice-context-v1.js';
import {
  createAgentProfileReconcilerV1,
  type AgentProfileInventoryLoadRequestV1,
  type AgentProfileReconcileAdmissionV1,
} from '../src/system-records/reconcile-v1.js';
import {
  admissionGate,
  NETWORK,
  publishedFixture,
  receiverWithPreparation,
  signRootDescriptor,
} from './support/system-record-reconcile-v1-fixture.js';

function deterministicPeerIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const rawKey = new Uint8Array(32);
    new DataView(rawKey.buffer).setUint32(28, index + 1, false);
    const encodedPublicKey = new Uint8Array(36);
    encodedPublicKey.set([0x08, 0x01, 0x12, 0x20]);
    encodedPublicKey.set(rawKey, 4);
    const multihashBytes = new Uint8Array(38);
    multihashBytes.set([0x00, encodedPublicKey.byteLength]);
    multihashBytes.set(encodedPublicKey, 2);
    return peerIdFromMultihash({
      code: 0x00,
      size: encodedPublicKey.byteLength,
      digest: encodedPublicKey,
      bytes: multihashBytes,
    }).toString();
  });
}

describe('agent-profile System Record reconciler boundaries V1', () => {
  it('blocks the next slice after the physical continuation slice cap', async () => {
    const fixture = await publishedFixture();
    const contextAuthority = createAgentProfileAdmittedSliceContextAuthorityV1(() => 0);
    const inspections = new WeakMap<object, number>();
    let acquisitions = 0;
    const admission: AgentProfileReconcileAdmissionV1 = Object.freeze({
      tryAcquire() {
        acquisitions += 1;
        const context = contextAuthority.mint(3_000);
        inspections.set(context, 0);
        return Object.freeze({
          admittedContext: context,
          release: () => contextAuthority.revoke(context),
        });
      },
      inspectAdmittedContext(context) {
        const inspection = inspections.get(context);
        if (inspection === undefined) throw new Error('unknown test admission context');
        inspections.set(context, inspection + 1);
        return Object.freeze({
          nowMs: inspection === 0 ? 0 : 3_000,
          admittedDeadlineMs: 3_000,
        });
      },
    });
    const loadInventoryObject = vi.fn();
    const prepareActive = vi.fn();
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject,
      receiver: receiverWithPreparation(prepareActive),
    });
    const signal = new AbortController().signal;

    for (let slice = 0; slice < SYSTEM_RECORD_MAX_CONTINUATION_SLICES; slice += 1) {
      await expect(reconciler.advance(signal)).resolves.toMatchObject({
        status: 'paused',
        phase: 'inventory',
        inventoryRequests: 0,
      });
    }
    await expect(reconciler.advance(signal)).resolves.toMatchObject({
      status: 'blocked',
      phase: 'inventory',
      reason: 'continuation-limit',
      inventoryRequests: 0,
    });
    expect(acquisitions).toBe(SYSTEM_RECORD_MAX_CONTINUATION_SLICES + 1);
    expect(loadInventoryObject).not.toHaveBeenCalled();
    expect(prepareActive).not.toHaveBeenCalled();
    expect(reconciler.stats()).toMatchObject({
      admittedSlices: SYSTEM_RECORD_MAX_CONTINUATION_SLICES + 1,
      advances: SYSTEM_RECORD_MAX_CONTINUATION_SLICES,
    });
  });

  it('accepts a real ambiguous internal root from a digest-addressed loader', async () => {
    const fixture = await publishedFixture();
    const headEnvelope = fixture.store.snapshot().currentHead;
    if (headEnvelope === null) throw new Error('fixture active head was not retained');
    const rows = deterministicPeerIds(256).map((peerId): SystemRecordInventoryRowV1 => ({
      stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, peerId),
      peerId,
      authoritySequence: headEnvelope.object.authoritySequence,
      version: headEnvelope.object.version,
      headDigest: headEnvelope.objectDigest,
      tombstone: false,
      quarantined: false,
    })).sort((left, right) => left.stableKeyHash.localeCompare(right.stableKeyHash));
    const objects = new Map<string, Readonly<{
      objectKind: 'inventory-internal' | 'inventory-leaf';
      canonicalBytes: Uint8Array;
    }>>();
    const leaves = [rows.slice(0, 128), rows.slice(128)].map((leafRows) => {
      const leaf: SystemRecordInventoryLeafObjectV1 = Object.freeze({
        objectType: 'inventory-leaf',
        firstKeyHash: leafRows[0]!.stableKeyHash,
        lastKeyHash: leafRows.at(-1)!.stableKeyHash,
        rows: Object.freeze(leafRows.map((row) => encodeInventoryRowBase64UrlV1(NETWORK, row))),
      });
      const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(
        leaf,
        NETWORK,
        false,
      );
      const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, false);
      objects.set(digest, Object.freeze({ objectKind: 'inventory-leaf', canonicalBytes }));
      return Object.freeze({ leaf, digest });
    });
    const root: SystemRecordInventoryInternalObjectV1 = Object.freeze({
      objectType: 'inventory-internal',
      firstKeyHash: leaves[0]!.leaf.firstKeyHash,
      lastKeyHash: leaves[1]!.leaf.lastKeyHash,
      entries: Object.freeze(leaves.map(({ leaf, digest }) => Object.freeze({
        separatorKeyHash: leaf.firstKeyHash,
        childDigest: digest,
        childKind: 'inventory-leaf' as const,
      }))),
    });
    const rootBytes = canonicalizeSystemRecordInventoryInternalObjectV1(root, true);
    const rootDigest = computeSystemRecordInventoryInternalDigestV1(root, true);
    objects.set(rootDigest, Object.freeze({
      objectKind: 'inventory-internal',
      canonicalBytes: rootBytes,
    }));
    const rootEnvelope = await signRootDescriptor(fixture, Object.freeze({
      objectType: 'root-descriptor',
      kind: 'agents',
      networkId: NETWORK,
      epoch: '0',
      version: '0',
      treeRootDigest: rootDigest,
      totalRows: '256',
    }));
    const loadInventoryObject = vi.fn(async (request: AgentProfileInventoryLoadRequestV1) => {
      const stored = objects.get(request.objectDigest);
      if (stored === undefined) {
        return Object.freeze({
          outcome: 'rejected' as const,
          wireBytes: 6,
          rejection: 'not-found' as const,
        });
      }
      return Object.freeze({
        outcome: 'ok' as const,
        objectKind: stored.objectKind,
        canonicalBytes: stored.canonicalBytes,
        wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
      });
    });
    const apply = vi.fn(async () => ({ outcome: 'stale' as const }));
    const prepareActive = vi.fn(async () => Object.freeze({ apply }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission: admissionGate(),
      loadInventoryObject,
      receiver: receiverWithPreparation(prepareActive),
    });
    const signal = new AbortController().signal;
    let result: Awaited<ReturnType<typeof reconciler.advance>>;

    do {
      result = await reconciler.advance(signal);
      expect(result.status).not.toBe('blocked');
    } while (result.status !== 'complete');

    expect(loadInventoryObject).toHaveBeenCalledTimes(3);
    expect(loadInventoryObject.mock.calls[0]![0]).toMatchObject({
      objectDigest: rootDigest,
      expectedKind: 'inventory-leaf',
      path: [],
    });
    expect(prepareActive).toHaveBeenCalledTimes(256);
    expect(apply).toHaveBeenCalledTimes(256);
    expect(reconciler.stats()).toMatchObject({
      inventoryRequests: 3,
      processedRows: 256,
      pendingRows: 0,
    });
  });

  it('preserves an applied result when permit release fails', async () => {
    const fixture = await publishedFixture();
    const releaseFailure = new Error('permit release failed after apply');
    const admission = admissionThrowingOnRelease(2, releaseFailure);
    const apply = vi.fn(async () => ({
      outcome: 'applied' as const,
      stateRevision: '11',
      appliedStateDigest: `0x${'ab'.repeat(32)}`,
    }));
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiverWithPreparation(async () => Object.freeze({ apply })),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).resolves.toMatchObject({
      status: 'complete',
      processedRows: 1,
      pendingRows: 0,
      outcomes: [{ outcome: 'applied' }],
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reconciler.stats()).toMatchObject({
      processedRows: 1,
      pendingRows: 0,
      permitReleaseFailures: 1,
    });
  });

  it('preserves dispatch rejection identity when permit release fails', async () => {
    const fixture = await publishedFixture();
    const settlementFailure = new Error('atomic settlement rejected before cleanup');
    const releaseFailure = new Error('permit release failed after rejection');
    const admission = admissionThrowingOnRelease(2, releaseFailure);
    const apply = vi.fn(async () => {
      throw settlementFailure;
    });
    const reconciler = await createAgentProfileReconcilerV1({
      networkId: NETWORK,
      rootEnvelope: fixture.rootEnvelope,
      providerPeerPublicKey: fixture.peerSigner.publicKey,
      admission,
      loadInventoryObject: fixture.loadInventoryObject,
      receiver: receiverWithPreparation(async () => Object.freeze({ apply })),
    });

    await reconciler.advance(new AbortController().signal);
    await expect(reconciler.advance(new AbortController().signal)).rejects.toBe(settlementFailure);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(reconciler.stats()).toMatchObject({
      processedRows: 0,
      pendingRows: 1,
      permitReleaseFailures: 1,
    });
  });
});

function admissionThrowingOnRelease(
  throwOnRelease: number,
  releaseFailure: Error,
): AgentProfileReconcileAdmissionV1 {
  const authority = createAgentProfileAdmittedSliceContextAuthorityV1(Date.now);
  let releases = 0;
  return Object.freeze({
    tryAcquire() {
      const context = authority.mint(Date.now() + 3_000);
      return Object.freeze({
        admittedContext: context,
        release() {
          releases += 1;
          authority.revoke(context);
          if (releases === throwOnRelease) throw releaseFailure;
        },
      });
    },
    inspectAdmittedContext(context) {
      return authority.inspect(context);
    },
  });
}
