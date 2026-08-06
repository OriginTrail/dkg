import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { createHash } from 'node:crypto';
import { peerIdFromPublicKey } from '@libp2p/peer-id';
import { signAsync as signEd25519 } from '@noble/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256 } from '../src/crypto/keccak.js';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  assertCanonicalEip191SignatureV1,
  assertCanonicalRfc3339SecondsV1,
  assertAgentRootV1,
  assertAgentProfileForkResolutionEvidenceV1,
  assertOwnedSubjectTableObjectV1,
  assertDerivedAgentEncryptionSubjectV1,
  assertSystemRecordClosureAlgebraV1,
  buildAgentProfileVerificationClosureV1,
  buildSystemRecordSignatureMessageV1,
  canonicalizeAgentProfileAuthorityTransitionV1,
  canonicalizeAgentProfileConflictEvidenceV1,
  canonicalizeAgentProfileForkResolutionV1,
  canonicalizeAgentProfileHeadObjectV1,
  canonicalizeOwnedSubjectTableObjectV1,
  canonicalizeSignedSystemRecordEnvelopeV1,
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileForkResolutionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeOwnedSubjectTableDigestV1,
  computeSignedSystemRecordEnvelopeDigestV1,
  createSystemRecordCacheMetadataV1,
  createSystemRecordCacheReferenceV1,
  digestSystemRecordBytesV1,
  eip191PersonalMessageHashV1,
  evaluateAuthorityTransitionV1,
  evaluateAuthorityTransitionAgainstAcceptedStateV1,
  evaluateAgentProfileHeadAdvanceV1,
  preflightSystemRecordCacheAccountingV1,
  parseCanonicalAgentProfileAuthorityTransitionV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  parseCanonicalAgentProfileForkResolutionV1,
  parseCanonicalAgentProfileHeadObjectV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  verifySignedSystemRecordEnvelopeV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileForkResolutionV1,
  type AgentProfileHeadObjectV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordSignatureEntryV1,
  type SignedSystemRecordEnvelopeV1,
} from '../src/system-record-objects-v1.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_BUNDLE_BYTES,
} from '../src/system-record-limits-v1.js';
import {
  canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1,
  computeSystemRecordRootDescriptorDigestV1,
} from '../src/system-record-inventory-v1.js';
import { verifySystemRecordResponsePayloadV1 } from '../src/system-record-wire-v1.js';

const DIGEST_A = `0x${'aa'.repeat(32)}` as const;
const DIGEST_B = `0x${'bb'.repeat(32)}` as const;
const DIGEST_C = `0x${'cc'.repeat(32)}` as const;
const NETWORK = 'otp:20430' as const;
const CLOSURE_BUNDLE = new TextEncoder().encode('adversarial-closure-bundle');
const CLOSURE_BUNDLE_DIGEST = digestSystemRecordBytesV1(
  SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle,
  CLOSURE_BUNDLE,
);

