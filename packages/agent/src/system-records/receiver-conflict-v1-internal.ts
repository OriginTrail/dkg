// SPDX-License-Identifier: Apache-2.0

import {
  buildAgentProfileForkEvidenceAuthorityClosureV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  copyBoundedSystemRecordBytesV1,
  evaluateAuthorityTransitionConflictV1,
  evaluateAuthorityTransitionV1,
  parseCanonicalAgentProfileConflictEvidenceV1,
  parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1,
  parseCanonicalSignedAgentProfileHeadEnvelopeV1,
  SYSTEM_RECORD_MAX_CLOCK_SKEW_MS,
  SYSTEM_RECORD_MAX_CLOSURE_BYTES,
  SYSTEM_RECORD_MAX_CLOSURE_OBJECTS,
  SYSTEM_RECORD_MAX_SIDECAR_BYTES,
  SYSTEM_RECORD_MAX_SIDECAR_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type NetworkIdV1,
  type SignedAgentProfileAuthorityTransitionEnvelopeV1,
  type SignedAgentProfileForkResolutionEnvelopeV1,
  type SignedAgentProfileHeadEnvelopeV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordObjectKindV1,
  type SystemRecordVerificationClosureObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import type {
  SystemRecordArtifactRepositoryV1,
  SystemRecordArtifactV1,
} from './artifact-v1.js';

export interface AgentProfileVerifiedConflictArtifactV1 {
  readonly objectKind: 'agent-profile-head' | 'authority-transition';
  readonly objectDigest: Digest32V1;
  readonly canonicalBytes: Uint8Array;
}

export interface AgentProfileVerifiedConflictEvidenceV1 {
  readonly evidence: AgentProfileConflictEvidenceV1;
  readonly evidenceDigest: Digest32V1;
  readonly canonicalEvidenceBytes: Uint8Array;
  readonly artifacts: readonly AgentProfileVerifiedConflictArtifactV1[];
  readonly terminalTransitionConflict: boolean;
}

export interface AgentProfileConflictPreflightV1 {
  readonly evidenceDigest: Digest32V1;
  readonly canonicalEvidenceBytes: Uint8Array;
  readonly artifacts: readonly AgentProfileVerifiedConflictArtifactV1[];
}

export interface PreflightAgentProfileConflictEvidenceOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly row: SystemRecordInventoryRowV1;
  readonly evidenceDigest: Digest32V1;
  readonly artifacts: SystemRecordArtifactRepositoryV1;
  readonly signal: AbortSignal;
}

