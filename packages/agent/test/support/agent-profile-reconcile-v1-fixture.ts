import { decodeOpaqueKaBundleV1 } from '@origintrail-official/dkg-core';
import {
  buildSystemRecordProviderSignatureMessageV1,
  computeSystemRecordRootDescriptorDigestV1,
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
  type SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { parseNQuads } from '../../src/dkg-agent-utils.js';
import type { AgentProfileAdmittedSliceContextV1 } from '../../src/system-records/admitted-slice-context-v1.js';
import type { SystemRecordArtifactRepositoryV1 } from '../../src/system-records/artifact-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfilePreparedActiveV1,
  type AgentProfileReceiverV1,
} from '../../src/system-records/receiver-v1.js';
import type {
  AgentProfileInventoryLoadRequestV1,
  AgentProfileReconcileAdmissionV1,
} from '../../src/system-records/reconcile-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  NETWORK,
  produce,
  producerFixture,
  PRODUCER_FIXTURE_NOW_MS,
} from './agent-profile-producer-v1-fixture.js';

export const TEST_PEER_IDS = Object.freeze([
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkf',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkg',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkh',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwki',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkj',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkk',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkm',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwkn',
  '12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwko',
]);

export async function publishedFixture() {
  const fixture = await producerFixture();
  const producer = createFixtureAgentProfileProducerV1({
    networkId: NETWORK,
    publicationDeployment: DEPLOYMENT,
    peerSigner: fixture.peerSigner,
    evmSigner: fixture.evmSigner,
    store: fixture.store,
    fence: () => undefined,
    install: () => undefined,
  });
  await produce(producer, fixture.prepared, fixture.publication);
  const rootArtifact = await fixture.store.resolve(
    { type: 'root' },
    new AbortController().signal,
  );
  if (rootArtifact === null) throw new Error('fixture root was not retained');
  const rootEnvelope = parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1(
    rootArtifact.canonicalBytes,
  );
  const inventory = fixture.store.snapshot().inventory;
  if (inventory === null) throw new Error('fixture inventory was not retained');

  return {
    ...fixture,
    rootEnvelope,
    loadInventoryObject: async (
      request: AgentProfileInventoryLoadRequestV1,
      signal: AbortSignal,
    ) => {
      const objectKind = request.expectedKind;
      const artifact = await fixture.store.resolve({
        type: 'inventory-object',
        rootDescriptorDigest: request.rootDescriptorDigest,
        path: request.path,
        objectKind,
        objectDigest: request.objectDigest,
      }, signal);
      return artifact === null
        ? {
            outcome: 'rejected' as const,
            wireBytes: 6,
            rejection: 'not-found' as const,
          }
        : {
          outcome: 'ok' as const,
          objectKind,
          canonicalBytes: artifact.canonicalBytes,
          wireBytes: 4 + 128 + artifact.canonicalBytes.byteLength,
        };
    },
  };
}

export async function resignRootTotalRows(
  fixture: Awaited<ReturnType<typeof publishedFixture>>,
  totalRows: SignedSystemRecordRootDescriptorEnvelopeV1['object']['totalRows'],
): Promise<SignedSystemRecordRootDescriptorEnvelopeV1> {
  const object = Object.freeze({ ...fixture.rootEnvelope.object, totalRows });
  return signRootDescriptor(fixture, object);
}

export async function signRootDescriptor(
  fixture: Awaited<ReturnType<typeof publishedFixture>>,
  object: SignedSystemRecordRootDescriptorEnvelopeV1['object'],
): Promise<SignedSystemRecordRootDescriptorEnvelopeV1> {
  const objectDigest = computeSystemRecordRootDescriptorDigestV1(object);
  const signature = await fixture.peerSigner.sign(buildSystemRecordProviderSignatureMessageV1(
    object,
    objectDigest,
    fixture.peerSigner.peerId,
  ));
  return Object.freeze({
    object,
    objectDigest,
    providerPeerId: fixture.peerSigner.peerId,
    signatureSuite: 'ed25519-v1',
    signature: Buffer.from(signature).toString('base64url'),
  });
}

export function receiver(
  store: SystemRecordArtifactRepositoryV1,
  consumeCandidate: Parameters<typeof createAgentProfileReceiverV1>[0]['consumeCandidate'],
) {
  return createAgentProfileReceiverV1({
    networkId: NETWORK,
    artifacts: store,
    nowMs: () => PRODUCER_FIXTURE_NOW_MS,
    verifyCurrentBundle: (_head, bundleBytes) => {
      const { projectionBytes } = decodeOpaqueKaBundleV1(bundleBytes);
      return Object.freeze({
        canonicalProjectionBytes: Uint8Array.from(projectionBytes),
        projectionQuads: Object.freeze(parseNQuads(new TextDecoder().decode(projectionBytes))),
      });
    },
    consumeCandidate,
  });
}

export function receiverWithPreparation(
  prepareActive: (
    row: SystemRecordInventoryRowV1,
    signal: AbortSignal,
  ) => Promise<AgentProfilePreparedActiveV1>,
): AgentProfileReceiverV1 {
  return Object.freeze({
    openPreparation(row) {
      let released = false;
      return Object.freeze({
        prepare(_artifacts: SystemRecordArtifactRepositoryV1, signal: AbortSignal) {
          if (released) throw new Error('test preparation is released');
          return prepareActive(row, signal);
        },
        release() {
          released = true;
        },
      });
    },
    prepareActive(row, _artifacts, signal) {
      return prepareActive(row, signal);
    },
    async receiveActive(row, admittedContext, signal) {
      const prepared = await prepareActive(row, signal);
      signal.throwIfAborted();
      return prepared.apply(admittedContext, signal);
    },
  });
}

export function byteAdmission() {
  return Object.freeze({
    tryReserve() {
      let released = false;
      return Object.freeze({
        release() {
          released = true;
        },
        isReleased: () => released,
      });
    },
  });
}

export function admissionGate(
  initiallyHeld = false,
  nowMs: () => number = Date.now,
): AgentProfileReconcileAdmissionV1 & {
  stats(): { active: 0 | 1; peak: 0 | 1; acquisitions: number };
  lastContext(): AgentProfileAdmittedSliceContextV1 | undefined;
} {
  let held = initiallyHeld;
  let peak: 0 | 1 = held ? 1 : 0;
  let acquisitions = 0;
  let lastContext: AgentProfileAdmittedSliceContextV1 | undefined;
  const contexts = new WeakMap<object, number>();
  return Object.freeze({
    tryAcquire() {
      if (held) return null;
      held = true;
      peak = 1;
      acquisitions += 1;
      const context = Object.freeze(Object.create(null)) as AgentProfileAdmittedSliceContextV1;
      contexts.set(context, nowMs() + 3_000);
      lastContext = context;
      let live = true;
      return Object.freeze({
        admittedContext: context,
        release() {
          if (!live) return;
          live = false;
          held = false;
        },
      });
    },
    inspectAdmittedContext(context) {
      const admittedDeadlineMs = contexts.get(context);
      if (admittedDeadlineMs === undefined) throw new Error('test admitted context is invalid');
      return Object.freeze({ nowMs: nowMs(), admittedDeadlineMs });
    },
    stats() {
      return { active: held ? 1 : 0, peak, acquisitions };
    },
    lastContext() {
      return lastContext;
    },
  });
}