describe('system-record V1 object codecs', () => {
  it('round-trips exact active/tombstone, transition, fork, and conflict variants', async () => {
    const fixture = await authorityFixture();
    const active = activeHead(fixture);
    expect(parseCanonicalAgentProfileHeadObjectV1(canonicalizeAgentProfileHeadObjectV1(active)))
      .toEqual(active);

    const tombstone: AgentProfileHeadObjectV1 = {
      objectType: 'agent-profile-head', kind: 'agents', state: 'tombstone',
      networkId: NETWORK, peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
      authoritySequence: '0', version: '1',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(active),
      evmIssuer: fixture.evmIssuer, rootSubject: fixture.root,
      projectionSchemaDigest: DIGEST_C, issuedAt: '2026-08-05T12:10:00Z',
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0', projectionBytes: '0', projectionQuads: '0',
    };
    expect(parseCanonicalAgentProfileHeadObjectV1(canonicalizeAgentProfileHeadObjectV1(tombstone)))
      .toEqual(tombstone);

    const transition = authorityTransition(fixture, active);
    expect(parseCanonicalAgentProfileAuthorityTransitionV1(
      canonicalizeAgentProfileAuthorityTransitionV1(transition),
    )).toEqual(transition);

    const fork = forkResolution(fixture, active);
    expect(parseCanonicalAgentProfileForkResolutionV1(
      canonicalizeAgentProfileForkResolutionV1(fork),
    )).toEqual(fork);

    const evidence = {
      objectType: 'conflict-evidence', kind: 'agents', networkId: NETWORK,
      peerId: fixture.peerId,
      entries: [
        { type: 'fork', authoritySequence: '0', version: '0', objectDigests: [DIGEST_A, DIGEST_B] },
        { type: 'transition', priorAuthoritySequence: '0', nextAuthoritySequence: '1', objectDigests: [DIGEST_B, DIGEST_C] },
      ],
    } as const;
    expect(parseCanonicalAgentProfileConflictEvidenceV1(
      canonicalizeAgentProfileConflictEvidenceV1(evidence),
    )).toEqual(evidence);
  });

  it('rejects null optionals, wrong peer-key binding, unsafe timestamps, and high-s signatures', async () => {
    const fixture = await authorityFixture();
    const active = activeHead(fixture);
    expect(() => canonicalizeAgentProfileHeadObjectV1({
      ...active,
      previousHeadDigest: null,
    } as unknown as AgentProfileHeadObjectV1)).toThrow(/omit optional fields/);
    expect(() => canonicalizeAgentProfileHeadObjectV1({
      ...active,
      peerPublicKey: Buffer.alloc(32, 7).toString('base64url'),
    })).toThrow(/does not derive peerId/);
    expect(() => assertCanonicalRfc3339SecondsV1('2026-08-05T12:00:00.000Z')).toThrow();
    expect(() => assertAgentRootV1(`did:dkg:agent:0x${'0'.repeat(40)}`)).toThrow(/address/);
    const highS = `0x${'01'.repeat(32)}${'ff'.repeat(32)}1b`;
    expect(() => assertCanonicalEip191SignatureV1(highS)).toThrow(/low-s/);
  });

  it('binds active head content/count/table fields to its public graph-scoped seal', async () => {
    const fixture = await authorityFixture();
    const active = activeHead(fixture);
    expect(() => canonicalizeAgentProfileHeadObjectV1({ ...active, contentDigest: DIGEST_C }))
      .toThrow(/Merkle root/);
    expect(() => canonicalizeAgentProfileHeadObjectV1({ ...active, projectionQuads: '4' }))
      .toThrow(/public triple count/);
    expect(() => canonicalizeAgentProfileHeadObjectV1({
      ...active,
      graphScopedAuthorSeal: {
        ...active.graphScopedAuthorSeal,
        privateTripleCount: '1',
        privateMerkleRoot: DIGEST_C,
      },
    })).toThrow(/public-only/);
    expect(() => canonicalizeAgentProfileHeadObjectV1({
      ...active,
      ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    })).toThrow(/nonempty/);
  });

  it('cryptographically verifies peer and EIP-191 role signatures', async () => {
    const fixture = await authorityFixture();
    const object = activeHead(fixture);
    const objectDigest = computeAgentProfileHeadObjectDigestV1(object);
    const peerMessage = buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer');
    const evmMessage = buildSystemRecordSignatureMessageV1(object, objectDigest, 'current-evm');
    const peerSignature = Buffer.from(
      await signEd25519(peerMessage, fixture.peerSecretSeed),
    ).toString('base64url');
    const evmSignature = signEip191(evmMessage, fixture.evmPrivateKey);
    const envelope: SignedAgentProfileHeadEnvelopeV1 = {
      object,
      objectDigest,
      signatures: [
        { role: 'peer', suite: 'ed25519-v1', signer: fixture.peerId, evidence: { kind: 'none' }, signature: peerSignature },
        { role: 'current-evm', suite: 'eip191-personal-sign-digest-v1', signer: fixture.evmIssuer, evidence: { kind: 'none' }, signature: evmSignature },
      ],
    };
    expect(await verifySignedSystemRecordEnvelopeV1(envelope)).toBe(true);
    const tampered = {
      ...envelope,
      signatures: [envelope.signatures[0], { ...envelope.signatures[1], signature: signEip191(peerMessage, fixture.evmPrivateKey) }],
    } as SignedAgentProfileHeadEnvelopeV1;
    expect(await verifySignedSystemRecordEnvelopeV1(tampered)).toBe(false);
  });

  it('enforces transition expiry and direct successor fork decisions', async () => {
    const fixture = await authorityFixture();
    const current = activeHead(fixture);
    const transition = authorityTransition(fixture, current, 'expired-prior');
    expect(evaluateAuthorityTransitionV1(transition, current, Date.parse(current.validUntil)))
      .toMatchObject({ decision: 'reject' });
    expect(evaluateAuthorityTransitionV1(
      transition,
      current,
      Date.parse(transition.issuedAt) + 5 * 60_000,
    )).toEqual({ decision: 'accept' });
    const conflicting = { ...current, bundleDigest: DIGEST_C };
    const fork = forkResolution(fixture, current, [current, conflicting]);
    const successor: AgentProfileActiveHeadObjectV1 = {
      ...current,
      version: '3',
      forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(fork),
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current, disposition: 'head-fork-quarantined', transitionLineage: [], historicalRoots: [], frontierConflictHeads: [current, conflicting] },
      successor,
      { nowMs: Date.parse('2026-08-05T12:10:00Z'), forkResolution: fork, forkEvidenceHeads: [current, conflicting] },
    )).toEqual({ decision: 'accept' });
    const omittedLocalConflict = { ...current, bundleDigest: `0x${'dd'.repeat(32)}` as const };
    expect(evaluateAgentProfileHeadAdvanceV1(
      {
        current,
        disposition: 'head-fork-quarantined',
        transitionLineage: [],
        historicalRoots: [],
        frontierConflictHeads: [current, conflicting, omittedLocalConflict],
      },
      successor,
      { nowMs: Date.parse('2026-08-05T12:10:00Z'), forkResolution: fork, forkEvidenceHeads: [current, conflicting] },
    )).toEqual({ decision: 'accept' });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      conflicting,
      { nowMs: Date.parse('2026-08-05T12:10:00Z') },
    ))
      .toEqual({ decision: 'quarantine', reason: 'head-fork' });
  });

  it('supports version-zero forks after rotation without changing transition lineage', async () => {
    const fixture = await authorityFixture();
    const current = activeHead(fixture);
    const transition = authorityTransition(fixture, current);
    const transitionDigest = computeAgentProfileAuthorityTransitionDigestV1(transition);
    const left = activeForIssuer(current, transition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: transitionDigest,
    });
    const right = { ...left, bundleDigest: DIGEST_C };
    expect(() => canonicalizeAgentProfileHeadObjectV1(left)).not.toThrow();
    expect(() => canonicalizeAgentProfileHeadObjectV1(right)).not.toThrow();
    const resolution: AgentProfileForkResolutionV1 = {
      objectType: 'fork-resolution', kind: 'agents', networkId: NETWORK,
      peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
      evmIssuer: transition.nextEvmIssuer, authoritySequence: '1', forkedVersion: '0',
      resolutionVersion: '1', evidenceHeadDigests: [left, right].map(computeAgentProfileHeadObjectDigestV1).sort(),
      issuedAt: '2026-08-05T12:05:00Z',
    };
    expect(() => assertAgentProfileForkResolutionEvidenceV1(resolution, [right, left])).not.toThrow();
    const altered = { ...left, acceptedTransitionDigest: DIGEST_C };
    expect(() => assertAgentProfileForkResolutionEvidenceV1(
      {
        ...resolution,
        evidenceHeadDigests: [right, altered].map(computeAgentProfileHeadObjectDigestV1).sort(),
      },
      [right, altered],
    )).toThrow(/transition lineage/);
    const alternateTransition = { ...transition, issuedAt: '2026-08-05T12:00:01Z' };
    const alternateDigest = computeAgentProfileAuthorityTransitionDigestV1(alternateTransition);
    const alternateLeft = { ...left, acceptedTransitionDigest: alternateDigest };
    const alternateRight = { ...alternateLeft, bundleDigest: DIGEST_C };
    const alternateResolution: AgentProfileForkResolutionV1 = {
      ...resolution,
      evidenceHeadDigests: [alternateLeft, alternateRight]
        .map(computeAgentProfileHeadObjectDigestV1)
        .sort(),
    };
    const wrongLineageSuccessor = {
      ...left,
      version: '2' as const,
      forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(alternateResolution),
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      {
        current: left,
        disposition: 'head-fork-quarantined',
        transitionLineage: [{
          priorAuthoritySequence: '0', nextAuthoritySequence: '1', transitionDigest,
        }],
        historicalRoots: [current.rootSubject],
      },
      wrongLineageSuccessor,
      {
        nowMs: Date.parse('2026-08-05T12:10:00Z'),
        forkResolution: alternateResolution,
        forkEvidenceHeads: [alternateLeft, alternateRight],
      },
    )).toEqual({ decision: 'quarantine', reason: 'transition-equivocation' });
    const tooMany = Array.from({ length: 17 }, (_, index) => ({
      ...left,
      bundleDigest: `0x${index.toString(16).padStart(64, '0')}` as const,
    }));
    expect(() => canonicalizeAgentProfileForkResolutionV1({
      ...resolution,
      evidenceHeadDigests: tooMany.map(computeAgentProfileHeadObjectDigestV1).sort(),
    })).toThrow(/2-16/);
  });

  it('rejects unproven lineage, wrong tombstones, resurrection, and late transition equivocation', async () => {
    const fixture = await authorityFixture();
    const current = activeHead(fixture);
    const transition = authorityTransition(fixture, current);
    const next = activeForIssuer(
      current,
      transition.nextEvmIssuer,
      '1',
      '0',
      { acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition) },
    );
    const state = { current, disposition: 'discoverable' as const, transitionLineage: [], historicalRoots: [] };
    expect(evaluateAgentProfileHeadAdvanceV1(state, next, {
      nowMs: Date.parse('2026-08-08T00:00:00Z'),
    })).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/verified active predecessor|exact accepted/) });
    expect(evaluateAgentProfileHeadAdvanceV1(state, next, {
      nowMs: Date.parse('2026-08-08T00:00:00Z'), acceptedTransition: transition,
    })).toEqual({ decision: 'accept' });

    const tombstone: AgentProfileHeadObjectV1 = {
      objectType: 'agent-profile-head', kind: 'agents', state: 'tombstone',
      networkId: NETWORK, peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
      authoritySequence: '0', version: '1', previousHeadDigest: DIGEST_C,
      evmIssuer: fixture.evmIssuer, rootSubject: fixture.root, projectionSchemaDigest: DIGEST_C,
      issuedAt: '2026-08-05T12:10:00Z', ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
      ownedSubjectCount: '0', projectionBytes: '0', projectionQuads: '0',
    };
    expect(evaluateAgentProfileHeadAdvanceV1(state, tombstone, {
      nowMs: Date.parse('2026-08-05T12:11:00Z'),
    })).toMatchObject({
      decision: 'reject',
      reason: expect.stringMatching(/verified active predecessor|exact accepted/),
    });
    const validTombstone = { ...tombstone, previousHeadDigest: computeAgentProfileHeadObjectDigestV1(current) };
    const resurrected = {
      ...current,
      version: '2' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(validTombstone),
      issuedAt: '2026-08-05T12:15:00Z' as const,
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: validTombstone, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      resurrected,
      { nowMs: Date.parse('2026-08-05T12:20:00Z') },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/terminal/) });

    const alternate = { ...transition, issuedAt: '2026-08-07T12:00:01Z' };
    expect(evaluateAuthorityTransitionAgainstAcceptedStateV1({
      current: next,
      disposition: 'discoverable',
      transitionLineage: [{
        priorAuthoritySequence: '0', nextAuthoritySequence: '1',
        transitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
      }],
      historicalRoots: [current.rootSubject],
    }, alternate, Date.parse('2026-08-08T00:00:00Z')))
      .toEqual({ decision: 'quarantine', reason: 'transition-equivocation' });
  });

  it('makes a verified tombstone dominant regardless of active-head delivery order', async () => {
    const fixture = await authorityFixture();
    const initial = activeHead(fixture);
    const tombstone = tombstoneHead(initial);
    const activeAfterTombstone = {
      ...initial,
      version: '2' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(tombstone),
      issuedAt: '2026-08-05T12:20:00Z' as const,
    };
    const nowMs = Date.parse('2026-08-07T12:20:00Z');
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: initial, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs },
    )).toEqual({ decision: 'accept' });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: activeAfterTombstone, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs, tombstonePredecessor: initial },
    )).toEqual({ decision: 'accept' });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: tombstone, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      activeAfterTombstone,
      { nowMs },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/terminal/) });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs, tombstonePredecessor: initial },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/verified authority closure/) });

    const competingActive = {
      ...initial,
      version: '1' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(initial),
      issuedAt: '2026-08-05T12:15:00Z' as const,
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: competingActive, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs, tombstonePredecessor: initial },
    )).toEqual({ decision: 'accept' });

    const higherVersionTombstone = {
      ...tombstone,
      version: '2' as const,
      issuedAt: '2026-08-07T11:55:00Z' as const,
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: higherVersionTombstone, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs, tombstonePredecessor: initial },
    )).toEqual({ decision: 'accept' });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current: tombstone, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      higherVersionTombstone,
      { nowMs, tombstonePredecessor: initial },
    )).toEqual({ decision: 'stale' });
  });

  it('rejects tombstone fork evidence and reused or incomplete authority roots', async () => {
    const fixture = await authorityFixture();
    const initial = activeHead(fixture);
    const tombstone = tombstoneHead(initial);
    const competing = {
      ...initial,
      version: '1' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(initial),
      bundleDigest: DIGEST_C,
    };
    const tombstoneFork: AgentProfileForkResolutionV1 = {
      objectType: 'fork-resolution', kind: 'agents', networkId: NETWORK,
      peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
      evmIssuer: fixture.evmIssuer, authoritySequence: '0', forkedVersion: '1',
      resolutionVersion: '2', forkBaseHeadDigest: computeAgentProfileHeadObjectDigestV1(initial),
      evidenceHeadDigests: [tombstone, competing].map(computeAgentProfileHeadObjectDigestV1).sort(),
      issuedAt: '2026-08-05T12:10:00Z',
    };
    expect(() => assertAgentProfileForkResolutionEvidenceV1(
      tombstoneFork, [tombstone, competing], initial,
    )).toThrow(/tombstone evidence/);
    const descendant = {
      ...initial,
      version: '2' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(tombstone),
      issuedAt: '2026-08-05T12:20:00Z' as const,
    };
    const otherDescendant = { ...descendant, bundleDigest: DIGEST_C };
    const tombstoneBaseFork: AgentProfileForkResolutionV1 = {
      ...tombstoneFork,
      forkedVersion: '2',
      resolutionVersion: '3',
      forkBaseHeadDigest: computeAgentProfileHeadObjectDigestV1(tombstone),
      evidenceHeadDigests: [descendant, otherDescendant].map(computeAgentProfileHeadObjectDigestV1).sort(),
    };
    expect(() => assertAgentProfileForkResolutionEvidenceV1(
      tombstoneBaseFork, [descendant, otherDescendant], tombstone,
    )).toThrow(/fork base/);

    const noOpTransition = {
      ...authorityTransition(fixture, initial),
      nextEvmIssuer: initial.evmIssuer,
      nextRoot: initial.rootSubject,
    };
    expect(() => canonicalizeAgentProfileAuthorityTransitionV1(noOpTransition))
      .toThrow(/new wallet root/);

    const firstTransition = authorityTransition(fixture, initial);
    const firstDigest = computeAgentProfileAuthorityTransitionDigestV1(firstTransition);
    const next = activeForIssuer(initial, firstTransition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: firstDigest,
    });
    const backTransition = transitionFrom(fixture, next, '2', initial.evmIssuer);
    const acceptedNext = {
      current: next,
      disposition: 'discoverable' as const,
      transitionLineage: [{
        priorAuthoritySequence: '0' as const,
        nextAuthoritySequence: '1' as const,
        transitionDigest: firstDigest,
      }],
      historicalRoots: [initial.rootSubject],
    };
    expect(evaluateAuthorityTransitionAgainstAcceptedStateV1(
      acceptedNext, backTransition, Date.parse('2026-08-08T00:00:00Z'),
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/reuses a root/) });
    expect(evaluateAuthorityTransitionAgainstAcceptedStateV1({
      current: next, disposition: 'discoverable', transitionLineage: [], historicalRoots: [],
    }, backTransition, Date.parse('2026-08-08T00:00:00Z')))
      .toMatchObject({ decision: 'reject', reason: expect.stringMatching(/incomplete/) });

    const alternativeTransition = { ...firstTransition, issuedAt: '2026-08-07T12:00:01Z' };
    const alternativeHead = {
      ...next,
      acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(alternativeTransition),
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      acceptedNext,
      alternativeHead,
      { nowMs: Date.parse('2026-08-08T00:00:00Z') },
    )).toEqual({ decision: 'quarantine', reason: 'transition-equivocation' });
  });

  it('enforces the exact five-minute future boundary and discards historical resolutions', async () => {
    const fixture = await authorityFixture();
    const now = Date.parse('2026-08-05T12:00:00Z');
    const atBoundary = { ...activeHead(fixture), issuedAt: '2026-08-05T12:05:00Z' };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] }, atBoundary, { nowMs: now },
    )).toEqual({ decision: 'accept' });
    const beyond = { ...atBoundary, issuedAt: '2026-08-05T12:05:01Z' };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] }, beyond, { nowMs: now },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/future/) });

    const base = activeHead(fixture);
    const current = { ...base, version: '10' as const, previousHeadDigest: DIGEST_C };
    const resolution = forkResolution(fixture, base);
    const candidate = {
      ...base,
      version: '11' as const,
      forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(resolution),
    };
    expect(evaluateAgentProfileHeadAdvanceV1(
      { current, disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      candidate,
      { nowMs: Date.parse('2026-08-05T12:10:00Z'), forkResolution: resolution,
        forkEvidenceHeads: [base, { ...base, bundleDigest: DIGEST_C }] },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/historical|unsolicited/) });
  });
});

