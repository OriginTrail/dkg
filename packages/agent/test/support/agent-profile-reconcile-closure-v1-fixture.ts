import {
  buildSystemRecordInventoryTreeV1,
  buildSystemRecordProviderSignatureMessageV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  computeSystemRecordStableKeyHashV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordSignatureEntryV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactRepositoryV1,
  SystemRecordArtifactV1,
} from '../../src/system-records/artifact-v1.js';
import {
  createFixtureAgentProfileProducerV1,
  DEPLOYMENT,
  NETWORK,
  produce,
  producerFixture,
} from './agent-profile-producer-v1-fixture.js';

export async function maximumAuthorityClosureFixtureV1(options: Readonly<{
  expiredPriorTransitionSequence?: number;
}> = {}) {
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
  const initialEnvelope = fixture.store.snapshot().currentHead;
  if (initialEnvelope === null || initialEnvelope.object.state !== 'active') {
    throw new Error('fixture active head was not retained');
  }
  const bundle = await fixture.store.resolve(Object.freeze({
    type: 'object' as const,
    objectKind: 'profile-bundle' as const,
    objectDigest: initialEnvelope.object.bundleDigest,
  }), new AbortController().signal);
  if (bundle === null) throw new Error('fixture bundle was not retained');

  const artifacts = new Map<string, SystemRecordArtifactV1>();
  let current: AgentProfileActiveHeadObjectV1 = initialEnvelope.object;
  let expiredPriorTransitionDigest: string | undefined;
  let expiredPriorValidUntil: string | undefined;
  addEnvelopeArtifact(artifacts, 'agent-profile-head', current);
  for (let sequence = 1; sequence <= 14; sequence += 1) {
    const prior = current;
    const nextIssuer = `0x${sequence.toString(16).padStart(40, '0')}`;
    const expiredPrior = sequence === options.expiredPriorTransitionSequence;
    if (expiredPrior && prior.validUntil === undefined) {
      throw new Error('expired-prior fixture requires predecessor validity');
    }
    const transition: AgentProfileAuthorityTransitionV1 = Object.freeze({
      objectType: 'authority-transition',
      kind: 'agents',
      mode: expiredPrior ? 'expired-prior' : 'co-signed',
      networkId: prior.networkId,
      peerId: prior.peerId,
      peerPublicKey: prior.peerPublicKey,
      priorAuthoritySequence: prior.authoritySequence,
      nextAuthoritySequence: String(sequence),
      priorHeadDigest: computeAgentProfileHeadObjectDigestV1(prior),
      priorEvmIssuer: prior.evmIssuer,
      nextEvmIssuer: nextIssuer,
      nextRoot: `did:dkg:agent:${nextIssuer}`,
      issuedAt: prior.issuedAt,
      ...(expiredPrior ? { priorValidUntil: prior.validUntil } : {}),
    });
    const transitionDigest = computeAgentProfileAuthorityTransitionDigestV1(transition);
    if (expiredPrior) {
      expiredPriorTransitionDigest = transitionDigest;
      expiredPriorValidUntil = prior.validUntil;
    }
    const rootSubject = transition.nextRoot;
    current = Object.freeze({
      ...prior,
      authoritySequence: String(sequence),
      version: '0',
      acceptedTransitionDigest: transitionDigest,
      evmIssuer: nextIssuer,
      rootSubject,
      ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(rootSubject, [rootSubject]),
      ownedSubjectCount: '1',
      graphScopedAuthorSeal: Object.freeze({
        ...prior.graphScopedAuthorSeal,
        authorAddress: nextIssuer,
        reservedKaId: ((BigInt(nextIssuer) << 96n) | 7n).toString(),
        kaUal: `did:dkg:base:84532/${nextIssuer}/7`,
      }),
    });
    addEnvelopeArtifact(artifacts, 'authority-transition', transition);
    addEnvelopeArtifact(artifacts, 'agent-profile-head', current);
  }
  artifacts.set(`profile-bundle:${current.bundleDigest}`, Object.freeze({
    objectKind: 'profile-bundle',
    objectDigest: current.bundleDigest,
    canonicalBytes: bundle.canonicalBytes,
  }));
  const tableBytes = canonicalizeOwnedSubjectTableObjectV1(
    current.rootSubject,
    [current.rootSubject],
  );
  artifacts.set(`owned-subject-table:${current.ownedSubjectTableDigest}`, Object.freeze({
    objectKind: 'owned-subject-table',
    objectDigest: current.ownedSubjectTableDigest,
    canonicalBytes: tableBytes,
  }));
  const row = Object.freeze({
    stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, current.peerId),
    peerId: current.peerId,
    authoritySequence: current.authoritySequence,
    version: current.version,
    headDigest: computeAgentProfileHeadObjectDigestV1(current),
    tombstone: false,
    quarantined: false,
  });
  const inventory = buildSystemRecordInventoryTreeV1(NETWORK, [row]);
  const rootObjectDigest = computeSystemRecordRootDescriptorDigestV1(inventory.descriptor);
  const rootSignature = await fixture.peerSigner.sign(
    buildSystemRecordProviderSignatureMessageV1(
      inventory.descriptor,
      rootObjectDigest,
      fixture.peerSigner.peerId,
    ),
  );
  const rootEnvelope = Object.freeze({
    object: inventory.descriptor,
    objectDigest: rootObjectDigest,
    providerPeerId: fixture.peerSigner.peerId,
    signatureSuite: 'ed25519-v1' as const,
    signature: Buffer.from(rootSignature).toString('base64url'),
  });
  const repository: SystemRecordArtifactRepositoryV1 = Object.freeze({
    async resolve(lookup) {
      if (lookup.type === 'object') {
        return artifacts.get(`${lookup.objectKind}:${lookup.objectDigest}`) ?? null;
      }
      if (lookup.type === 'inventory-object') {
        const stored = inventory.objects.get(lookup.objectDigest);
        return stored === undefined
          ? null
          : Object.freeze({
            objectKind: stored.objectKind,
            objectDigest: lookup.objectDigest,
            canonicalBytes: stored.canonicalBytes,
          });
      }
      return null;
    },
  });
  return Object.freeze({
    artifacts,
    repository,
    rootEnvelope,
    row,
    peerSigner: fixture.peerSigner,
    expiredPriorTransitionDigest,
    expiredPriorValidUntil,
  });
}

