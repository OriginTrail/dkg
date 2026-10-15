// SPDX-License-Identifier: Apache-2.0

/**
 * #3264: a member of a REGISTERED public Context Graph that holds no `_meta`
 * pulls the declaration from its connected peers, as a member of an
 * unregistered graph does.
 *
 * The chain proves the graph's policy, not its declaration. The readiness
 * confirmation (`hasConfirmedMetaState`) is true for such a replica on the
 * chain proof alone, and the bootstrap used to read that as "already
 * confirmed" and ask nobody: the member listed the graph without an access
 * policy, its writes were refused as unknown, and the graph never became
 * synced (devnet suite of #3261, cases 7 and 8). The fake agent below answers
 * that confirmation with `true` throughout.
 */
import {
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import { holdsAuthoritativePublicDefinitionV1 } from '../src/context-graph-meta-confirmation.js';
import { Rfc64MetaBootstrapMethods } from '../src/dkg-agent-rfc64-meta-bootstrap.js';

const OWNER = new ethers.Wallet(`0x${'74'.repeat(32)}`).address.toLowerCase() as EvmAddressV1;
const SERVING_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const ON_CHAIN_ID = '7';
const ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
const contextGraphId = `${OWNER}/registered-public` as ContextGraphIdV1;
const metaGraph = contextGraphMetaGraphUri(contextGraphId);
const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
const registeredProof = Object.freeze({ contextGraphId, onChainId: ON_CHAIN_ID });

function metaQuad(predicate: string, object: string): Quad {
  return { subject: contextGraphUri, predicate, object, graph: metaGraph };
}

/** The canonical public declaration: what a replica must hold. */
const CANONICAL_PUBLIC_DECLARATION: readonly Quad[] = Object.freeze([
  metaQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
  metaQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
]);

/** The owner's root `_meta` as a connected peer serves it, chain claims included. */
const SERVED_DECLARATION: readonly Quad[] = Object.freeze([
  ...CANONICAL_PUBLIC_DECLARATION,
  metaQuad(DKG_ONTOLOGY.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
  metaQuad(DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, '"registered"'),
  metaQuad(ON_CHAIN_ID_PREDICATE, `"${ON_CHAIN_ID}"`),
]);

interface AcceptedPolicyShape {
  readonly policy: { readonly accessPolicy: 0 | 1; readonly source: { readonly kind: string } };
}

interface BootstrapAgentOptions {
  /** What the one connected peer serves for the graph's `_meta`. */
  readonly served?: readonly Quad[];
  /** The accepted RFC-64 policy snapshot, `null` until the catalog holds one. */
  readonly accepted?: AcceptedPolicyShape | null;
}

function createBootstrapAgent(store: OxigraphStore, options: BootstrapAgentOptions = {}) {
  const fetchSyncPages = vi.fn(async () => ({
    quads: [...(options.served ?? SERVED_DECLARATION)],
    checkpointKey: 'registered-public-checkpoint',
    resumedFromOffset: 0,
    completed: true,
  }));
  const refreshMetaSyncedFlags = vi.fn(async () => undefined);
  const log = { warn: vi.fn(), info: vi.fn() };
  const surface = {
    store,
    log,
    peerId: 'local-peer',
    localContextGraphProvenance: { hasLocalCreate: () => false },
    subscribedContextGraphs: new Map([[contextGraphId, { subscribed: true }]]),
    readAcceptedRfc64CatalogAccessSnapshotV1: () => options.accepted ?? null,
    // Readable by chain proof: the answer that used to end the pull.
    hasConfirmedMetaState: vi.fn(async () => true),
    resolveRfc64UnregisteredAuthoritySeedPeersV1: () => [SERVING_PEER_ID],
    refreshMetaSyncedFlags,
    // The curator refresh's surface (as in rfc64-meta-bootstrap-binding-guard.test.ts).
    metaRefreshTimestamps: new Map<string, number>(),
    runContextGraphSyncWithBackpressure: async <T>(
      _ctx: OperationContext,
      _contextGraphId: string,
      _lane: 'durable',
      _label: string,
      work: () => Promise<T>,
    ): Promise<T> => work(),
    node: {
      libp2p: {
        getConnections: () => [{ remotePeer: { toString: () => SERVING_PEER_ID } }],
      },
    },
    discovery: {},
    fetchSyncPages,
    oversizeTombstoneLog: { record: () => undefined },
    invalidateListContextGraphsCache: () => undefined,
    contextGraphMetaProjection: { markDirty: () => undefined },
    bindSubscriptionOnChainId: vi.fn(),
    recordCgWireId: vi.fn(),
    persistContextGraphSubscription: vi.fn(),
    syncCheckpoints: new Map<string, number>(),
  };
  // The real method chain over this surface; own data properties shadow the
  // base class accessors.
  const agent = Object.defineProperties(
    Object.create(Rfc64MetaBootstrapMethods.prototype) as object,
    Object.getOwnPropertyDescriptors(surface),
  ) as unknown as DKGAgent;
  return { agent, fetchSyncPages, refreshMetaSyncedFlags, log };
}

function bootstrap(agent: DKGAgent, proof?: typeof registeredProof) {
  return agent.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId, undefined, proof);
}

async function rootMetaRows(store: OxigraphStore): Promise<Array<{ p: string; o: string }>> {
  const result = await store.query(
    `SELECT ?p ?o WHERE { GRAPH <${metaGraph}> { <${contextGraphUri}> ?p ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected _meta bindings');
  return result.bindings.map((row) => ({ p: row['p']!, o: row['o']! }));
}

describe('RFC-64 metadata bootstrap of a registered public graph (#3264)', () => {
  it('pulls the declaration from a connected peer although the chain proof already confirms the graph', async () => {
    const store = new OxigraphStore();
    try {
      const harness = createBootstrapAgent(store);

      await expect(bootstrap(harness.agent, registeredProof)).resolves.toBe('fetched');

      expect(harness.fetchSyncPages).toHaveBeenCalledOnce();
      const rows = await rootMetaRows(store);
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.RDF_TYPE, o: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH });
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: '"public"' });
      expect(rows).toContainEqual({ p: DKG_ONTOLOGY.DKG_CURATOR, o: `did:dkg:agent:${OWNER}` });
      // The serving peer is not chain truth: its registration claims stay out.
      expect(rows.some((row) => row.p === ON_CHAIN_ID_PREDICATE)).toBe(false);
      expect(rows.some((row) => row.p === DKG_ONTOLOGY.DKG_REGISTRATION_STATUS)).toBe(false);
      expect(harness.refreshMetaSyncedFlags).toHaveBeenCalledWith([contextGraphId]);
      expect(String(harness.log.info.mock.calls.at(-1)?.[1]))
        .toContain(`RFC-64 metadata bootstrap for "${contextGraphId}" installed the public declaration`);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(true);
    } finally {
      await store.close();
    }
  });

  it('pulls it at receiver activation too, from the accepted finalized-chain policy without a subscribe proof', async () => {
    const store = new OxigraphStore();
    try {
      const harness = createBootstrapAgent(store, {
        accepted: { policy: { accessPolicy: 0, source: { kind: 'finalized-chain' } } },
      });

      await expect(bootstrap(harness.agent)).resolves.toBe('fetched');

      expect(harness.fetchSyncPages).toHaveBeenCalledOnce();
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(true);
    } finally {
      await store.close();
    }
  });

  it('asks nobody once the declaration is held', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([...CANONICAL_PUBLIC_DECLARATION]);
      const harness = createBootstrapAgent(store);

      await expect(bootstrap(harness.agent, registeredProof)).resolves.toBe('already-confirmed');

      expect(harness.fetchSyncPages).not.toHaveBeenCalled();
      expect(harness.refreshMetaSyncedFlags).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it('keeps a miss a miss: a peer that serves no public declaration installs nothing', async () => {
    const store = new OxigraphStore();
    try {
      const harness = createBootstrapAgent(store, { served: [] });

      await expect(bootstrap(harness.agent, registeredProof)).resolves.toBe('not-found');

      expect(await rootMetaRows(store)).toEqual([]);
      expect(harness.refreshMetaSyncedFlags).not.toHaveBeenCalled();
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(false);
    } finally {
      await store.close();
    }
  });

  it('holds the definition only with both canonical facts and no contradicting policy', async () => {
    const store = new OxigraphStore();
    try {
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(false);
      await store.insert([metaQuad(DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH)]);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(false);
      await store.insert([metaQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"')]);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(true);
      await store.insert([metaQuad(DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"private"')]);
      await expect(holdsAuthoritativePublicDefinitionV1(store, contextGraphId)).resolves.toBe(false);
    } finally {
      await store.close();
    }
  });
});