describe('system-record owned subjects and verification closure', () => {
  it('pins the empty table and rejects unsorted/external/oversized tables', async () => {
    const fixture = await authorityFixture();
    expect(computeOwnedSubjectTableDigestV1(fixture.root, [])).toBe(EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1);
    const valid = [fixture.root, `${fixture.root}/.well-known/genid/cap1`];
    assertOwnedSubjectTableObjectV1(fixture.root, valid);
    expect(() => assertOwnedSubjectTableObjectV1(fixture.root, [...valid].reverse())).toThrow(/sorted/);
    expect(() => assertOwnedSubjectTableObjectV1(fixture.root, ['https://evil.example/x'])).toThrow();
    expect(() => assertOwnedSubjectTableObjectV1(fixture.root, [
      `${'x'.repeat(fixture.root.length)}#x25519-${'a'.repeat(32)}`,
    ])).toThrow(/owned/);
    const publicKey = new Uint8Array(32).fill(9);
    const keyId = `${fixture.root}#x25519-${createHash('sha256').update(publicKey).digest('hex').slice(0, 32)}`;
    expect(() => assertDerivedAgentEncryptionSubjectV1(fixture.root, keyId, publicKey)).not.toThrow();
    expect(() => assertDerivedAgentEncryptionSubjectV1(
      fixture.root,
      `${fixture.root}#x25519-${'0'.repeat(32)}`,
      publicKey,
    )).toThrow(/not derived/);
  });

  it('preflights exact closure/sidecar references without trusting caller counters', async () => {
    const metadata = (byteLength = 0) => createSystemRecordCacheMetadataV1(new Uint8Array(byteLength));
    const emptyMetadata = metadata();
    const references = Array.from({ length: 32 }, (_, index) => {
      const canonicalBytes = new Uint8Array(64).fill(index + 1);
      return createSystemRecordCacheReferenceV1(
        'profile-bundle',
        digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, canonicalBytes),
        canonicalBytes,
      );
    });
    expect(preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [
      { closure: references, metadata: metadata(512) },
      { closure: references, metadata: metadata(512) },
    ] })).toMatchObject({ cohortPhysicalObjects: 32, closureReferences: 64, cohortPhysicalBytes: 2048 });
    expect(() => preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [
      { closure: [...references, references[0]], metadata: metadata(1) },
    ] })).toThrow(/row closure/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{
        closure: [{
          objectKind: 'profile-bundle',
          digest: references[0].digest,
          cacheDigest: references[0].cacheDigest,
        }],
        metadata: emptyMetadata,
      }],
    })).toThrow(/not derived from canonical bytes/);
    const fixture = await authorityFixture();
    const evidenceBytes = canonicalizeAgentProfileConflictEvidenceV1({
      objectType: 'conflict-evidence', kind: 'agents', networkId: NETWORK,
      peerId: fixture.peerId,
      entries: [{
        type: 'fork', authoritySequence: '0', version: '0', objectDigests: [DIGEST_A, DIGEST_B],
      }],
    });
    const sharedSidecar = [createSystemRecordCacheReferenceV1(
      'conflict-evidence',
      digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.conflictEvidence, evidenceBytes),
      evidenceBytes,
    )];
    const deduplicated = preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [
      { closure: [], sidecar: sharedSidecar, metadata: emptyMetadata, sidecarMetadata: emptyMetadata },
      { closure: [], sidecar: sharedSidecar, metadata: emptyMetadata, sidecarMetadata: emptyMetadata },
    ] });
    expect(deduplicated.sidecarPhysicalBytes).toBe(evidenceBytes.byteLength);
    expect(deduplicated.sidecarReferencedBytes).toBe(evidenceBytes.byteLength * 2);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'activation',
      rows: Array.from({ length: 513 }, () => ({ closure: [], metadata: emptyMetadata })),
      inventoryLeaves: [],
    })).toThrow(/record bound/);
    const leaf = (index: number) => {
      const bytes = new TextEncoder().encode(`leaf-${index}`);
      return createSystemRecordCacheReferenceV1(
        'inventory-leaf',
        digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf, bytes),
        bytes,
      );
    };
    const activationLeaf = leaf(0);
    expect(preflightSystemRecordCacheAccountingV1({
      mode: 'activation', rows: [], inventoryLeaves: [activationLeaf],
    })).toMatchObject({
      activationInventoryLeaves: 1,
      cohortPhysicalObjects: 1,
      cohortPhysicalBytes: new TextEncoder().encode('leaf-0').byteLength,
    });
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'activation', rows: [], inventoryLeaves: Array.from({ length: 5 }, (_, index) => leaf(index)),
    })).toThrow(/leaf bound/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{
        closure: [], metadata: emptyMetadata,
        sidecar: references.slice(0, 1), sidecarMetadata: emptyMetadata,
      }],
    })).toThrow(/one evidence object/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{
        closure: [], metadata: emptyMetadata,
        sidecar: undefined, sidecarMetadata: emptyMetadata,
      }],
    })).toThrow(/sidecar must be an array/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{ closure: [], metadata: emptyMetadata, sidecar: sharedSidecar }],
    })).toThrow(/present together/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{ closure: [], metadata: {} as unknown as typeof emptyMetadata }],
    })).toThrow(/not derived from encoded bytes/);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'live',
      rows: [{ closure: [], metadata: emptyMetadata, unknown: 1 }],
    } as never)).toThrow(/unknown or missing fields/);
  });

  it.runIf(process.env.DKG_SYSTEM_RECORD_EXHAUSTIVE === '1')(
    'accepts exactly 128 MiB of activation bundles and rejects one more MiB', () => {
    const reusable = new Uint8Array(SYSTEM_RECORD_MAX_ATOMIC_BUNDLE_BYTES);
    const references = Array.from({ length: 129 }, (_, index) => {
      reusable[0] = index;
      const digest = digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, reusable);
      return createSystemRecordCacheReferenceV1('profile-bundle', digest, reusable);
    });
    const emptyMetadata = createSystemRecordCacheMetadataV1(new Uint8Array());
    const rows = references.map((reference) => ({ closure: [reference], metadata: emptyMetadata }));
    expect(preflightSystemRecordCacheAccountingV1({
      mode: 'activation', rows: rows.slice(0, 128), inventoryLeaves: [],
    }).activationBundleBytes).toBe(SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES);
    expect(() => preflightSystemRecordCacheAccountingV1({
      mode: 'activation', rows, inventoryLeaves: [],
    })).toThrow(/activation cache accounting/);
    }, 30_000,
  );

  it('separates signed semantic identity from exact physical envelope identity', async () => {
    const fixture = await authorityFixture();
    const object = activeHead(fixture);
    const semanticDigest = computeAgentProfileHeadObjectDigestV1(object);
    const firstEnvelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(fakeEnvelopeBytes(object));
    const secondEnvelope: SignedAgentProfileHeadEnvelopeV1 = {
      ...firstEnvelope,
      signatures: [
        firstEnvelope.signatures[0],
        { ...firstEnvelope.signatures[1], signature: '0x02' },
      ],
    };
    const firstBytes = canonicalizeSignedSystemRecordEnvelopeV1(firstEnvelope);
    const secondBytes = canonicalizeSignedSystemRecordEnvelopeV1(secondEnvelope);
    expect(computeSignedSystemRecordEnvelopeDigestV1(firstEnvelope))
      .not.toBe(computeSignedSystemRecordEnvelopeDigestV1(secondEnvelope));

    const first = createSystemRecordCacheReferenceV1('agent-profile-head', semanticDigest, firstBytes);
    const second = createSystemRecordCacheReferenceV1('agent-profile-head', semanticDigest, secondBytes);
    expect(first.digest).toBe(second.digest);
    expect(first.cacheDigest).not.toBe(second.cacheDigest);
    const metadata = createSystemRecordCacheMetadataV1(new Uint8Array());
    expect(preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [
      { closure: [first], metadata },
      { closure: [second], metadata },
    ] })).toMatchObject({ cohortPhysicalObjects: 2, closureReferences: 2 });
    expect(preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [
      { closure: [first], metadata },
      { closure: [first], metadata },
    ] })).toMatchObject({ cohortPhysicalObjects: 1, closureReferences: 2 });
    expect(() => preflightSystemRecordCacheAccountingV1({ mode: 'live', rows: [{
      closure: [{ ...first, cacheDigest: DIGEST_C } as unknown as typeof first], metadata,
    }] })).toThrow(/not derived/);

    const descriptor = {
      objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK,
      epoch: '0', version: '0', treeRootDigest: DIGEST_A, totalRows: '0',
    } as const;
    const descriptorDigest = computeSystemRecordRootDescriptorDigestV1(descriptor);
    const descriptorBytes = canonicalizeSignedSystemRecordRootDescriptorEnvelopeV1({
      object: descriptor,
      objectDigest: descriptorDigest,
      providerPeerId: fixture.peerId,
      signatureSuite: 'ed25519-v1',
      signature: Buffer.alloc(64).toString('base64url'),
    });
    const request = {
      wireVersion: '1', requestId: '0123456789abcdef0123456789abcdef',
      kind: 'agents', networkId: NETWORK, operation: 'get-root', payloadBytes: '0',
    } as const;
    const response = {
      wireVersion: '1', requestId: request.requestId, status: 'ok',
      objectKind: 'root-descriptor', objectDigest: descriptorDigest,
      payloadBytes: String(descriptorBytes.byteLength),
    } as const;
    expect(() => verifySystemRecordResponsePayloadV1(request, response, descriptorBytes)).not.toThrow();
    const descriptorReference = createSystemRecordCacheReferenceV1(
      'root-descriptor', descriptorDigest, descriptorBytes,
    );
    expect(descriptorReference).toMatchObject({ digest: descriptorDigest });
    expect(descriptorReference.cacheDigest).toBe(digestSystemRecordBytesV1(
      SYSTEM_RECORD_DIGEST_DOMAINS_V1.signedRootDescriptorEnvelope,
      descriptorBytes,
    ));
    expect(descriptorReference.cacheDigest).not.toBe(descriptorReference.digest);
  });

  it('derives a complete raw-artifact closure and fails closed on a missing dependency', async () => {
    const fixture = await authorityFixture();
    const bundle = new TextEncoder().encode('canonical-profile-bundle');
    const object = {
      ...activeHead(fixture),
      bundleDigest: digestSystemRecordBytesV1(SYSTEM_RECORD_DIGEST_DOMAINS_V1.profileBundle, bundle),
    };
    const envelope = await signedHeadEnvelope(fixture, object);
    const headBytes = canonicalizeSignedSystemRecordEnvelopeV1(envelope);
    const artifacts = new Map([
      [`agent-profile-head:${envelope.objectDigest}`, {
        objectKind: 'agent-profile-head' as const, digest: envelope.objectDigest, canonicalBytes: headBytes,
      }],
      [`profile-bundle:${object.bundleDigest}`, {
        objectKind: 'profile-bundle' as const, digest: object.bundleDigest, canonicalBytes: bundle,
      }],
    ]);
    const closure = await buildAgentProfileVerificationClosureV1(envelope.objectDigest, {
      nowMs: Date.parse('2026-08-05T12:10:00Z'),
      resolve: async (reference) => artifacts.get(`${reference.objectKind}:${reference.digest}`),
      verifyAuthorityEnvelope: (candidate) => verifySignedSystemRecordEnvelopeV1(candidate),
      verifyCurrentBundle: (_head, bytes) => Buffer.from(bytes).equals(Buffer.from(bundle)),
    });
    expect(closure).toMatchObject({ canonicalBytes: headBytes.byteLength + bundle.byteLength, rootClaims: 1 });
    expect(closure.objects.map((entry) => entry.digest)).toEqual(
      [...closure.objects.map((entry) => entry.digest)].sort(),
    );
    for (const entry of closure.objects) {
      expect(entry.references.map((reference) => reference.digest)).toEqual(
        [...entry.references.map((reference) => reference.digest)].sort(),
      );
    }
    await expect(buildAgentProfileVerificationClosureV1(envelope.objectDigest, {
      nowMs: Date.parse('2026-08-05T12:10:00Z'),
      resolve: async (reference) => reference.objectKind === 'agent-profile-head'
        ? artifacts.get(`${reference.objectKind}:${reference.digest}`)
        : undefined,
      verifyAuthorityEnvelope: () => true,
      verifyCurrentBundle: () => true,
    })).rejects.toThrow(/missing/);
  });

  it('fails closed when authority verification rejects each closure control kind', async () => {
    const fixture = await authorityFixture();
    const initial = { ...activeHead(fixture), bundleDigest: CLOSURE_BUNDLE_DIGEST };
    const initialDigest = computeAgentProfileHeadObjectDigestV1(initial);
    await expect(buildClosure(
      initial,
      closureArtifacts(initial, [], []),
      initialDigest,
    )).rejects.toThrow(/head authority verification failed/);

    const transition = authorityTransition(fixture, initial);
    const transitionDigest = computeAgentProfileAuthorityTransitionDigestV1(transition);
    const rotated = {
      ...activeForIssuer(initial, transition.nextEvmIssuer, '1', '0', {
        acceptedTransitionDigest: transitionDigest,
      }),
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    const rotatedArtifacts = closureArtifacts(rotated, [initial], [transition]);
    await expect(buildClosure(rotated, rotatedArtifacts, initialDigest))
      .rejects.toThrow(/head authority verification failed/);
    await expect(buildClosure(rotated, rotatedArtifacts, transitionDigest))
      .rejects.toThrow(/authority-transition verification failed/);

    const conflicting = { ...initial, bundleDigest: DIGEST_C };
    const resolution = forkResolution(fixture, initial, [initial, conflicting]);
    const successor = {
      ...initial,
      version: '3' as const,
      forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(resolution),
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    await expect(buildClosure(
      successor,
      closureArtifacts(successor, [initial, conflicting], [], [resolution]),
      computeAgentProfileForkResolutionDigestV1(resolution),
    )).rejects.toThrow(/fork-resolution verification failed/);
  });

  it('rejects cold cross-network and cross-peer transition reuse', async () => {
    const fixture = await authorityFixture();
    const other = await authorityFixture(17);
    for (const mismatch of ['network', 'peer'] as const) {
      const prior = mismatch === 'network'
        ? { ...activeHead(fixture), networkId: 'otp:9999' as const }
        : activeHead(other);
      const transition = {
        ...authorityTransition(mismatch === 'network' ? fixture : other, prior),
        ...(mismatch === 'network' ? { networkId: 'otp:9999' as const } : {}),
      };
      const current = {
        ...activeForIssuer(
        activeHead(fixture),
        transition.nextEvmIssuer,
        '1',
        '0',
        { acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition) },
        ),
        bundleDigest: CLOSURE_BUNDLE_DIGEST,
      };
      const artifacts = closureArtifacts(current, [prior], [transition]);
      await expect(buildClosure(current, artifacts)).rejects.toThrow(/accepted authority transition/);
    }
  });

  it('requires every historical tombstone predecessor during cold resurrection', async () => {
    const fixture = await authorityFixture();
    const predecessor = activeHead(fixture);
    const tombstone = tombstoneHead(predecessor);
    const transition = transitionFrom(fixture, tombstone, '1', '0x5555555555555555555555555555555555555555');
    const current = {
      ...activeForIssuer(predecessor, transition.nextEvmIssuer, '1', '0', {
        acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
      }),
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    const missing = closureArtifacts(current, [tombstone], [transition]);
    await expect(buildClosure(current, missing)).rejects.toThrow(/missing/);
    const complete = closureArtifacts(current, [tombstone, predecessor], [transition]);
    const closure = await buildClosure(current, complete);
    expect(closure).toMatchObject({ rootClaims: 2 });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      current,
      { nowMs: Date.parse('2026-08-08T00:00:00Z'), verifiedAuthoritySummary: closure.authoritySummary },
    )).toEqual({ decision: 'accept' });
    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      current,
      { nowMs: Date.parse('2026-08-08T00:00:00Z'),
        verifiedAuthoritySummary: {
          ...closure.authoritySummary,
        } as unknown as typeof closure.authoritySummary },
    )).toMatchObject({ decision: 'reject', reason: expect.stringMatching(/verified authority closure/) });
  });

  it('accepts a cold rotated tombstone only with its closure-minted deletion proof', async () => {
    const fixture = await authorityFixture();
    const initial = activeHead(fixture);
    const transition = authorityTransition(fixture, initial);
    const middle = activeForIssuer(initial, transition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(transition),
    });
    const tombstone = tombstoneHead(middle);
    const closure = await buildClosure(
      tombstone,
      closureArtifacts(tombstone, [middle, initial], [transition]),
    );

    expect(evaluateAgentProfileHeadAdvanceV1(
      { disposition: 'discoverable', transitionLineage: [], historicalRoots: [] },
      tombstone,
      { nowMs: Date.parse('2026-08-08T00:00:00Z'), verifiedAuthoritySummary: closure.authoritySummary },
    )).toEqual({ decision: 'accept' });
    expect(closure.authoritySummary).toMatchObject({
      candidateHeadDigest: computeAgentProfileHeadObjectDigestV1(tombstone),
      deletionTableDigest: middle.ownedSubjectTableDigest,
      historicalRoots: [initial.rootSubject],
      lastAuthorityTransitionPriorHeadDigest: transition.priorHeadDigest,
    });
  });

  it('keeps ordinary active closure bounded without replaying same-sequence version history', async () => {
    const fixture = await authorityFixture();
    const initial = activeHead(fixture);
    const tombstone = tombstoneHead(initial);
    const hiddenDescendant = {
      ...initial,
      version: '2' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(tombstone),
      issuedAt: '2026-08-05T12:20:00Z' as const,
    };
    const current = {
      ...hiddenDescendant,
      version: '3' as const,
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(hiddenDescendant),
      issuedAt: '2026-08-05T12:25:00Z' as const,
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    const closure = await buildClosure(current, closureArtifacts(current, [], []));

    expect(closure.objects.map(({ objectKind }) => objectKind).sort()).toEqual(
      ['agent-profile-head', 'profile-bundle'],
    );
    expect(closure.objects).toHaveLength(2);
  });

  it('rejects transition equivocation even when a fork resolution selects one branch', async () => {
    const fixture = await authorityFixture();
    const prior = activeHead(fixture);
    const leftTransition = authorityTransition(fixture, prior);
    const rightTransition = { ...leftTransition, issuedAt: '2026-08-07T12:00:01Z' };
    const left = activeForIssuer(prior, leftTransition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(leftTransition),
    });
    const right = activeForIssuer({ ...prior, bundleDigest: DIGEST_C }, rightTransition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(rightTransition),
    });
    const resolution: AgentProfileForkResolutionV1 = {
      objectType: 'fork-resolution', kind: 'agents', networkId: NETWORK,
      peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
      evmIssuer: leftTransition.nextEvmIssuer, authoritySequence: '1', forkedVersion: '0',
      resolutionVersion: '1', evidenceHeadDigests: [left, right].map(computeAgentProfileHeadObjectDigestV1).sort(),
      issuedAt: '2026-08-07T12:05:00Z',
    };
    const current = {
      ...left,
      version: '2' as const,
      forkResolutionDigest: computeAgentProfileForkResolutionDigestV1(resolution),
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    const artifacts = closureArtifacts(current, [left, right, prior], [leftTransition, rightTransition], [resolution]);
    await expect(buildClosure(current, artifacts)).rejects.toThrow(/transition lineage|equivocation/);
  });

  it('rejects a cold authority chain that returns to a historical wallet root', async () => {
    const fixture = await authorityFixture();
    const initial = activeHead(fixture);
    const firstTransition = authorityTransition(fixture, initial);
    const middle = activeForIssuer(initial, firstTransition.nextEvmIssuer, '1', '0', {
      acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(firstTransition),
    });
    const backTransition = transitionFrom(fixture, middle, '2', initial.evmIssuer);
    const current = {
      ...activeForIssuer(middle, initial.evmIssuer, '2', '0', {
        acceptedTransitionDigest: computeAgentProfileAuthorityTransitionDigestV1(backTransition),
      }),
      bundleDigest: CLOSURE_BUNDLE_DIGEST,
    };
    const artifacts = closureArtifacts(
      current,
      [middle, initial],
      [backTransition, firstTransition],
    );
    await expect(buildClosure(current, artifacts)).rejects.toThrow(/reuses a historical wallet root/);
  });

  it('pins the authority/fork closure edge equations', () => {
    expect(assertSystemRecordClosureAlgebraV1(14n, 'active')).toBe(30);
    expect(assertSystemRecordClosureAlgebraV1(14n, 'tombstone')).toBe(31);
    expect(assertSystemRecordClosureAlgebraV1(13n, 'fork', 2)).toBe(32);
    expect(() => assertSystemRecordClosureAlgebraV1(14n, 'fork', 2)).toThrow(/34 objects/);
  });
});

