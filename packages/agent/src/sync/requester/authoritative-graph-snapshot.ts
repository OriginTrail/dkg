// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import {
  tryReplaceSubjectPrefixAtomically,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
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

const AGENT_DID_PREFIX = 'did:dkg:agent:';
const DKG_PEER_ID = 'https://dkg.network/ontology#peerId';
const DKG_LAST_SEEN = 'https://dkg.network/ontology#lastSeen';

interface ExistingAgentProfile {
  readonly peerIds: Set<string>;
  readonly lastSeen?: number;
}

export interface AgentRegistrySnapshotReconcileRequest {
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly remotePeerId: string;
  readonly quads: readonly Quad[];
  readonly insertForwarded: (quads: Quad[], options?: QueryOptions) => Promise<void>;
  readonly options?: QueryOptions;
  readonly invalidate: () => void;
}

/**
 * Reconcile a completed AGENTS snapshot without assigning global absence
 * authority to an ordinary peer.
 *
 * A responder may replace exactly one established profile tree: the canonical
 * agent root whose local and incoming `dkg:peerId` bindings both equal its
 * authenticated libp2p identity. A first-seen profile is appended, never used
 * for a destructive replacement; the next authenticated refresh may replace
 * it. A valid older `dkg:lastSeen` snapshot cannot roll a newer local profile
 * back.
 *
 * Other profiles are useful transitive discovery hints, but are inserted only
 * when their root is absent locally. Their omission or stale copy can therefore
 * neither erase nor overwrite a locally newer profile. Unscoped legacy
 * registry facts remain append-only for rolling compatibility.
 */
export async function reconcileAgentRegistrySnapshot(
  request: AgentRegistrySnapshotReconcileRequest,
): Promise<number> {
  const roots = new Map<string, string>();
  for (const quad of request.quads) {
    if (
      quad.graph !== request.graphUri
      || quad.predicate !== DKG_PEER_ID
      || !quad.subject.startsWith(AGENT_DID_PREFIX)
    ) continue;
    const peerId = plainLiteral(quad.object);
    if (peerId) roots.set(quad.subject, peerId);
  }

  const ownedRoots = [...roots]
    .filter(([, peerId]) => peerId === request.remotePeerId)
    .map(([root]) => root);
  if (ownedRoots.length > 1) {
    throw Object.assign(
      new Error(`AGENTS snapshot contains multiple profiles claiming responder ${request.remotePeerId}`),
      { code: 'AGENTS_RESPONDER_PROFILE_AMBIGUOUS' },
    );
  }
  const ownedRoot = ownedRoots[0];
  const rootEntries = [...roots.keys()].sort((a, b) => b.length - a.length);
  const rootForSubject = (subject: string): string | undefined => rootEntries.find(
    (root) => subject === root
      || subject.startsWith(`${root}/`)
      || subject.startsWith(`${root}#`),
  );

  const existingProfiles = await loadExistingProfiles(
    request.store,
    request.graphUri,
    rootEntries,
    request.options,
  );
  const existingOwnedProfile = ownedRoot ? existingProfiles.get(ownedRoot) : undefined;
  const ownedProfileIsEstablished = Boolean(
    existingOwnedProfile
    && existingOwnedProfile.peerIds.size === 1
    && existingOwnedProfile.peerIds.has(request.remotePeerId),
  );
  const incomingLastSeen = ownedRoot
    ? latestTimestamp(request.quads, ownedRoot, DKG_LAST_SEEN)
    : undefined;
  const ownedProfileIsCurrent = ownedProfileIsEstablished
    && !isOlderProfile(incomingLastSeen, existingOwnedProfile?.lastSeen);
  const ownedQuads: Quad[] = [];
  const forwardedQuads: Quad[] = [];
  for (const quad of request.quads) {
    const root = rootForSubject(quad.subject);
    if (root === ownedRoot && ownedProfileIsCurrent) {
      ownedQuads.push(quad);
    } else if (root === ownedRoot && existingOwnedProfile === undefined) {
      // Establish the peer-to-profile binding without granting the same
      // untrusted first snapshot deletion authority over a pre-existing root.
      forwardedQuads.push(quad);
    } else if (root === undefined || !existingProfiles.has(root)) {
      forwardedQuads.push(quad);
    }
  }

  let committedTriples = 0;
  if (forwardedQuads.length > 0) {
    await request.insertForwarded(forwardedQuads, request.options);
    committedTriples += forwardedQuads.length;
  }
  if (ownedRoot && ownedProfileIsCurrent) {
    const replaced = await tryReplaceSubjectPrefixAtomically(
      request.store,
      request.graphUri,
      ownedRoot,
      ownedQuads,
      request.options,
    );
    if (!replaced) {
      throw Object.assign(
        new Error('AGENTS responder-profile reconciliation requires atomic TripleStore.replaceSubjectPrefix() support'),
        { code: 'AGENTS_ATOMIC_PROFILE_REPLACE_UNSUPPORTED' },
      );
    }
    committedTriples += ownedQuads.length;
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
  const existing = new Map<string, { peerIds: Set<string>; lastSeen?: number }>();
  for (let start = 0; start < roots.length; start += 128) {
    const chunk = roots.slice(start, start + 128);
    if (chunk.length === 0) continue;
    const values = chunk.map((root) => `<${assertSafeIri(root)}>`).join(' ');
    const result = await store.query(
      `SELECT ?profile ?peerId ?lastSeen WHERE { VALUES ?profile { ${values} } GRAPH <${assertSafeIri(graphUri)}> { ?profile ?profilePredicate ?profileObject . OPTIONAL { ?profile <${DKG_PEER_ID}> ?peerId } OPTIONAL { ?profile <${DKG_LAST_SEEN}> ?lastSeen } } }`,
      options,
    );
    if (result.type !== 'bindings') continue;
    for (const row of result.bindings) {
      const profile = unwrapIri(row['profile']);
      if (!profile) continue;
      const state = existing.get(profile) ?? { peerIds: new Set<string>() };
      const peerId = plainLiteral(row['peerId'] ?? '');
      if (peerId) state.peerIds.add(peerId);
      const lastSeen = parseTimestamp(row['lastSeen']);
      if (lastSeen !== undefined && (state.lastSeen === undefined || lastSeen > state.lastSeen)) {
        state.lastSeen = lastSeen;
      }
      existing.set(profile, state);
    }
  }
  return existing;
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

function isOlderProfile(incoming: number | undefined, existing: number | undefined): boolean {
  if (existing === undefined) return false;
  return incoming === undefined || incoming < existing;
}

function plainLiteral(term: string): string | undefined {
  const match = term.match(/^"([^"\\]*)"(?:@[^\s]+|\^\^<?[^>\s]+>?)?$/);
  return match?.[1];
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

  constructor(private readonly checkpointStore: SyncCheckpointStore) {}

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
