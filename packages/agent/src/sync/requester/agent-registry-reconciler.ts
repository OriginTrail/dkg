// SPDX-License-Identifier: Apache-2.0

import {
  AGENT_DID_PREFIX,
  DKG_ONTOLOGY,
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  tryReplaceSubjectPrefixAtomically,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  AGENT_PEER_BINDING_VERSION,
  verifyAgentPeerIdBinding,
} from '../../profile.js';

export interface AuthenticatedAgentProfileFreshness {
  accepts(root: string, peerId: string, incomingLastSeen: number | undefined): boolean;
  record(root: string, peerId: string, incomingLastSeen: number | undefined): void;
}

export interface AgentRegistrySnapshotReconcileRequest {
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly remotePeerId: string;
  readonly quads: readonly Quad[];
  readonly insertForwarded: (quads: Quad[], options?: QueryOptions) => Promise<void>;
  readonly authenticatedFreshness?: AuthenticatedAgentProfileFreshness;
  readonly options?: QueryOptions;
  readonly invalidate: () => void;
}

export interface AgentRegistryReconciliationPlan {
  readonly ownedRoot?: string;
  readonly ownedQuads: readonly Quad[];
  readonly forwardedQuads: readonly Quad[];
  readonly incomingLastSeen?: number;
  readonly recordAuthenticatedFreshness: boolean;
}

/**
 * Pure registry-policy step. Transport retention supplies one complete snapshot;
 * this function classifies authority and decides the exact owned replacement and
 * append-only discovery rows without touching storage.
 */
export function planAgentRegistrySnapshotReconciliation(input: {
  readonly graphUri: string;
  readonly remotePeerId: string;
  readonly quads: readonly Quad[];
  readonly existingRoots: ReadonlySet<string>;
  readonly authenticatedFreshness?: AuthenticatedAgentProfileFreshness;
}): AgentRegistryReconciliationPlan {
  const incomingProfiles = new Map<string, Quad[]>();
  const unscopedQuads: Quad[] = [];
  for (const quad of input.quads) {
    if (quad.graph !== input.graphUri) continue;
    const root = agentRootForSubject(quad.subject);
    if (!root) {
      unscopedQuads.push(quad);
      continue;
    }
    const profile = incomingProfiles.get(root) ?? [];
    profile.push(quad);
    incomingProfiles.set(root, profile);
  }

  const profileAuthentication = new Map(
    [...incomingProfiles].map(([root, quads]) => [
      root,
      authenticateProfile(root, quads, input.remotePeerId),
    ]),
  );
  const ownedRoots = [...profileAuthentication]
    .filter(([, authentication]) => (
      authentication?.kind === 'proven'
      && authentication.peerId === input.remotePeerId
    ))
    .map(([root]) => root);
  if (ownedRoots.length > 1) {
    throw Object.assign(
      new Error(`AGENTS snapshot contains multiple profiles claiming responder ${input.remotePeerId}`),
      { code: 'AGENTS_RESPONDER_PROFILE_AMBIGUOUS' },
    );
  }
  const ownedRoot = ownedRoots[0];
  const legacyDirectRoots = ownedRoot
    ? []
    : [...profileAuthentication]
        .filter(([, authentication]) => authentication?.kind === 'legacy-direct')
        .map(([root]) => root);
  // An old responder had one default wallet profile. Multiple unproven wallet
  // roots claiming the transport identity are ambiguous and get no fallback.
  const legacyDirectRoot = legacyDirectRoots.length === 1
    ? legacyDirectRoots[0]
    : undefined;
  const incomingLastSeen = ownedRoot
    ? latestTimestamp(
        incomingProfiles.get(ownedRoot) ?? [],
        ownedRoot,
        DKG_ONTOLOGY.DKG_LAST_SEEN,
      )
    : undefined;
  // Persisted registry rows do not carry provenance: a transitive hint can
  // replay the victim's peer-id and a far-future timestamp. Freshness becomes
  // authoritative only after this process directly authenticates that peer.
  const ownedProfileIsCurrent = Boolean(ownedRoot && (
    input.authenticatedFreshness?.accepts(
      ownedRoot,
      input.remotePeerId,
      incomingLastSeen,
    ) ?? true
  ));
  const ownedQuads = ownedRoot && ownedProfileIsCurrent
    ? [...(incomingProfiles.get(ownedRoot) ?? [])]
    : [];
  const forwardedQuads = [...unscopedQuads];
  for (const [root, quads] of incomingProfiles) {
    if (root === ownedRoot) continue;
    const authentication = profileAuthentication.get(root);
    // Proven transitive hints are safe to append while absent. The single
    // proofless legacy-direct root gets the same first-seen treatment only for
    // rolling-upgrade discovery; it never reaches the replacement path above.
    if (
      !input.existingRoots.has(root)
      && (
        (authentication?.kind === 'proven' && authentication.forwardable)
        || root === legacyDirectRoot
      )
    ) {
      forwardedQuads.push(...quads);
    }
  }

  return {
    ...(ownedRoot ? { ownedRoot } : {}),
    ownedQuads,
    forwardedQuads,
    ...(incomingLastSeen === undefined ? {} : { incomingLastSeen }),
    recordAuthenticatedFreshness: Boolean(ownedRoot && ownedProfileIsCurrent),
  };
}