async function authorityFixture(offset = 0) {
  const peerSecretSeed = Uint8Array.from({ length: 32 }, (_, index) => (index + 1 + offset) & 0xff);
  const peerKey = await generateKeyPairFromSeed('Ed25519', peerSecretSeed);
  const peerId = peerIdFromPublicKey(peerKey.publicKey).toString();
  const peerPublicKey = Buffer.from(peerKey.publicKey.raw).toString('base64url');
  const evmPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
  const publicKey = secp256k1.getPublicKey(evmPrivateKey, false);
  const evmIssuer = `0x${Buffer.from(keccak256(publicKey.subarray(1)).subarray(12)).toString('hex')}`;
  return {
    peerSecretSeed,
    peerId,
    peerPublicKey,
    evmPrivateKey,
    evmIssuer,
    root: `did:dkg:agent:${evmIssuer}`,
  } as const;
}

function tombstoneHead(active: AgentProfileActiveHeadObjectV1): AgentProfileHeadObjectV1 {
  return {
    objectType: 'agent-profile-head', kind: 'agents', state: 'tombstone',
    networkId: active.networkId, peerId: active.peerId, peerPublicKey: active.peerPublicKey,
    authoritySequence: active.authoritySequence, version: '1',
    ...(active.acceptedTransitionDigest === undefined ? {} : {
      acceptedTransitionDigest: active.acceptedTransitionDigest,
    }),
    previousHeadDigest: computeAgentProfileHeadObjectDigestV1(active),
    evmIssuer: active.evmIssuer, rootSubject: active.rootSubject,
    projectionSchemaDigest: active.projectionSchemaDigest,
    issuedAt: '2026-08-07T11:50:00Z',
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0', projectionBytes: '0', projectionQuads: '0',
  };
}

