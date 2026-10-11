// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, assertSafeIri,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, createOperationContext,
} from '@origintrail-official/dkg-core';
import { CONTEXT_GRAPH_AUTHORITY_RPC_SITES, withRpcUsageSite, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { hasPersistenceBarrier, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import type { ContextGraphSub } from '../../dkg-agent-types.js';
import {
  ContextGraphBindingState, isCanonicalAuthoritativeContextGraphId,
  localContextGraphIdMatchesCommittedNameHash,
} from '../../context-graph-binding-state.js';
import { stripLiteral } from '../../dkg-agent-utils.js';
import { confirmContextGraphMetadataV1 } from '../../context-graph-meta-confirmation.js';
import { buildAuthoritativePrivateMetaAskQuery } from '../../context-graph-private-meta-proof.js';
import { buildAuthoritativePublicMetaAskQuery } from '../../context-graph-public-meta-proof.js';
import type { ActivePublicContextGraphChainProof } from '../../active-public-context-graph-chain-proof.js';

const ID = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
const HASH = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`;
export type MetadataRegistration =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'registered'; readonly onChainId: string; readonly onChainHash: string };

/** Exactly one id and one hash form a registration. Partial/duplicate claims never do. */
export function parseMetadataRegistration(rows: readonly { predicate: string; value: string }[]): MetadataRegistration {
  if (rows.length === 0) return { kind: 'absent' };
  if (rows.length !== 2) return { kind: 'invalid' };
  const ids = rows.filter((row) => row.predicate === ID);
  const hashes = rows.filter((row) => row.predicate === HASH);
  if (ids.length !== 1 || hashes.length !== 1) return { kind: 'invalid' };
  if (!/^"[1-9][0-9]{0,77}"(?:\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#(?:string|integer|positiveInteger|nonNegativeInteger|unsignedLong)>)?$/.test(ids[0]!.value)
    || !/^"0x[0-9a-fA-F]{64}"(?:\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#string>)?$/.test(hashes[0]!.value)) return { kind: 'invalid' };
  const onChainId = stripLiteral(ids[0]!.value);
  const onChainHash = stripLiteral(hashes[0]!.value).toLowerCase();
  return isCanonicalAuthoritativeContextGraphId(onChainId) && /^0x[0-9a-f]{64}$/.test(onChainHash)
    ? { kind: 'registered', onChainId, onChainHash } : { kind: 'invalid' };
}

export function snapshotMetadataRegistration(contextGraphId: string, quads: readonly Quad[]): MetadataRegistration {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const graph = contextGraphMetaGraphUri(contextGraphId);
  return parseMetadataRegistration(quads.filter((q) => q.subject === subject && q.graph === graph
    && (q.predicate === ID || q.predicate === HASH)).map((q) => ({ predicate: q.predicate, value: q.object })));
}

/** Two indexed predicate lookups, bounded before materialization; three rows prove corruption. */
export async function readMetadataRegistration(store: TripleStore, contextGraphId: string): Promise<MetadataRegistration> {
  const graph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
  const root = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const result = await store.query(`SELECT ?predicate ?value WHERE {
    { GRAPH <${graph}> { <${root}> <${ID}> ?value } BIND(<${ID}> AS ?predicate) }
    UNION { GRAPH <${graph}> { <${root}> <${HASH}> ?value } BIND(<${HASH}> AS ?predicate) }
  } LIMIT 3`, { source: 'agent.metadataReadiness.registration' });
  if (result.type !== 'bindings') return { kind: 'invalid' };
  return parseMetadataRegistration(result.bindings.map((row) => ({ predicate: row['predicate'] ?? '', value: row['value'] ?? '' })));
}

interface MetadataReadinessHost {
  readonly store: TripleStore;
  readonly chain: ChainAdapter;
  readonly contextGraphBindingState: ContextGraphBindingState;
  readonly subscribedContextGraphs: Map<string, ContextGraphSub>;
  readonly config: { readonly contextGraphSubscriptionStore?: unknown };
  readonly peerId: string;
  readonly localApprovedAgentByCG: ReadonlyMap<string, string>;
  isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
  resolveActivePublicContextGraphChainProof(contextGraphId: string, ctx: ReturnType<typeof createOperationContext>): Promise<ActivePublicContextGraphChainProof>;
  isWireIdKeyedSubscription?(contextGraphId: string): boolean;
  setContextGraphSubscription(contextGraphId: string, next: ContextGraphSub, options?: { persist?: boolean }): ContextGraphSub;
  persistContextGraphSubscriptionProjectionStrict(input: {
    contextGraphId: string; subscription: ContextGraphSub; isCurrent: () => boolean;
    requireDurableMemberIntent: boolean; operation: 'metadata readiness';
  }): Promise<void>;
  hasConfirmedMetaState(contextGraphId: string): Promise<boolean>;
  announceJoinMetadataConfirmedV1(contextGraphId: string): void;
  reconcileRfc64CatalogResponsibilityV1(contextGraphId: string): Promise<void>;
  queueSharedMemoryGossipSubscription(contextGraphId: string): void;
}
export interface MetadataReadinessCapture {
  readonly subscription: ContextGraphSub | undefined;
  readonly generation: number;
  readonly onChainId: string | undefined;
  readonly onChainHash: string | undefined;
}
const quarantines = new WeakMap<object, Set<string>>();
function quarantine(host: object): Set<string> {
  let state = quarantines.get(host);
  if (!state) { state = new Set(); quarantines.set(host, state); }
  return state;
}
export function captureMetadataReadiness(target: object, contextGraphId: string): MetadataReadinessCapture {
  const host = target as MetadataReadinessHost;
  const subscription = host.subscribedContextGraphs?.get(contextGraphId);
  return { subscription, generation: host.contextGraphBindingState?.capture(contextGraphId) ?? 0,
    onChainId: subscription?.onChainId, onChainHash: subscription?.onChainHash };
}
export function metadataReadinessCaptureIsCurrent(target: object, contextGraphId: string, captured: MetadataReadinessCapture): boolean {
  const host = target as MetadataReadinessHost;
  const current = host.subscribedContextGraphs?.get(contextGraphId);
  return current === captured.subscription && current?.onChainId === captured.onChainId
    && current?.onChainHash === captured.onChainHash
    && (host.contextGraphBindingState?.isGenerationCurrent(contextGraphId, captured.generation) ?? true);
}

async function proveRegistration(host: MetadataReadinessHost, contextGraphId: string, registration: MetadataRegistration): Promise<boolean> {
  if (registration.kind !== 'registered') return false;
  if (!host.chain?.getContextGraphNameHash || !localContextGraphIdMatchesCommittedNameHash(
    contextGraphId, registration.onChainHash, (id) => host.isWireIdKeyedSubscription?.(id) === true,
  )) return false;
  const hash = await withRpcUsageSite(CONTEXT_GRAPH_AUTHORITY_RPC_SITES.readRegistered,
    () => host.chain.getContextGraphNameHash!(BigInt(registration.onChainId)));
  return hash?.toLowerCase() === registration.onChainHash;
}

/** One serving fence for reads, public sync and gossip, including after restart. */
export async function hasReadyMetadataRegistration(target: object, contextGraphId: string): Promise<boolean> {
  if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return true;
  const host = target as MetadataReadinessHost;
  if (quarantine(host).has(contextGraphId)) return false;
  const captured = captureMetadataReadiness(host, contextGraphId);
  const registration = await readMetadataRegistration(host.store, contextGraphId);
  if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) return false;
  if (registration.kind === 'absent') return captured.onChainId === undefined;
  if (registration.kind !== 'registered' || !captured.subscription
    || (!captured.subscription.subscribed && !captured.subscription.coreHosted)
    || captured.subscription.metaSynced !== true
    || registration.onChainId !== captured.onChainId
    || registration.onChainHash !== captured.onChainHash?.toLowerCase()) return false;
  try {
    return await proveRegistration(host, contextGraphId, registration)
      && !quarantine(host).has(contextGraphId)
      && metadataReadinessCaptureIsCurrent(host, contextGraphId, captured);
  } catch { return false; }
}

/** Quarantine before the durable false write; never expose a speculative new binding. */
export async function beginMetadataReplacement(target: object, contextGraphId: string, captured: MetadataReadinessCapture): Promise<MetadataReadinessCapture> {
  const host = target as MetadataReadinessHost;
  if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) throw new Error('Metadata registration generation moved');
  quarantine(host).add(contextGraphId);
  if (!captured.subscription || (!captured.subscription.subscribed && !captured.subscription.coreHosted)) return captured;
  const next = { ...captured.subscription, metaSynced: false };
  await host.persistContextGraphSubscriptionProjectionStrict({ contextGraphId, subscription: next,
    isCurrent: () => metadataReadinessCaptureIsCurrent(host, contextGraphId, captured),
    requireDurableMemberIntent: false, operation: 'metadata readiness' });
  if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) throw new Error('Metadata registration moved during quarantine');
  host.setContextGraphSubscription(contextGraphId, next, { persist: false });
  return captureMetadataReadiness(host, contextGraphId);
}

/** RDF durability precedes the final store-first subscription commit and canonical publication. */
export async function completeMetadataReplacement(target: object, contextGraphId: string, captured: MetadataReadinessCapture, registration: MetadataRegistration): Promise<void> {
  const host = target as MetadataReadinessHost;
  if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) throw new Error('Metadata registration generation moved');
  if (registration.kind === 'invalid') throw new Error('Invalid curator registration tuple');
  if (registration.kind === 'registered' && !(await proveRegistration(host, contextGraphId, registration))) {
    throw new Error('Curator registration is not proven by the live chain');
  }
  if (!hasPersistenceBarrier(host.store)) throw new Error('Metadata readiness requires a certified persistence barrier');
  await host.store.flush!({ source: 'agent.metadataReadiness.flush' });
  if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) throw new Error('Metadata registration moved during flush');
  if (captured.subscription && (captured.subscription.subscribed || captured.subscription.coreHosted)) {
    const next = { ...captured.subscription, metaSynced: true, pendingMeta: false,
      ...(registration.kind === 'registered' ? { onChainId: registration.onChainId, onChainHash: registration.onChainHash } : {}) };
    await host.persistContextGraphSubscriptionProjectionStrict({ contextGraphId, subscription: next,
      isCurrent: () => metadataReadinessCaptureIsCurrent(host, contextGraphId, captured),
      requireDurableMemberIntent: false, operation: 'metadata readiness' });
    if (!metadataReadinessCaptureIsCurrent(host, contextGraphId, captured)) throw new Error('Metadata registration moved during readiness save');
    host.setContextGraphSubscription(contextGraphId, next, { persist: false });
  } else if (registration.kind === 'registered') {
    if (!captured.subscription) throw new Error('Registered metadata has no subscription or host identity');
    // Passive catalog enrichment grants no readiness or durable member intent.
    // Its identity is useful locally, but later activation must run this full
    // protocol before serving. Never manufacture an active subscription here.
    host.setContextGraphSubscription(contextGraphId, { ...captured.subscription,
      onChainId: registration.onChainId, onChainHash: registration.onChainHash, metaSynced: false }, { persist: false });
  }
  quarantine(host).delete(contextGraphId);
}

/** Catch-up can commit aligned evidence, but cannot repair a mismatch or quarantine. */
export async function refreshReadyMetadataFlags(target: object, contextGraphIds: Iterable<string>): Promise<void> {
  const host = target as MetadataReadinessHost;
  for (const id of contextGraphIds) {
    const captured = captureMetadataReadiness(host, id);
    const sub = captured.subscription;
    if (!sub || (!sub.subscribed && !sub.coreHosted) || quarantine(host).has(id)) continue;
    const registration = await readMetadataRegistration(host.store, id);
    if (registration.kind === 'invalid' || (registration.kind === 'absent' && captured.onChainId !== undefined)
      || (registration.kind === 'registered' && (registration.onChainId !== captured.onChainId
        || registration.onChainHash !== captured.onChainHash?.toLowerCase()))) continue;
    const definitions = await Promise.all([
      host.store.query(buildAuthoritativePublicMetaAskQuery(id), { source: 'agent.metadataReadiness.publicDefinition' }),
      host.store.query(buildAuthoritativePrivateMetaAskQuery(id), { source: 'agent.metadataReadiness.privateDefinition' }),
    ]);
    if (!definitions.some((result) => result.type === 'boolean' && result.value)) continue;
    if (!(await confirmContextGraphMetadataV1({ chain: host.chain, store: host.store,
      peerId: host.peerId, subscriptions: host.subscribedContextGraphs,
      localApprovedAgentByContextGraph: host.localApprovedAgentByCG,
      isPrivateContextGraph: (cg) => host.isPrivateContextGraph(cg),
      resolveActivePublicChainProof: () => host.resolveActivePublicContextGraphChainProof(id, createOperationContext('sync')),
    }, id)) || !metadataReadinessCaptureIsCurrent(host, id, captured)) continue;
    const pending = sub.metaSynced !== true || sub.pendingMeta === true;
    if (pending) {
      await completeMetadataReplacement(host, id, captured, registration);
      host.announceJoinMetadataConfirmedV1(id);
    }
    await host.reconcileRfc64CatalogResponsibilityV1(id);
    host.queueSharedMemoryGossipSubscription(id);
  }
}

/** Binding readiness also gates curated gossip; a populated allowlist is no exemption. */
export async function admitsMetadataGossip(input: {
  readonly contextGraphId: string;
  readonly allowedPeers: readonly string[] | null;
  readonly subscription: ContextGraphSub | undefined;
  readonly ready?: (id: string) => Promise<boolean>;
  readonly confirmed?: (id: string) => Promise<boolean>;
  readonly setSubscription: (next: ContextGraphSub) => void;
  readonly warn: (message: string) => void;
}): Promise<boolean> {
  const id = input.contextGraphId;
  if (input.ready && !(await input.ready(id))) {
    input.warn(`Gossip publish deferred: metadata registration for "${id}" is not ready`);
    return false;
  }
  // CGs whose _meta hasn't been fetched yet: deny until _meta sync completes.
  // A null allowlist with metaSynced=false could mean the CG is curated but
  // the allowlist hasn't arrived via authenticated sync. System graphs are
  // exempt. Standalone handlers retain their historical lazy confirmation;
  // agent-backed confirmation now includes the durable registration fence.
  if (input.allowedPeers === null && !(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(id)
    && input.subscription?.metaSynced === false) {
    if (!input.confirmed || !(await input.confirmed(id))) {
      input.warn(`Gossip publish deferred: context graph "${id}" _meta not yet synced — defaulting to deny`);
      return false;
    }
    input.setSubscription({ ...input.subscription, metaSynced: true });
  }
  return true;
}
