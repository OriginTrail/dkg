import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildSystemRecordProviderSignatureMessageV1,
  verifySignedSystemRecordRootDescriptorEnvelopeV1,
  type SignedSystemRecordRootDescriptorEnvelopeV1,
} from '../src/system-record-inventory-v1.js';
import {
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  buildSystemRecordSignatureMessageV1,
  canonicalizeAgentProfileAuthorityTransitionV1,
  canonicalizeAgentProfileForkResolutionV1,
  canonicalizeAgentProfileHeadObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSignedSystemRecordEnvelopeDigestV1,
  canonicalizeSystemRecordRootCollisionEvidenceV1,
  computeSystemRecordRootCollisionEvidenceDigestV1,
  verifySignedSystemRecordEnvelopeV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type SignedSystemRecordEnvelopeV1,
  type SystemRecordSignatureRoleV1,
  type SystemRecordPeerPublicKeyV1,
} from '../src/system-record-objects-v1.js';

const vectors = JSON.parse(readFileSync(
  new URL('./fixtures/system-record-v1/vectors.json', import.meta.url),
  'utf8',
)) as GoldenVectors;

describe('independently generated system-record V1 golden vectors', () => {
  it('reproduces the committed fixture without importing production codecs', () => {
    execFileSync(process.execPath, [
      new URL('./fixtures/system-record-v1/generate.mjs', import.meta.url).pathname,
      '--check',
    ]);
  });

  it('pins canonical bytes and semantic digests for every object omission variant', () => {
    for (const name of ['active', 'tombstone'] as const) {
      const vector = vectors.variants[name];
      expect(Buffer.from(canonicalizeAgentProfileHeadObjectV1(vector.object)).toString())
        .toBe(vector.canonical);
      expect(computeAgentProfileHeadObjectDigestV1(vector.object)).toBe(vector.digest);
    }
    for (const name of ['coSignedTransition', 'expiredTransition'] as const) {
      const vector = vectors.variants[name];
      expect(Buffer.from(canonicalizeAgentProfileAuthorityTransitionV1(vector.object)).toString())
        .toBe(vector.canonical);
      expect(computeAgentProfileAuthorityTransitionDigestV1(vector.object)).toBe(vector.digest);
    }
    for (const name of ['forkV0', 'forkV1'] as const) {
      const vector = vectors.variants[name];
      expect(Buffer.from(canonicalizeAgentProfileForkResolutionV1(vector.object)).toString())
        .toBe(vector.canonical);
      expect(computeAgentProfileForkResolutionDigestV1(vector.object)).toBe(vector.digest);
    }
    expect(EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1).toBe(vectors.emptyTableDigest);
  });

  it('pins every role/suite message, signature, envelope byte branch, and digest', async () => {
    for (const vector of Object.values(vectors.signed)) {
      const envelope = vector.envelope;
      expect(Buffer.from(canonicalizeSignedSystemRecordEnvelopeV1(envelope)).toString())
        .toBe(vector.canonical);
      expect(computeSignedSystemRecordEnvelopeDigestV1(envelope)).toBe(vector.envelopeDigest);
      for (const entry of envelope.signatures) {
        expect(Buffer.from(buildSystemRecordSignatureMessageV1(
          envelope.object,
          envelope.objectDigest,
          entry.role,
        )).toString('hex')).toBe(vector.messages[entry.role]);
      }
      expect(await verifySignedSystemRecordEnvelopeV1(envelope, {
        verifyEip1271: (entry, hash) => entry.evidence.kind === 'eip1271-current-finalized'
          && hash.byteLength === 32,
      })).toBe(true);
    }
  });

  it('pins provider descriptor message/signature independently of authority', async () => {
    const envelope: SignedSystemRecordRootDescriptorEnvelopeV1 = {
      object: vectors.provider.rootDescriptor,
      objectDigest: vectors.provider.rootDigest,
      providerPeerId: vectors.identities.peerId,
      signatureSuite: 'ed25519-v1',
      signature: vectors.provider.signature,
    };
    expect(Buffer.from(buildSystemRecordProviderSignatureMessageV1(
      envelope.object,
      envelope.objectDigest,
      envelope.providerPeerId,
    )).toString('hex')).toBe(vectors.provider.messageHex);
    expect(await verifySignedSystemRecordRootDescriptorEnvelopeV1(
      envelope,
      vectors.identities.peerPublicKey,
    )).toBe(true);
  });

  it('pins the exact root-collision tuple and digest', () => {
    expect(Buffer.from(canonicalizeSystemRecordRootCollisionEvidenceV1(
      vectors.rootCollision.input,
    )).toString()).toBe(vectors.rootCollision.canonical);
    expect(computeSystemRecordRootCollisionEvidenceDigestV1(vectors.rootCollision.input))
      .toBe(vectors.rootCollision.digest);
  });
});

interface GoldenVector<T> {
  readonly object: T;
  readonly canonical: string;
  readonly digest: `0x${string}`;
}

interface GoldenVectors {
  readonly identities: {
    readonly peerId: string;
    readonly peerPublicKey: SystemRecordPeerPublicKeyV1;
    readonly evmIssuer: string;
    readonly rootSubject: string;
  };
  readonly emptyTableDigest: `0x${string}`;
  readonly variants: {
    readonly active: GoldenVector<AgentProfileHeadObjectV1>;
    readonly tombstone: GoldenVector<AgentProfileHeadObjectV1>;
    readonly coSignedTransition: GoldenVector<AgentProfileAuthorityTransitionV1>;
    readonly expiredTransition: GoldenVector<AgentProfileAuthorityTransitionV1>;
    readonly forkV0: GoldenVector<AgentProfileForkResolutionV1>;
    readonly forkV1: GoldenVector<AgentProfileForkResolutionV1>;
  };
  readonly signed: Readonly<Record<string, {
    readonly envelope: SignedSystemRecordEnvelopeV1<
      AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1
    >;
    readonly canonical: string;
    readonly envelopeDigest: `0x${string}`;
    readonly messages: Partial<Record<SystemRecordSignatureRoleV1, string>>;
  }>>;
  readonly provider: {
    readonly rootDescriptor: SignedSystemRecordRootDescriptorEnvelopeV1['object'];
    readonly rootDigest: `0x${string}`;
    readonly messageHex: string;
    readonly signature: string;
  };
  readonly rootCollision: {
    readonly input: import('../src/system-record-objects-v1.js').SystemRecordRootCollisionEvidenceV1;
    readonly canonical: string;
    readonly digest: `0x${string}`;
  };
}
