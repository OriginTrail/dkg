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
import { verifyAgentPeerIdBinding } from '../../profile.js';
import type { SyncCheckpointStore } from '../checkpoint/state.js';
import { deleteSyncPageCheckpoint, type SyncPageResult } from './page-fetch.js';

interface RetainedAuthoritativeSnapshot {
  readonly responderSessionId: string;
  readonly expiresAtMs: number;
  readonly nextOffset: number;
  readonly rawNextOffset: number;
  readonly quads: readonly Quad[];
}

export interface AuthoritativeSnapshotPage {
  readonly checkpointKey: string;
  readonly resumedFromOffset: number;
  readonly rawResumedFromOffset?: number;
  readonly nextOffset: number;
  readonly rawNextOffset?: number;
  readonly completed: boolean;
  readonly timedOut: boolean;
}

export interface AuthoritativeSnapshotMaterializationRequest {
  readonly page: AuthoritativeSnapshotPage;
  readonly verifiedQuads: readonly Quad[];
  /** False when verification or phase semantics forbid retaining this prefix. */
  readonly retainablePrefix: boolean;
  /** True only when the requester proved the response reaches snapshot EOF. */
  readonly completeSnapshot: boolean;
  readonly commit: (completeSnapshot: readonly Quad[]) => Promise<number>;
  /** Synchronous requester checkpoint transition paired with retained state. */
  readonly transitionCheckpoint?: (decision: 'advance' | 'discard') => void;
}

export interface AuthoritativeSnapshotMaterializationResult {
  /** Rows made visible by this call; staged rows deliberately report zero. */
  readonly committedTriples: number;
  readonly retainedTriples: number;
  readonly committed: boolean;
}

interface ExistingAgentProfile {
  readonly quads: Quad[];
}

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

/**
 * Reconcile a completed AGENTS snapshot without assigning global absence
 * authority to an ordinary peer.
 *
 * A responder may replace exactly one self-authenticating profile tree: the
 * legacy canonical root `did:dkg:agent:<authenticated-peer-id>` carrying the
 * same `dkg:peerId`, or a wallet-address root carrying a valid wallet signature
 * over that peer ID. Co-located fields whose signatures do not cover the peer
 * ID are independently replayable and do not grant authority.
 *
 * Other self-authenticating peer-DID profiles are useful transitive discovery
 * hints and are inserted only while their root is absent locally. Every
 * agent-rooted subject is classified even when its peer-id row is omitted, so
 * an attacker cannot target an established profile through an "unscoped"
 * append. Unscoped non-agent legacy facts remain append-only for compatibility.
 */
export async function reconcileAgentRegistrySnapshot(
  request: AgentRegistrySnapshotReconcileRequest,
): Promise<number> {
  const incomingProfiles = new Map<string, Quad[]>();
  const unscopedQuads: Quad[] = [];
  for (const quad of request.quads) {
    if (quad.graph !== request.graphUri) continue;
    const root = agentRootForSubject(quad.subject);
    if (!root) {
      unscopedQuads.push(quad);
      continue;
    }
    const profile = incomingProfiles.get(root) ?? [];
    profile.push(quad);
    incomingProfiles.set(root, profile);
  }

  const ownedRoots = [...incomingProfiles]
    .filter(([root, quads]) => authenticatedPeerForProfile(root, quads) === request.remotePeerId)
    .map(([root]) => root);
  if (ownedRoots.length > 1) {
    throw Object.assign(
      new Error(`AGENTS snapshot contains multiple profiles claiming responder ${request.remotePeerId}`),
      { code: 'AGENTS_RESPONDER_PROFILE_AMBIGUOUS' },
    );
  }
  const ownedRoot = ownedRoots[0];
  const rootEntries = [...incomingProfiles.keys()];

  const existingProfiles = await loadExistingProfiles(
    request.store,
    request.graphUri,
    rootEntries,
    request.options,
  );
  const incomingLastSeen = ownedRoot
    ? latestTimestamp(
        incomingProfiles.get(ownedRoot) ?? [],
        ownedRoot,
        DKG_ONTOLOGY.DKG_LAST_SEEN,
      )
    : undefined;
  // Persisted registry rows do not carry provenance: a transitive hint can
  // replay the victim's peer-id and a far-future timestamp. Freshness becomes
  // authoritative only after this node has observed a directly authenticated
  // snapshot from that peer during this process's authenticated observations.
  const ownedProfileIsCurrent = Boolean(ownedRoot && (
    request.authenticatedFreshness?.accepts(
      ownedRoot,
      request.remotePeerId,
      incomingLastSeen,
    ) ?? true
  ));
  const ownedQuads = ownedRoot && ownedProfileIsCurrent
    ? [...(incomingProfiles.get(ownedRoot) ?? [])]
    : [];
  const forwardedQuads = [...unscopedQuads];
  for (const [root, quads] of incomingProfiles) {
    if (root === ownedRoot) continue;
    // Only a structurally self-authenticating peer DID or a wallet root with a
    // valid peer-binding signature can safely enter the shared registry path.
    if (
      !existingProfiles.has(root)
      && authenticatedPeerForProfile(root, quads) !== undefined
    ) {
      forwardedQuads.push(...quads);
    }
  }

  let committedTriples = 0;
  if (ownedRoot && ownedProfileIsCurrent) {
    const replaced = await tryReplaceSubjectPrefixAtomically(
      request.store,
      request.graphUri,
      ownedRoot,
      ownedQuads,
      forwardedQuads,
      request.options,
    );
    if (!replaced) {
      throw Object.assign(
        new Error('AGENTS responder-profile reconciliation requires atomic TripleStore.replaceSubjectPrefix() support'),
        { code: 'AGENTS_ATOMIC_PROFILE_REPLACE_UNSUPPORTED' },
      );
    }
    committedTriples += ownedQuads.length + forwardedQuads.length;
    request.authenticatedFreshness?.record(
      ownedRoot,
      request.remotePeerId,
      incomingLastSeen,
    );
  } else if (forwardedQuads.length > 0) {
    await request.insertForwarded(forwardedQuads, request.options);
    committedTriples += forwardedQuads.length;
  }
  if (committedTriples > 0) request.invalidate();
  return committedTriples;
}