/**
 * Reconcile a completed AGENTS snapshot without assigning global absence
 * authority to an ordinary peer.
 *
 * A responder may replace exactly one self-authenticating profile tree: the
 * legacy canonical root `did:dkg:agent:<authenticated-peer-id>` carrying the
 * same `dkg:peerId`, or a wallet-address root carrying a valid wallet signature
 * over that peer ID. During the v1 rollout, one directly authenticated proofless
 * wallet profile may be admitted only as a first-seen, non-forwardable hint.
 */
export async function reconcileAgentRegistrySnapshot(
  request: AgentRegistrySnapshotReconcileRequest,
): Promise<number> {
  const roots = new Set<string>();
  for (const quad of request.quads) {
    if (quad.graph !== request.graphUri) continue;
    const root = agentRootForSubject(quad.subject);
    if (root) roots.add(root);
  }
  const existingRoots = await loadExistingAgentProfileRoots(
    request.store,
    request.graphUri,
    [...roots],
    request.options,
  );
  const plan = planAgentRegistrySnapshotReconciliation({
    graphUri: request.graphUri,
    remotePeerId: request.remotePeerId,
    quads: request.quads,
    existingRoots,
    authenticatedFreshness: request.authenticatedFreshness,
  });

  let committedTriples = 0;
  if (plan.ownedRoot && plan.recordAuthenticatedFreshness) {
    const replaced = await tryReplaceSubjectPrefixAtomically(
      request.store,
      request.graphUri,
      plan.ownedRoot,
      [...plan.ownedQuads],
      [...plan.forwardedQuads],
      request.options,
    );
    if (!replaced) {
      throw Object.assign(
        new Error('AGENTS responder-profile reconciliation requires atomic TripleStore.replaceSubjectPrefix() support'),
        { code: 'AGENTS_ATOMIC_PROFILE_REPLACE_UNSUPPORTED' },
      );
    }
    committedTriples += plan.ownedQuads.length + plan.forwardedQuads.length;
    request.authenticatedFreshness?.record(
      plan.ownedRoot,
      request.remotePeerId,
      plan.incomingLastSeen,
    );
  } else if (plan.forwardedQuads.length > 0) {
    await request.insertForwarded([...plan.forwardedQuads], request.options);
    committedTriples += plan.forwardedQuads.length;
  }
  if (committedTriples > 0) request.invalidate();
  return committedTriples;
}

/** Registry-owned freshness memory, intentionally independent of byte retention. */
export class AgentRegistrySnapshotReconciler {
  private readonly authenticatedProfileFreshness = new Map<
    string,
    { peerId: string; lastSeen?: number }
  >();

  private readonly profileFreshness: AuthenticatedAgentProfileFreshness = {
    accepts: (root, peerId, incomingLastSeen) => {
      const current = this.authenticatedProfileFreshness.get(root);
      if (!current || current.peerId !== peerId || current.lastSeen === undefined) return true;
      return incomingLastSeen !== undefined && incomingLastSeen >= current.lastSeen;
    },
    record: (root, peerId, incomingLastSeen) => {
      this.authenticatedProfileFreshness.set(root, {
        peerId,
        ...(incomingLastSeen === undefined ? {} : { lastSeen: incomingLastSeen }),
      });
    },
  };

  reconcile(
    request: Omit<AgentRegistrySnapshotReconcileRequest, 'authenticatedFreshness'>,
  ): Promise<number> {
    return reconcileAgentRegistrySnapshot({
      ...request,
      authenticatedFreshness: this.profileFreshness,
    });
  }
}