export interface VerifyAgentProfileConflictEvidenceOptionsV1 {
  readonly networkId: NetworkIdV1;
  readonly currentHead: AgentProfileActiveHeadObjectV1;
  readonly currentHeadDigest: Digest32V1;
  readonly verifiedAuthoritySummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly preflight: AgentProfileConflictPreflightV1;
  /** Independent closure-budget resolver for conflict-head authority lineage. */
  readonly authorityArtifacts: SystemRecordArtifactRepositoryV1;
  /** Already verified current closure artifacts, used only as a local exact cache. */
  readonly seedArtifacts?: readonly SystemRecordVerificationClosureObjectV1[];
  readonly signal: AbortSignal;
  readonly nowMs: number;
  readonly verifyAuthorityEnvelope: (
    envelope:
      | SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
}

/** Retrieve and structurally bind one bounded sidecar before materialization work. */
export async function preflightAgentProfileConflictEvidenceV1(
  options: PreflightAgentProfileConflictEvidenceOptionsV1,
): Promise<AgentProfileConflictPreflightV1> {
  const { networkId, row, evidenceDigest, artifacts, signal } = options;
  signal.throwIfAborted();
  const cache = new Map<string, SystemRecordArtifactV1>();
  let cacheBytes = 0;
  const evidenceArtifact = await load('conflict-evidence', evidenceDigest);
  const evidence = parseCanonicalAgentProfileConflictEvidenceV1(
    evidenceArtifact.canonicalBytes,
  );
  if (computeAgentProfileConflictEvidenceDigestV1(evidence) !== evidenceDigest
      || evidence.networkId !== networkId
      || evidence.peerId !== row.peerId) {
    throw new Error('conflict evidence does not bind the advertised agent-profile row');
  }

  for (const entry of evidence.entries) {
    signal.throwIfAborted();
    const objectKind = entry.type === 'fork' ? 'agent-profile-head' : 'authority-transition';
    for (const digest of entry.objectDigests) await load(objectKind, digest);
  }

  for (const entry of evidence.entries) {
    signal.throwIfAborted();
    if (entry.type === 'fork') {
      if (entry.authoritySequence !== row.authoritySequence
          || entry.version !== row.version
          || !entry.objectDigests.includes(row.headDigest)) {
        throw new Error('fork evidence does not bind the current quarantined frontier');
      }
      const heads = entry.objectDigests.map((digest) => {
        const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
          requiredArtifact('agent-profile-head', digest).canonicalBytes,
        );
        if (envelope.objectDigest !== digest) {
          throw new Error('fork evidence returned a different signed head');
        }
        const head = envelope.object;
        if (head.networkId !== networkId
            || head.peerId !== row.peerId
            || head.authoritySequence !== entry.authoritySequence
            || head.version !== entry.version) {
          throw new Error('fork evidence head does not bind its declared tuple');
        }
        return head;
      });
      const first = heads[0]!;
      if (heads.some((head) =>
        head.peerPublicKey !== first.peerPublicKey
        || head.evmIssuer !== first.evmIssuer
        || head.rootSubject !== first.rootSubject
        || head.acceptedTransitionDigest !== first.acceptedTransitionDigest)) {
        throw new Error('fork evidence changed authority within one head tuple');
      }
    } else {
      const transitions = entry.objectDigests.map((digest) => {
        const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(
          requiredArtifact('authority-transition', digest).canonicalBytes,
        );
        if (envelope.objectDigest !== digest) {
          throw new Error('transition conflict returned a different signed transition');
        }
        const transition = envelope.object;
        if (transition.networkId !== networkId
            || transition.peerId !== row.peerId
            || transition.priorAuthoritySequence !== entry.priorAuthoritySequence
            || transition.nextAuthoritySequence !== entry.nextAuthoritySequence) {
          throw new Error('transition conflict does not bind its declared tuple');
        }
        return transition;
      });
      const first = transitions[0]!;
      if (transitions.slice(1).some((transition) =>
        evaluateAuthorityTransitionConflictV1(first, transition).decision !== 'quarantine')) {
        throw new Error('transition evidence does not prove authority equivocation');
      }
    }
  }

  const retained = [...cache.values()]
    .filter(({ objectKind }) => objectKind !== 'conflict-evidence')
    .map((artifact) => Object.freeze({
      objectKind: artifact.objectKind as 'agent-profile-head' | 'authority-transition',
      objectDigest: artifact.objectDigest,
      canonicalBytes: Uint8Array.from(artifact.canonicalBytes),
    }))
    .sort(compareArtifacts);
  return Object.freeze({
    evidenceDigest,
    canonicalEvidenceBytes: Uint8Array.from(evidenceArtifact.canonicalBytes),
    artifacts: Object.freeze(retained),
  });

  async function load(
    objectKind: SystemRecordObjectKindV1,
    objectDigest: Digest32V1,
  ): Promise<SystemRecordArtifactV1> {
    const key = cacheKey(objectKind, objectDigest);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    signal.throwIfAborted();
    const resolved = await artifacts.resolve(Object.freeze({
      type: 'object',
      objectKind,
      objectDigest,
    }), signal);
    signal.throwIfAborted();
    if (resolved === null) throw new Error(`conflict evidence is missing ${objectDigest}`);
    if (resolved.objectKind !== objectKind || resolved.objectDigest !== objectDigest) {
      throw new Error('conflict evidence resolver returned a different artifact');
    }
    const artifact = Object.freeze({
      objectKind,
      objectDigest,
      canonicalBytes: copyBoundedSystemRecordBytesV1(
        resolved.canonicalBytes,
        SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind],
        'conflict evidence artifact',
      ),
    });
    const nextObjects = cache.size + 1;
    const nextBytes = cacheBytes + artifact.canonicalBytes.byteLength;
    if (nextObjects > SYSTEM_RECORD_MAX_SIDECAR_OBJECTS
        || nextBytes > SYSTEM_RECORD_MAX_SIDECAR_BYTES) {
      throw new Error('verified conflict support exceeds the sidecar bound');
    }
    cache.set(key, artifact);
    cacheBytes = nextBytes;
    return artifact;
  }

  function requiredArtifact(
    objectKind: 'agent-profile-head' | 'authority-transition',
    objectDigest: Digest32V1,
  ): SystemRecordArtifactV1 {
    const artifact = cache.get(cacheKey(objectKind, objectDigest));
    if (artifact === undefined) throw new Error('conflict preflight lost a direct artifact');
    return artifact;
  }
}