function transitionFrom(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  prior: AgentProfileHeadObjectV1,
  nextSequence: string,
  nextIssuer: string,
): AgentProfileAuthorityTransitionV1 {
  return {
    objectType: 'authority-transition', kind: 'agents', mode: 'co-signed',
    networkId: prior.networkId, peerId: prior.peerId, peerPublicKey: prior.peerPublicKey,
    priorAuthoritySequence: prior.authoritySequence, nextAuthoritySequence: nextSequence,
    priorHeadDigest: computeAgentProfileHeadObjectDigestV1(prior), priorEvmIssuer: prior.evmIssuer,
    nextEvmIssuer: nextIssuer, nextRoot: `did:dkg:agent:${nextIssuer}`,
    issuedAt: '2026-08-07T12:00:00Z',
  };
}

function closureArtifacts(
  current: AgentProfileHeadObjectV1,
  historicalHeads: readonly AgentProfileHeadObjectV1[],
  transitions: readonly AgentProfileAuthorityTransitionV1[],
  resolutions: readonly AgentProfileForkResolutionV1[] = [],
) {
  const artifacts = new Map<string, {
    objectKind: 'agent-profile-head' | 'authority-transition' | 'fork-resolution'
      | 'profile-bundle' | 'owned-subject-table';
    digest: `0x${string}`;
    canonicalBytes: Uint8Array;
  }>();
  for (const head of [current, ...historicalHeads]) add('agent-profile-head', head);
  for (const transition of transitions) add('authority-transition', transition);
  for (const resolution of resolutions) add('fork-resolution', resolution);
  if (current.state === 'active') {
    artifacts.set(`profile-bundle:${current.bundleDigest}`, {
      objectKind: 'profile-bundle', digest: current.bundleDigest, canonicalBytes: CLOSURE_BUNDLE,
    });
  } else {
    const predecessor = historicalHeads.find(
      (head): head is AgentProfileActiveHeadObjectV1 => head.state === 'active'
        && computeAgentProfileHeadObjectDigestV1(head) === current.previousHeadDigest,
    );
    if (predecessor !== undefined) {
      const canonicalBytes = canonicalizeOwnedSubjectTableObjectV1(
        predecessor.rootSubject,
        [predecessor.rootSubject],
      );
      artifacts.set(`owned-subject-table:${predecessor.ownedSubjectTableDigest}`, {
        objectKind: 'owned-subject-table',
        digest: predecessor.ownedSubjectTableDigest,
        canonicalBytes,
      });
    }
  }
  return artifacts;

  function add(
    objectKind: 'agent-profile-head' | 'authority-transition' | 'fork-resolution',
    object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1,
  ) {
    const digest = object.objectType === 'agent-profile-head'
      ? computeAgentProfileHeadObjectDigestV1(object)
      : object.objectType === 'authority-transition'
        ? computeAgentProfileAuthorityTransitionDigestV1(object)
        : computeAgentProfileForkResolutionDigestV1(object);
    artifacts.set(`${objectKind}:${digest}`, {
      objectKind,
      digest,
      canonicalBytes: fakeEnvelopeBytes(object),
    });
  }
}