function addEnvelopeArtifact(
  artifacts: Map<string, SystemRecordArtifactV1>,
  objectKind: 'agent-profile-head' | 'authority-transition',
  object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1,
): void {
  const objectDigest = object.objectType === 'agent-profile-head'
    ? computeAgentProfileHeadObjectDigestV1(object)
    : computeAgentProfileAuthorityTransitionDigestV1(object);
  const roles = object.objectType === 'authority-transition'
    ? object.mode === 'co-signed'
      ? ['peer', 'prior-evm', 'next-evm'] as const
      : ['peer', 'next-evm'] as const
    : ['peer', 'current-evm'] as const;
  const signatures = roles.map((role): SystemRecordSignatureEntryV1 => {
    if (role === 'peer') {
      return Object.freeze({
        role,
        suite: 'ed25519-v1',
        signer: object.peerId,
        evidence: Object.freeze({ kind: 'none' as const }),
        signature: Buffer.alloc(64).toString('base64url'),
      });
    }
    const signer = role === 'prior-evm'
      ? (object as AgentProfileAuthorityTransitionV1).priorEvmIssuer
      : role === 'next-evm'
        ? (object as AgentProfileAuthorityTransitionV1).nextEvmIssuer
        : (object as AgentProfileHeadObjectV1).evmIssuer;
    return Object.freeze({
      role,
      suite: 'eip191-personal-sign-digest-v1',
      signer,
      evidence: Object.freeze({ kind: 'none' as const }),
      signature: `0x${'11'.repeat(64)}1b`,
    });
  });
  const canonicalBytes = canonicalizeSignedSystemRecordEnvelopeV1({
    object,
    objectDigest,
    signatures,
  } as SignedSystemRecordEnvelopeV1<typeof object>);
  artifacts.set(`${objectKind}:${objectDigest}`, Object.freeze({
    objectKind,
    objectDigest,
    canonicalBytes,
  }));
}