/** Verify one structurally complete availability sidecar without granting it authority. */
export async function verifyAgentProfileConflictEvidenceV1(
  options: VerifyAgentProfileConflictEvidenceOptionsV1,
): Promise<AgentProfileVerifiedConflictEvidenceV1> {
  const {
    networkId,
    currentHead,
    currentHeadDigest,
    verifiedAuthoritySummary,
    preflight,
    authorityArtifacts,
    seedArtifacts = [],
    signal,
    nowMs,
    verifyAuthorityEnvelope,
  } = options;
  signal.throwIfAborted();
  if (verifiedAuthoritySummary.candidateHeadDigest !== currentHeadDigest
      || computeAgentProfileHeadObjectDigestV1(currentHead) !== currentHeadDigest) {
    throw new Error('verified conflict context does not bind the current head');
  }
  const canonicalEvidenceBytes = copyBoundedSystemRecordBytesV1(
    preflight.canonicalEvidenceBytes,
    SYSTEM_RECORD_OBJECT_CAPS_V1['conflict-evidence'],
    'preflight conflict evidence',
  );
  const evidence = parseCanonicalAgentProfileConflictEvidenceV1(canonicalEvidenceBytes);
  if (computeAgentProfileConflictEvidenceDigestV1(evidence) !== preflight.evidenceDigest
      || evidence.networkId !== networkId
      || evidence.peerId !== currentHead.peerId) {
    throw new Error('conflict preflight does not bind the verified agent-profile head');
  }
  const cache = new Map<string, SystemRecordArtifactV1>();
  let sidecarBytes = canonicalEvidenceBytes.byteLength;
  if (preflight.artifacts.length + 1 > SYSTEM_RECORD_MAX_SIDECAR_OBJECTS) {
    throw new Error('conflict preflight exceeds the sidecar object bound');
  }
  for (const inputArtifact of preflight.artifacts) {
    const artifact = Object.freeze({
      objectKind: inputArtifact.objectKind,
      objectDigest: inputArtifact.objectDigest,
      canonicalBytes: copyBoundedSystemRecordBytesV1(
        inputArtifact.canonicalBytes,
        SYSTEM_RECORD_OBJECT_CAPS_V1[inputArtifact.objectKind],
        'preflight conflict artifact',
      ),
    });
    const key = cacheKey(artifact.objectKind, artifact.objectDigest);
    if (cache.has(key)) throw new Error('conflict preflight repeated a direct artifact');
    sidecarBytes += artifact.canonicalBytes.byteLength;
    if (sidecarBytes > SYSTEM_RECORD_MAX_SIDECAR_BYTES) {
      throw new Error('conflict preflight exceeds the sidecar byte bound');
    }
    cache.set(key, artifact);
  }
  const expectedArtifactKeys = new Set<string>();
  for (const entry of evidence.entries) {
    const objectKind = entry.type === 'fork' ? 'agent-profile-head' : 'authority-transition';
    for (const digest of entry.objectDigests) expectedArtifactKeys.add(cacheKey(objectKind, digest));
  }
  if (cache.size !== expectedArtifactKeys.size
      || [...expectedArtifactKeys].some((key) => !cache.has(key))) {
    throw new Error('conflict preflight does not contain its exact direct artifacts');
  }
  const authorityCache = new Map<string, SystemRecordArtifactV1>();
  let authorityCacheBytes = 0;
  for (const seed of seedArtifacts) {
    if (seed.objectKind !== 'agent-profile-head'
        && seed.objectKind !== 'authority-transition'
        && seed.objectKind !== 'fork-resolution') continue;
    const artifact = Object.freeze({
      objectKind: seed.objectKind,
      objectDigest: seed.digest,
      canonicalBytes: copyBoundedSystemRecordBytesV1(
        seed.canonicalBytes,
        SYSTEM_RECORD_OBJECT_CAPS_V1[seed.objectKind],
        'verified conflict seed artifact',
      ),
    });
    const key = cacheKey(seed.objectKind, seed.digest);
    const sidecar = cache.get(key);
    if (sidecar !== undefined && !sameArtifact(sidecar, artifact)) {
      throw new Error('verified closure changed a preflight conflict artifact');
    }
    retainAuthorityArtifact(artifact);
  }
  const verifiedHeadDigests = new Set<Digest32V1>(
    seedArtifacts
      .filter(({ objectKind }) => objectKind === 'agent-profile-head')
      .map(({ digest }) => digest),
  );
  for (const entry of evidence.entries) {
    signal.throwIfAborted();
    if (entry.type === 'fork') {
      if (entry.authoritySequence !== currentHead.authoritySequence
          || entry.version !== currentHead.version
          || !entry.objectDigests.includes(currentHeadDigest)) {
        throw new Error('fork evidence does not bind the current quarantined frontier');
      }
      const heads = [];
      for (const digest of entry.objectDigests) {
        const artifact = requiredPreflightArtifact('agent-profile-head', digest);
        const envelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
          artifact.canonicalBytes,
        );
        if (envelope.objectDigest !== digest || !await verifyEnvelope(envelope)) {
          throw new Error('fork evidence returned a different signed head');
        }
        const head = envelope.object;
        if (head.networkId !== networkId
            || head.peerId !== currentHead.peerId
            || head.authoritySequence !== entry.authoritySequence
            || head.version !== entry.version) {
          throw new Error('fork evidence head does not bind its declared tuple');
        }
        await verifyHeadClosure(digest);
        heads.push(head);
      }
      const first = heads[0]!;
      if (heads.some((head) =>
        head.peerPublicKey !== first.peerPublicKey
        || head.evmIssuer !== first.evmIssuer
        || head.rootSubject !== first.rootSubject
        || head.acceptedTransitionDigest !== first.acceptedTransitionDigest)) {
        throw new Error('fork evidence changed authority within one head tuple');
      }
    } else {
      const transitions: AgentProfileAuthorityTransitionV1[] = [];
      for (const digest of entry.objectDigests) {
        const artifact = requiredPreflightArtifact('authority-transition', digest);
        const envelope = parseCanonicalSignedAgentProfileAuthorityTransitionEnvelopeV1(
          artifact.canonicalBytes,
        );
        if (envelope.objectDigest !== digest
            || !await verifyEnvelope(envelope)) {
          throw new Error('transition conflict authority verification failed');
        }
        const transition = envelope.object;
        if (transition.networkId !== networkId
            || transition.peerId !== currentHead.peerId
            || transition.priorAuthoritySequence !== entry.priorAuthoritySequence
            || transition.nextAuthoritySequence !== entry.nextAuthoritySequence) {
          throw new Error('transition conflict does not bind its declared tuple');
        }
        await verifyHeadClosure(transition.priorHeadDigest);
        const priorArtifact = await loadAuthority(
          'agent-profile-head',
          transition.priorHeadDigest,
        );
        const priorEnvelope = parseCanonicalSignedAgentProfileHeadEnvelopeV1(
          priorArtifact.canonicalBytes,
        );
        if (evaluateAuthorityTransitionV1(transition, priorEnvelope.object, nowMs).decision
            !== 'accept') {
          throw new Error('transition conflict lacks its exact accepted predecessor');
        }
        transitions.push(transition);
      }
      const first = transitions[0]!;
      if (transitions.slice(1).some((transition) =>
        evaluateAuthorityTransitionConflictV1(first, transition).decision !== 'quarantine')) {
        throw new Error('transition evidence does not prove authority equivocation');
      }
      const retainedDigest = verifiedAuthoritySummary.transitionLineage
        .find((transition) => transition.nextAuthoritySequence === entry.nextAuthoritySequence)
        ?.transitionDigest;
      if (retainedDigest === undefined || !entry.objectDigests.includes(retainedDigest)) {
        throw new Error('transition evidence is unrelated to the retained authority lineage');
      }
    }
  }

  return Object.freeze({
    evidence,
    evidenceDigest: preflight.evidenceDigest,
    canonicalEvidenceBytes: Uint8Array.from(canonicalEvidenceBytes),
    artifacts: Object.freeze([...cache.values()].map((artifact) => Object.freeze({
      objectKind: artifact.objectKind as 'agent-profile-head' | 'authority-transition',
      objectDigest: artifact.objectDigest,
      canonicalBytes: Uint8Array.from(artifact.canonicalBytes),
    })).sort(compareArtifacts)),
    terminalTransitionConflict: evidence.entries.some(({ type }) => type === 'transition'),
  });

  async function verifyHeadClosure(headDigest: Digest32V1): Promise<void> {
    if (verifiedHeadDigests.has(headDigest)) return;
    const closure = await buildAgentProfileForkEvidenceAuthorityClosureV1(headDigest, {
      nowMs,
      resolve: async (reference) => {
        const artifact = await loadAuthority(reference.objectKind, reference.digest);
        return Object.freeze({
          objectKind: artifact.objectKind,
          digest: artifact.objectDigest,
          canonicalBytes: artifact.canonicalBytes,
        });
      },
      verifyAuthorityEnvelope: verifyEnvelope,
    });
    for (const object of closure.objects) {
      if (object.objectKind === 'agent-profile-head') verifiedHeadDigests.add(object.digest);
    }
  }

  async function loadAuthority(
    objectKind: SystemRecordObjectKindV1,
    objectDigest: Digest32V1,
  ): Promise<SystemRecordArtifactV1> {
    const key = cacheKey(objectKind, objectDigest);
    const cached = authorityCache.get(key);
    if (cached !== undefined) return cached;
    const sidecar = cache.get(key);
    if (sidecar !== undefined) {
      signal.throwIfAborted();
      const resolved = await authorityArtifacts.resolve(Object.freeze({
        type: 'object',
        objectKind,
        objectDigest,
      }), signal);
      signal.throwIfAborted();
      if (resolved === null
          || resolved.objectKind !== objectKind
          || resolved.objectDigest !== objectDigest
          || resolved.canonicalBytes.byteLength !== sidecar.canonicalBytes.byteLength
          || resolved.canonicalBytes.some((byte, index) => byte !== sidecar.canonicalBytes[index])) {
        throw new Error('conflict authority resolver changed a sidecar artifact');
      }
      retainAuthorityArtifact(sidecar);
      return sidecar;
    }
    signal.throwIfAborted();
    const resolved = await authorityArtifacts.resolve(Object.freeze({
      type: 'object',
      objectKind,
      objectDigest,
    }), signal);
    signal.throwIfAborted();
    if (resolved === null) {
      throw new Error(`conflict authority closure is missing ${objectDigest}`);
    }
    if (resolved.objectKind !== objectKind || resolved.objectDigest !== objectDigest) {
      throw new Error('conflict authority resolver returned a different artifact');
    }
    const artifact = Object.freeze({
      objectKind,
      objectDigest,
      canonicalBytes: copyBoundedSystemRecordBytesV1(
        resolved.canonicalBytes,
        SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind],
        'conflict authority artifact',
      ),
    });
    retainAuthorityArtifact(artifact);
    return artifact;
  }

  function retainAuthorityArtifact(artifact: SystemRecordArtifactV1): void {
    const key = cacheKey(artifact.objectKind, artifact.objectDigest);
    if (authorityCache.has(key)) return;
    const nextObjects = authorityCache.size + 1;
    const nextBytes = authorityCacheBytes + artifact.canonicalBytes.byteLength;
    if (nextObjects > SYSTEM_RECORD_MAX_CLOSURE_OBJECTS
        || nextBytes > SYSTEM_RECORD_MAX_CLOSURE_BYTES) {
      throw new Error('verified conflict authority support exceeds the closure bound');
    }
    authorityCache.set(key, artifact);
    authorityCacheBytes = nextBytes;
  }

  async function verifyEnvelope(
    envelope:
      | SignedAgentProfileHeadEnvelopeV1
      | SignedAgentProfileAuthorityTransitionEnvelopeV1
      | SignedAgentProfileForkResolutionEnvelopeV1,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const verified = await verifyAuthorityEnvelope(envelope, signal);
    signal.throwIfAborted();
    if (Date.parse(envelope.object.issuedAt) > nowMs + SYSTEM_RECORD_MAX_CLOCK_SKEW_MS) {
      return false;
    }
    return verified === true;
  }

  function requiredPreflightArtifact(
    objectKind: 'agent-profile-head' | 'authority-transition',
    objectDigest: Digest32V1,
  ): SystemRecordArtifactV1 {
    const artifact = cache.get(cacheKey(objectKind, objectDigest));
    if (artifact === undefined) throw new Error('conflict preflight lost a direct artifact');
    return artifact;
  }
}

function sameArtifact(left: SystemRecordArtifactV1, right: SystemRecordArtifactV1): boolean {
  return left.objectKind === right.objectKind
    && left.objectDigest === right.objectDigest
    && left.canonicalBytes.byteLength === right.canonicalBytes.byteLength
    && left.canonicalBytes.every((byte, index) => byte === right.canonicalBytes[index]);
}

function cacheKey(objectKind: SystemRecordObjectKindV1, objectDigest: Digest32V1): string {
  return `${objectKind}\u0000${objectDigest}`;
}

function compareArtifacts(
  left: AgentProfileVerifiedConflictArtifactV1,
  right: AgentProfileVerifiedConflictArtifactV1,
): number {
  if (left.objectDigest !== right.objectDigest) return left.objectDigest < right.objectDigest ? -1 : 1;
  if (left.objectKind === right.objectKind) return 0;
  return left.objectKind < right.objectKind ? -1 : 1;
}