async function buildClosure(
  current: AgentProfileHeadObjectV1,
  artifacts: ReturnType<typeof closureArtifacts>,
  rejectAuthorityDigest?: string,
) {
  return buildAgentProfileVerificationClosureV1(computeAgentProfileHeadObjectDigestV1(current), {
    nowMs: Date.parse('2026-08-08T00:00:00Z'),
    resolve: async (reference) => artifacts.get(`${reference.objectKind}:${reference.digest}`),
    verifyAuthorityEnvelope: (envelope) => envelope.objectDigest !== rejectAuthorityDigest,
    verifyCurrentBundle: (_head, bytes) => Buffer.from(bytes).equals(Buffer.from(CLOSURE_BUNDLE)),
  });
}

function fakeEnvelopeBytes(
  object: AgentProfileHeadObjectV1 | AgentProfileAuthorityTransitionV1 | AgentProfileForkResolutionV1,
): Uint8Array {
  const objectDigest = object.objectType === 'agent-profile-head'
    ? computeAgentProfileHeadObjectDigestV1(object)
    : object.objectType === 'authority-transition'
      ? computeAgentProfileAuthorityTransitionDigestV1(object)
      : computeAgentProfileForkResolutionDigestV1(object);
  const roles = object.objectType === 'authority-transition'
    ? object.mode === 'co-signed' ? ['peer', 'prior-evm', 'next-evm'] as const : ['peer', 'next-evm'] as const
    : ['peer', 'current-evm'] as const;
  const signatures = roles.map((role): SystemRecordSignatureEntryV1 => {
    if (role === 'peer') {
      return {
        role, suite: 'ed25519-v1', signer: object.peerId, evidence: { kind: 'none' },
        signature: Buffer.alloc(64).toString('base64url'),
      };
    }
    const signer = role === 'prior-evm'
      ? (object as AgentProfileAuthorityTransitionV1).priorEvmIssuer
      : role === 'next-evm'
        ? (object as AgentProfileAuthorityTransitionV1).nextEvmIssuer
        : (object as AgentProfileHeadObjectV1 | AgentProfileForkResolutionV1).evmIssuer;
    return {
      role,
      suite: 'eip1271-current-finalized-v1',
      signer,
      evidence: {
        kind: 'eip1271-current-finalized', chainId: object.networkId.split(':').at(-1)!,
        contractAddress: signer, finalizedBlockNumber: '1', finalizedBlockHash: DIGEST_A,
      },
      signature: '0x01',
    };
  });
  return canonicalizeSignedSystemRecordEnvelopeV1({
    object,
    objectDigest,
    signatures,
  } as SignedSystemRecordEnvelopeV1<typeof object>);
}