async function loadExistingProfiles(
  store: TripleStore,
  graphUri: string,
  roots: readonly string[],
  options?: QueryOptions,
): Promise<Map<string, ExistingAgentProfile>> {
  const existing = new Map<string, { quads: Quad[] }>();
  for (let start = 0; start < roots.length; start += 128) {
    const chunk = roots.slice(start, start + 128);
    if (chunk.length === 0) continue;
    const values = chunk.map((root) => `<${assertSafeIri(root)}>`).join(' ');
    const result = await store.query(
      `SELECT ?profile ?subject ?predicate ?object WHERE { GRAPH <${assertSafeIri(graphUri)}> { VALUES ?profile { ${values} } ?subject ?predicate ?object . FILTER(?subject = ?profile || STRSTARTS(STR(?subject), CONCAT(STR(?profile), "/")) || STRSTARTS(STR(?subject), CONCAT(STR(?profile), "#"))) } }`,
      options,
    );
    if (result.type !== 'bindings') continue;
    for (const row of result.bindings) {
      const profile = unwrapIri(row['profile']);
      if (!profile) continue;
      const subject = unwrapIri(row['subject']);
      const predicate = unwrapIri(row['predicate']);
      const object = row['object'];
      if (!subject || !predicate || object === undefined) continue;
      const state = existing.get(profile) ?? { quads: [] };
      const quad = { graph: graphUri, subject, predicate, object };
      state.quads.push(quad);
      existing.set(profile, state);
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

/**
 * Return the peer whose identity is proven by this profile shape. At present
 * peer-ID-rooted legacy profiles are self-authenticating. Address-rooted
 * profiles must carry a wallet signature over their peer ID; other co-located
 * wallet/key proofs are not sufficient because they can be replayed with an
 * attacker-controlled peer-id row.
 */
function authenticatedPeerForProfile(
  root: string,
  quads: readonly Quad[],
): string | undefined {
  const peerIds = new Set(
    quads
      .filter((quad) => quad.subject === root && quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID)
      .map((quad) => plainLiteral(quad.object))
      .filter((peerId): peerId is string => peerId !== undefined),
  );
  if (peerIds.size !== 1) return undefined;
  const peerId = [...peerIds][0];
  if (root === `${AGENT_DID_PREFIX}${peerId}`) return peerId;
  const agentAddress = root.slice(AGENT_DID_PREFIX.length);
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) return undefined;
  const proofs = new Set(
    quads
      .filter((quad) => (
        quad.subject === root
        && quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID_PROOF
      ))
      .map((quad) => plainLiteral(quad.object))
      .filter((proof): proof is string => proof !== undefined),
  );
  if (proofs.size !== 1) return undefined;
  return verifyAgentPeerIdBinding(agentAddress, peerId, [...proofs][0])
    ? peerId
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

/**
 * Retains one authoritative graph snapshot outside the live graph until the
 * immutable responder session reaches EOF. The paired verified offset and raw
 * responder coordinate must match on every retry; a missing, expired, or
 * superseded session discards both the staging buffer and checkpoint.
 */
export class AuthoritativeGraphSnapshotMaterializer {
  private readonly retainedByCheckpoint = new Map<
    string,
    RetainedAuthoritativeSnapshot
  >();
  private readonly authenticatedProfileFreshness = new Map<
    string,
    { peerId: string; lastSeen?: number }
  >();

  constructor(private readonly checkpointStore: SyncCheckpointStore) {}

  readonly profileFreshness: AuthenticatedAgentProfileFreshness = {
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

  /**
   * Reconcile retained bytes with the durable requester checkpoint before a
   * new DATA fetch. A checkpoint without its private prefix cannot safely
   * resume, while a prefix without the exact responder session is stale.
   */
  prepareFetch(checkpointKey: string): void {
    const retained = this.retainedByCheckpoint.get(checkpointKey);
    const checkpoint = this.checkpointStore.get(checkpointKey);
    if (
      !retained
      && (
        !checkpoint
        || (
          checkpoint.offset === 0
          && (checkpoint.responderSessionOffset ?? 0) === 0
        )
      )
    ) return;
    if (
      retained
      && checkpoint
      && checkpoint.responderSessionId === retained.responderSessionId
      && checkpoint.offset === retained.nextOffset
      && (checkpoint.responderSessionOffset ?? checkpoint.offset) === retained.rawNextOffset
    ) return;
    this.discard(checkpointKey);
  }

  async materialize(
    request: AuthoritativeSnapshotMaterializationRequest,
  ): Promise<AuthoritativeSnapshotMaterializationResult> {
    const {
      page,
      verifiedQuads,
      retainablePrefix,
      completeSnapshot,
      commit,
      transitionCheckpoint,
    } = request;
    const checkpoint = this.checkpointStore.get(page.checkpointKey);
    const responderSessionId = checkpoint?.responderSessionId;
    const rawResumedFromOffset = page.rawResumedFromOffset ?? page.resumedFromOffset;
    const rawNextOffset = page.rawNextOffset ?? page.nextOffset;

    if (!retainablePrefix) {
      this.discard(page.checkpointKey);
      transitionCheckpoint?.('discard');
      return { committedTriples: 0, retainedTriples: 0, committed: false };
    }

    let retainedQuads: readonly Quad[];
    if (page.resumedFromOffset === 0 && rawResumedFromOffset === 0) {
      retainedQuads = [...verifiedQuads];
    } else {
      const retained = this.retainedByCheckpoint.get(page.checkpointKey);
      if (
        !retained
        || responderSessionId === undefined
        || retained.responderSessionId !== responderSessionId
        || retained.nextOffset !== page.resumedFromOffset
        || retained.rawNextOffset !== rawResumedFromOffset
      ) {
        this.discard(page.checkpointKey);
        throw Object.assign(
          new Error('Authoritative snapshot continuation does not match its retained responder session'),
          { code: 'AUTHORITATIVE_SNAPSHOT_CONTINUATION_MISMATCH' },
        );
      }
      retainedQuads = [...retained.quads, ...verifiedQuads];
    }

    if (completeSnapshot && page.completed && !page.timedOut) {
      const committedTriples = await commit(retainedQuads);
      this.retainedByCheckpoint.delete(page.checkpointKey);
      transitionCheckpoint?.('advance');
      return {
        committedTriples,
        retainedTriples: 0,
        committed: true,
      };
    }

    if (page.completed || responderSessionId === undefined || !checkpoint) {
      // A completed-but-uninstallable result will have its checkpoint deleted
      // by the requester. A store that cannot retain responder identity is
      // likewise unable to prove a later suffix belongs to this prefix.
      this.discard(page.checkpointKey);
      transitionCheckpoint?.('discard');
      return { committedTriples: 0, retainedTriples: 0, committed: false };
    }

    this.retainedByCheckpoint.set(page.checkpointKey, {
      responderSessionId,
      expiresAtMs: Math.min(
        checkpoint.expiresAtMs,
        checkpoint.responderSessionExpiresAtMs ?? checkpoint.expiresAtMs,
      ),
      nextOffset: page.nextOffset,
      rawNextOffset,
      quads: retainedQuads,
    });
    try {
      transitionCheckpoint?.('advance');
    } catch (error) {
      this.discard(page.checkpointKey);
      throw error;
    }
    return {
      committedTriples: 0,
      retainedTriples: retainedQuads.length,
      committed: false,
    };
  }

  discard(checkpointKey: string): void {
    this.retainedByCheckpoint.delete(checkpointKey);
    deleteSyncPageCheckpoint(this.checkpointStore, checkpointKey);
  }

  retainedTriples(checkpointKey: string): number {
    return this.retainedByCheckpoint.get(checkpointKey)?.quads.length ?? 0;
  }

  pruneExpired(nowMs = Date.now()): number {
    let pruned = 0;
    for (const [checkpointKey, retained] of this.retainedByCheckpoint) {
      if (retained.expiresAtMs >= nowMs) continue;
      this.discard(checkpointKey);
      pruned += 1;
    }
    return pruned;
  }
}

export function authoritativeSnapshotPage(result: SyncPageResult): AuthoritativeSnapshotPage {
  return {
    checkpointKey: result.checkpointKey,
    resumedFromOffset: result.resumedFromOffset,
    rawResumedFromOffset: result.rawResumedFromOffset,
    nextOffset: result.nextOffset,
    rawNextOffset: result.rawNextOffset,
    completed: result.completed,
    timedOut: result.timedOut,
  };
}
