import {
  buildSystemRecordProviderSignatureMessageV1,
  computeSystemRecordRootDescriptorDigestV1,
  parseCanonicalSignedSystemRecordRootDescriptorEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { SystemRecordApplyOutcomeV1 } from '@origintrail-official/dkg-storage';

import {
  createAgentProfileAdmittedSliceContextAuthorityV1,
  type AgentProfileAdmittedSliceContextV1,
} from '../../src/system-records/admitted-slice-context-v1.js';
import type { SystemRecordArtifactRepositoryV1 } from '../../src/system-records/artifact-v1.js';
import {
  createAgentProfileCandidateReceiverV1,
  type AgentProfileCandidateReceiverV1,
  type AgentProfileCandidateContinuationReceiverV1,
  type AgentProfileReceiverAnyCandidateV1,
} from '../../src/system-records/receiver-v1.js';
import type {
  AgentProfileInventoryLoadRequestV1,
  AgentProfileReconcileAdmissionV1,
} from '../../src/system-records/reconcile-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  NETWORK,
  produce,
  producerFixture,
  PRODUCER_FIXTURE_NOW_MS,
  DEPLOYMENT,
} from './agent-profile-producer-v1-fixture.js';
import { agentProfileArtifactSources } from './agent-profile-artifact-sources-v1-fixture.js';

export { NETWORK };

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
  consumeCandidate: (
    input: AgentProfileReceiverAnyCandidateV1,
    admittedContext: AgentProfileAdmittedSliceContextV1,
    signal: AbortSignal,
  ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>,
) {
  return createAgentProfileCandidateReceiverV1({
    networkId: NETWORK,
    artifacts: agentProfileArtifactSources(store),
    nowMs: () => PRODUCER_FIXTURE_NOW_MS,
    verifyCurrentBundle: () => true,
    prepareCandidateApply: (candidate, admittedContext, signal) => Object.freeze({
      existingMonotonicDeadlineMs: 10_000,
      monotonicNowMs: 1_000,
      apply: () => consumeCandidate(candidate, admittedContext, signal),
    }),
  });
}

export function receiverWithPreparation(
  prepareCandidate: (
    row: Parameters<AgentProfileCandidateReceiverV1['prepareCandidate']>[0],
    signal: Parameters<AgentProfileCandidateReceiverV1['prepareCandidate']>[1],
  ) => Readonly<{
    apply: (
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
  }> | Promise<Readonly<{
    apply: (
      admittedContext: AgentProfileAdmittedSliceContextV1,
      signal: AbortSignal,
    ) => SystemRecordApplyOutcomeV1 | Promise<SystemRecordApplyOutcomeV1>;
  }>>,
): AgentProfileCandidateContinuationReceiverV1 {
  const receiver: AgentProfileCandidateContinuationReceiverV1 = Object.freeze({
    async prepareCandidate(row, signal) {
      const prepared = await prepareCandidate(row, signal);
      let dispatchPrepared = false;
      return Object.freeze({
        async prepareDispatch(admittedContext, dispatchSignal) {
          if (dispatchPrepared) throw new Error('test receiver dispatch already prepared');
          dispatchSignal.throwIfAborted();
          dispatchPrepared = true;
          let dispatched = false;
          return Object.freeze({
            async dispatch() {
              if (dispatched) throw new Error('test receiver dispatch already invoked');
              dispatched = true;
              return prepared.apply(admittedContext, dispatchSignal);
            },
          });
        },
      });
    },
    async receiveCandidate(row, admittedContext, signal) {
      const prepared = await receiver.prepareCandidate(row, signal);
      signal.throwIfAborted();
      const dispatch = await prepared.prepareDispatch(admittedContext, signal);
      signal.throwIfAborted();
      return dispatch.dispatch();
    },
    prepareActive(row, signal) {
      return receiver.prepareCandidate(row, signal);
    },
    receiveActive(row, admittedContext, signal) {
      return receiver.receiveCandidate(row, admittedContext, signal);
    },
  });
  return receiver;
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
  const contextAuthority = createAgentProfileAdmittedSliceContextAuthorityV1(nowMs);
  return Object.freeze({
    tryAcquire() {
      if (held) return null;
      held = true;
      peak = 1;
      acquisitions += 1;
      const context = contextAuthority.mint(nowMs() + 3_000);
      lastContext = context;
      let live = true;
      return Object.freeze({
        admittedContext: context,
        release() {
          if (!live) return;
          live = false;
          contextAuthority.revoke(context);
          held = false;
        },
      });
    },
    inspectAdmittedContext(context) {
      return contextAuthority.inspect(context);
    },
    stats() {
      return { active: held ? 1 : 0, peak, acquisitions };
    },
    lastContext() {
      return lastContext;
    },
  });
}