function activeHead(fixture: Awaited<ReturnType<typeof authorityFixture>>): AgentProfileActiveHeadObjectV1 {
  const seal = {
    assertionMerkleRoot: DIGEST_A,
    authorAddress: fixture.evmIssuer,
    authorAttestationR: `0x${'11'.repeat(32)}`,
    authorAttestationVS: `0x${'22'.repeat(32)}`,
    authorSchemeVersion: '1', assertedAtChainId: '20430',
    assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
    reservedKaId: ((BigInt(fixture.evmIssuer) << 96n) | 7n).toString(),
    assertionFinalizedAt: '2026-08-05T11:59:59.000Z',
    contentScopeVersion: '2', kaUal: `did:dkg:otp:20430/${fixture.evmIssuer}/7`,
    assertionVersion: '1', publicTripleCount: '3', privateTripleCount: '0',
    privateMerkleRoot: null,
  } as const;
  return {
    objectType: 'agent-profile-head', kind: 'agents', state: 'active',
    networkId: NETWORK, peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
    authoritySequence: '0', version: '0', evmIssuer: fixture.evmIssuer,
    rootSubject: fixture.root, projectionSchemaDigest: DIGEST_C,
    issuedAt: '2026-08-05T12:00:00Z', validUntil: '2026-08-06T12:00:00Z',
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(fixture.root, [fixture.root]),
    ownedSubjectCount: '1', projectionBytes: '256', projectionQuads: '3',
    assertionCoordinate: 'agent-profile-v1', graphScopedAuthorSeal: seal,
    contentDigest: DIGEST_A, bundleDigest: DIGEST_B,
  } as AgentProfileActiveHeadObjectV1;
}