async function loadExistingAgentProfileRoots(
  store: TripleStore,
  graphUri: string,
  roots: readonly string[],
  options?: QueryOptions,
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let start = 0; start < roots.length; start += 128) {
    const chunk = roots.slice(start, start + 128);
    if (chunk.length === 0) continue;
    const values = chunk.map((root) => `<${assertSafeIri(root)}>`).join(' ');
    const result = await store.query(
      `SELECT DISTINCT ?profile WHERE { GRAPH <${assertSafeIri(graphUri)}> { VALUES ?profile { ${values} } ?subject ?predicate ?object . FILTER(?subject = ?profile || STRSTARTS(STR(?subject), CONCAT(STR(?profile), "/")) || STRSTARTS(STR(?subject), CONCAT(STR(?profile), "#"))) } }`,
      options,
    );
    if (result.type !== 'bindings') continue;
    for (const row of result.bindings) {
      const profile = unwrapIri(row['profile']);
      if (profile) existing.add(profile);
    }
  }
  return existing;
}

function agentRootForSubject(subject: string): string | undefined {
  if (!subject.startsWith(AGENT_DID_PREFIX)) return undefined;
  const suffix = subject.slice(AGENT_DID_PREFIX.length);
  const slash = suffix.indexOf('/');
  const fragment = suffix.indexOf('#');
  const delimiter = [slash, fragment]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), suffix.length);
  const identifier = suffix.slice(0, delimiter);
  return identifier ? `${AGENT_DID_PREFIX}${identifier}` : undefined;
}

type AgentProfileAuthentication =
  | {
      readonly kind: 'proven';
      readonly peerId: string;
      readonly forwardable: boolean;
    }
  | { readonly kind: 'legacy-direct'; readonly peerId: string };

function authenticateProfile(
  root: string,
  quads: readonly Quad[],
  remotePeerId: string,
): AgentProfileAuthentication | undefined {
  const peerIdQuads = quads.filter(
    (quad) => quad.subject === root && quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID,
  );
  const peerIds = new Set(
    peerIdQuads
      .map((quad) => plainLiteral(quad.object))
      .filter((peerId): peerId is string => peerId !== undefined),
  );
  if (peerIds.size !== 1 || peerIds.size !== peerIdQuads.length) return undefined;
  const peerId = [...peerIds][0];
  if (root === `${AGENT_DID_PREFIX}${peerId}`) {
    return peerId === remotePeerId
      ? { kind: 'proven', peerId, forwardable: false }
      : undefined;
  }
  const agentAddress = root.slice(AGENT_DID_PREFIX.length);
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) return undefined;
  const proofQuads = quads.filter((quad) => (
    quad.subject === root
    && quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID_PROOF
  ));
  const proofs = new Set(
    proofQuads
      .map((quad) => plainLiteral(quad.object))
      .filter((proof): proof is string => proof !== undefined),
  );
  const versionQuads = quads.filter((quad) => (
    quad.subject === root
    && quad.predicate === DKG_ONTOLOGY.DKG_PEER_BINDING_VERSION
  ));
  const versions = new Set(
    versionQuads
      .map((quad) => plainLiteral(quad.object))
      .filter((version): version is string => version !== undefined),
  );
  if (proofs.size !== proofQuads.length || versions.size !== versionQuads.length) {
    return undefined;
  }
  if (proofs.size === 1) {
    if (
      versions.size > 1
      || (versions.size === 1 && !versions.has(AGENT_PEER_BINDING_VERSION))
    ) return undefined;
    return verifyAgentPeerIdBinding(agentAddress, peerId, [...proofs][0])
      ? { kind: 'proven', peerId, forwardable: true }
      : undefined;
  }
  if (proofs.size > 0 || versions.size > 0) return undefined;
  return peerId === remotePeerId
    ? { kind: 'legacy-direct', peerId }
    : undefined;
}

function latestTimestamp(
  quads: readonly Quad[],
  subject: string,
  predicate: string,
): number | undefined {
  let latest: number | undefined;
  for (const quad of quads) {
    if (quad.subject !== subject || quad.predicate !== predicate) continue;
    const timestamp = parseTimestamp(quad.object);
    if (timestamp !== undefined && (latest === undefined || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function parseTimestamp(term: string | undefined): number | undefined {
  const literal = term ? plainLiteral(term) : undefined;
  if (!literal) return undefined;
  const timestamp = Date.parse(literal);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function plainLiteral(term: string): string | undefined {
  return parseRdfLiteralTerm(term)?.value;
}

function unwrapIri(term: string | undefined): string | undefined {
  if (!term) return undefined;
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}