function activeForIssuer(
  source: AgentProfileActiveHeadObjectV1,
  issuer: string,
  authoritySequence: string,
  version: string,
  history: Pick<AgentProfileActiveHeadObjectV1, 'previousHeadDigest' | 'acceptedTransitionDigest'>,
): AgentProfileActiveHeadObjectV1 {
  const root = `did:dkg:agent:${issuer}`;
  return {
    ...source,
    authoritySequence,
    version,
    ...history,
    evmIssuer: issuer,
    rootSubject: root,
    ownedSubjectTableDigest: computeOwnedSubjectTableDigestV1(root, [root]),
    graphScopedAuthorSeal: {
      ...source.graphScopedAuthorSeal,
      authorAddress: issuer,
      kaUal: `did:dkg:otp:20430/${issuer}/7`,
      reservedKaId: ((BigInt(issuer) << 96n) | 7n).toString(),
    },
  } as AgentProfileActiveHeadObjectV1;
}

function authorityTransition(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  active: AgentProfileActiveHeadObjectV1,
  mode: 'co-signed' | 'expired-prior' = 'co-signed',
): AgentProfileAuthorityTransitionV1 {
  const next = '0x5555555555555555555555555555555555555555';
  return {
    objectType: 'authority-transition', kind: 'agents', mode,
    networkId: NETWORK, peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
    priorAuthoritySequence: '0', nextAuthoritySequence: '1',
    priorHeadDigest: computeAgentProfileHeadObjectDigestV1(active),
    priorEvmIssuer: fixture.evmIssuer, nextEvmIssuer: next,
    nextRoot: `did:dkg:agent:${next}`, issuedAt: '2026-08-07T12:00:00Z',
    ...(mode === 'expired-prior' ? { priorValidUntil: active.validUntil } : {}),
  } as AgentProfileAuthorityTransitionV1;
}

function forkResolution(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  _active: AgentProfileActiveHeadObjectV1,
  conflicts: readonly AgentProfileHeadObjectV1[] = [],
): AgentProfileForkResolutionV1 {
  const evidenceHeadDigests = conflicts.length === 0
    ? [DIGEST_A, DIGEST_B]
    : conflicts.map(computeAgentProfileHeadObjectDigestV1).sort();
  return {
    objectType: 'fork-resolution', kind: 'agents', networkId: NETWORK,
    peerId: fixture.peerId, peerPublicKey: fixture.peerPublicKey,
    evmIssuer: fixture.evmIssuer, authoritySequence: '0', forkedVersion: '0',
    resolutionVersion: '2', evidenceHeadDigests,
    issuedAt: '2026-08-05T12:05:00Z',
  };
}

function signEip191(message: Uint8Array, privateKey: Uint8Array): string {
  const recovered = secp256k1.sign(eip191PersonalMessageHashV1(message), privateKey, {
    format: 'recovered', prehash: false, lowS: true,
  });
  const compact = recovered.subarray(1);
  const result = new Uint8Array(65);
  result.set(compact);
  result[64] = recovered[0] + 27;
  return `0x${Buffer.from(result).toString('hex')}`;
}

async function signedHeadEnvelope(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  object: AgentProfileActiveHeadObjectV1,
): Promise<SignedAgentProfileHeadEnvelopeV1> {
  const objectDigest = computeAgentProfileHeadObjectDigestV1(object);
  return {
    object,
    objectDigest,
    signatures: [
      {
        role: 'peer', suite: 'ed25519-v1', signer: fixture.peerId, evidence: { kind: 'none' },
        signature: Buffer.from(await signEd25519(
          buildSystemRecordSignatureMessageV1(object, objectDigest, 'peer'),
          fixture.peerSecretSeed,
        )).toString('base64url'),
      },
      {
        role: 'current-evm', suite: 'eip191-personal-sign-digest-v1', signer: fixture.evmIssuer,
        evidence: { kind: 'none' },
        signature: signEip191(
          buildSystemRecordSignatureMessageV1(object, objectDigest, 'current-evm'),
          fixture.evmPrivateKey,
        ),
      },
    ],
  };
}
