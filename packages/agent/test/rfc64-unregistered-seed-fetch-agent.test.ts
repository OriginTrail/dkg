// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-level unit coverage for the RFC-64 seed fetch mixin
 * (`Rfc64SeedFetchMethods`) without a libp2p node: the provider-side compat
 * fallback gate (created / subscribed / core-hosted only, never a gossip
 * discovery row), its single-flight and bounded negative cache, the deprecated
 * ontology read and literal decoder, the once-per-scope write-through, replica
 * peer selection, and the replica fetch outcomes that never reach the network.
 */
import {
  contextGraphDataGraphUri,
  PROTOCOL_STORAGE_ACK,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/dkg-agent.js';
import { ACKCapabilityRegistry } from '../src/p2p/ack-capability.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_COMPAT_NEGATIVE_TTL_MS_V1,
  RFC64_UNREGISTERED_AUTHORITY_RESERVED_NON_CORE_PEERS_V1,
  Rfc64SeedFetchMethods,
} from '../src/dkg-agent-rfc64-seed-fetch.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1,
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
} from '../src/rfc64/unregistered-authority-transport-v1.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  mintRfc64UnregisteredReplicaAuthoritySeedV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${OWNER}/seed-serve` as ContextGraphIdV1;
const SCOPE = Object.freeze({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID });
const SERVE_SOURCE = 'agent.rfc64.unregisteredAuthoritySeedServe';

afterEach(() => {
  vi.restoreAllMocks();
});

type Literals = readonly string[] | (() => readonly string[]);

interface FakeAgentOptions {
  readonly created?: readonly string[];
  readonly subscriptions?: Readonly<Record<string, { subscribed?: boolean; coreHosted?: boolean }>>;
  readonly literals?: Literals;
  readonly queryResult?: unknown;
  readonly storedSeed?: Uint8Array | null;
  readonly persistFailure?: Error;
  readonly networkId?: string;
  readonly service?: { fetchUnregisteredAuthorityFromPeers: ReturnType<typeof vi.fn> } | undefined;
  readonly libp2p?: unknown;
  readonly corePeerIds?: readonly string[];
  readonly rejectedPeerIds?: readonly string[];
  readonly coordinator?: boolean;
  /** Configured complete SWM providers per graph (accepted-policy pins). */
  readonly completeProviders?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The mixin prototype plus the handful of agent fields the fetch methods read
 * (the same stand-in shape the other RFC-64 mixin tests use). The keyed store
 * is an in-memory map behind the two F2 contract methods so a write-through
 * turns the next serve read into a keyed hit exactly like the real store.
 */
function createFetchAgent(options: FakeAgentOptions = {}) {
  const agent = Object.create(Rfc64SeedFetchMethods.prototype) as DKGAgent;
  const persisted = new Map<string, Uint8Array>();
  const query = vi.fn(async (_sparql: string, queryOptions?: { source?: string; signal?: AbortSignal }) => {
    if (queryOptions?.source !== SERVE_SOURCE) {
      throw new Error(`unexpected query source ${queryOptions?.source}`);
    }
    if (options.queryResult !== undefined) return options.queryResult;
    const literals = typeof options.literals === 'function' ? options.literals() : options.literals ?? [];
    return {
      type: 'bindings' as const,
      bindings: literals.map((evidence) => ({ evidence: `"${evidence}"` })),
    };
  });
  const read = vi.fn(async (input: { networkId: string; contextGraphId: string }) =>
    persisted.get(input.contextGraphId) ?? options.storedSeed ?? null);
  const persist = vi.fn(async (input: { contextGraphId: string; canonicalEnvelopeBytes: Uint8Array }) => {
    if (options.persistFailure !== undefined) throw options.persistFailure;
    persisted.set(input.contextGraphId, Uint8Array.from(input.canonicalEnvelopeBytes));
  });
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const created = new Set(options.created ?? []);
  const corePeerIds = new Set(options.corePeerIds ?? []);
  const rejected = new Set(options.rejectedPeerIds ?? []);
  Reflect.set(agent, 'store', { query });
  Reflect.set(agent, 'readRfc64UnregisteredAuthoritySeedV1', read);
  Reflect.set(agent, 'persistVerifiedRfc64UnregisteredAuthoritySeedV1', persist);
  Reflect.set(agent, 'localContextGraphProvenance', {
    hasLocalCreate: (contextGraphId: string) => created.has(contextGraphId),
  });
  Reflect.set(agent, 'subscribedContextGraphs', new Map(Object.entries(options.subscriptions ?? {})));
  Reflect.set(agent, 'log', log);
  Reflect.set(agent, 'config', {
    rfc64CatalogDeploymentProfile: { networkId: options.networkId ?? NETWORK_ID },
  });
  // A getter on the base class: shadow it with an own data property.
  Object.defineProperty(agent, 'rfc64PublicCatalogServiceV1', {
    value: options.service,
    configurable: true,
  });
  Reflect.set(agent, 'node', options.libp2p === undefined ? undefined : { libp2p: options.libp2p });
  const ackCapabilities = new ACKCapabilityRegistry();
  for (const peerId of corePeerIds) ackCapabilities.reconcile(peerId, [PROTOCOL_STORAGE_ACK]);
  Reflect.set(agent, 'ackCapabilityRegistry', ackCapabilities);
  Reflect.set(agent, 'peerCapabilityRegistry', ackCapabilities);
  if (options.completeProviders !== undefined) {
    const completeProviders = options.completeProviders;
    Reflect.set(agent, 'rfc64SwmRecoveryRuntimeV1', {
      resolveConfiguredCompleteProviderPeerIds: (contextGraphId: string) =>
        completeProviders[contextGraphId] ?? [],
    });
  }
  Reflect.set(
    agent,
    'networkAdmissionCoordinator',
    options.coordinator === false
      ? undefined
      : { isRejectedPeer: (peerId: string) => rejected.has(peerId) },
  );
  return { agent, query, read, persist, persisted, log };
}

async function mintSeed(input: Readonly<{
  readonly wallet?: ethers.Wallet;
  readonly owner?: EvmAddressV1;
  readonly contextGraphId?: ContextGraphIdV1;
  readonly publishPolicy?: 0 | 1;
}> = {}) {
  const wallet = input.wallet ?? OWNER_WALLET;
  const owner = input.owner ?? OWNER;
  return mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId: input.contextGraphId ?? CONTEXT_GRAPH_ID,
    ownerAddress: owner,
    accessPolicy: 0,
    publishPolicy: input.publishPolicy ?? 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: owner,
      signDigest: (digest) => wallet.signMessage(digest),
    },
  });
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(Buffer.from(right));
}

describe('Rfc64SeedFetchMethods provider-side compat fallback', () => {
  it('serves the ontology copy of a locally created graph once and writes it through', async () => {
    const seed = await mintSeed();
    const { agent, query, read, persist } = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      literals: [seed.evidence],
    });

    const served = await agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE);

    expect(bytesEqual(served, seed.canonicalEnvelopeBytes)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sparql, queryOptions] = query.mock.calls[0]!;
    expect(sparql).toContain(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1);
    expect(sparql).toContain(contextGraphDataGraphUri(CONTEXT_GRAPH_ID));
    expect(sparql).toContain(contextGraphDataGraphUri('ontology'));
    expect((queryOptions as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]![0]).toMatchObject({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID });
    expect(bytesEqual(persist.mock.calls[0]![0].canonicalEnvelopeBytes, seed.canonicalEnvelopeBytes)).toBe(true);

    // The write-through made the next request a keyed point lookup.
    const again = await agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE);
    expect(bytesEqual(again, seed.canonicalEnvelopeBytes)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('runs the ontology read once for an absent scope across consecutive and concurrent queries', async () => {
    // Pin the clock before the first read so the negative entry is stamped at
    // `base`; on a slow runner real time can advance >= 1 ms between the read
    // and the assertions below, which would expire the entry early.
    const base = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(base);
    const consecutive = createFetchAgent({ created: [CONTEXT_GRAPH_ID], literals: [] });
    await expect(consecutive.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    await expect(consecutive.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(consecutive.query).toHaveBeenCalledTimes(1);
    expect(consecutive.persist).not.toHaveBeenCalled();

    // The negative entry expires: one more read is allowed after the TTL.
    now.mockReturnValue(base + RFC64_UNREGISTERED_AUTHORITY_COMPAT_NEGATIVE_TTL_MS_V1 - 1);
    await expect(consecutive.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(consecutive.query).toHaveBeenCalledTimes(1);
    now.mockReturnValue(base + RFC64_UNREGISTERED_AUTHORITY_COMPAT_NEGATIVE_TTL_MS_V1 + 1);
    await expect(consecutive.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(consecutive.query).toHaveBeenCalledTimes(2);
    now.mockRestore();

    // Single-flight: concurrent requesters share one read and its verifications.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = createFetchAgent({ created: [CONTEXT_GRAPH_ID] });
    concurrent.query.mockImplementation(async (_sparql: string, queryOptions?: { source?: string }) => {
      if (queryOptions?.source !== SERVE_SOURCE) throw new Error('unexpected query source');
      await gate;
      return { type: 'bindings' as const, bindings: [] };
    });
    const pending = Promise.all([
      concurrent.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      concurrent.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      concurrent.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
    ]);
    release!();
    await expect(pending).resolves.toEqual([null, null, null]);
    expect(concurrent.query).toHaveBeenCalledTimes(1);
  });

  it('never consults the ontology for a graph this node neither created, subscribes to nor hosts', async () => {
    const seed = await mintSeed();
    // A gossip discovery row (`subscribed: false`) is unauthenticated data and
    // must not let a stranger steer this node's ontology reads.
    const discoveryOnly = createFetchAgent({
      subscriptions: { [CONTEXT_GRAPH_ID]: { subscribed: false } },
      literals: [seed.evidence],
    });
    await expect(discoveryOnly.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(discoveryOnly.query).not.toHaveBeenCalled();
    expect(discoveryOnly.persist).not.toHaveBeenCalled();

    const unknown = createFetchAgent({ literals: [seed.evidence] });
    await expect(unknown.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(unknown.query).not.toHaveBeenCalled();

    const subscribed = createFetchAgent({
      subscriptions: { [CONTEXT_GRAPH_ID]: { subscribed: true } },
      literals: [seed.evidence],
    });
    expect(bytesEqual(
      await subscribed.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      seed.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(subscribed.query).toHaveBeenCalledTimes(1);

    const hosted = createFetchAgent({
      subscriptions: { [CONTEXT_GRAPH_ID]: { subscribed: false, coreHosted: true } },
      literals: [seed.evidence],
    });
    expect(bytesEqual(
      await hosted.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      seed.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(hosted.query).toHaveBeenCalledTimes(1);
  });

  it('serves nothing for conflicting generations or an over-bound row set, and only the valid seed beside attacker rows', async () => {
    const valid = await mintSeed({ publishPolicy: 1 });
    const other = await mintSeed({ publishPolicy: 0 });
    const attacker = await mintSeed({ wallet: ATTACKER_WALLET, owner: ATTACKER });
    expect(other.policyDigest).not.toBe(valid.policyDigest);

    const conflicting = createFetchAgent({ created: [CONTEXT_GRAPH_ID], literals: [valid.evidence, other.evidence] });
    await expect(conflicting.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(conflicting.persist).not.toHaveBeenCalled();

    const mixed = createFetchAgent({ created: [CONTEXT_GRAPH_ID], literals: [attacker.evidence, valid.evidence] });
    expect(bytesEqual(
      await mixed.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      valid.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(mixed.persist).toHaveBeenCalledOnce();

    const overBound = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      literals: Array.from({ length: 33 }, () => valid.evidence),
    });
    await expect(overBound.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
    expect(overBound.persist).not.toHaveBeenCalled();

    const attackerOnly = createFetchAgent({ created: [CONTEXT_GRAPH_ID], literals: [attacker.evidence] });
    await expect(attackerOnly.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();

    const nonBindings = createFetchAgent({ created: [CONTEXT_GRAPH_ID], queryResult: { type: 'boolean', value: true } });
    await expect(nonBindings.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE)).resolves.toBeNull();
  });

  it('skips literals that are not canonical bounded base64url and still serves the one valid row', async () => {
    const valid = await mintSeed();
    const oversizeChars = 'A'.repeat(Math.ceil(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 * 4 / 3) + 8);
    const { agent, persist } = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      literals: [
        'not base64url!!',
        // Decodes to one byte and re-encodes as "AA": not canonical.
        'AB',
        oversizeChars,
        // Empty lexical form.
        '',
        valid.evidence,
      ],
    });
    // The fake wraps every literal in quotes; the empty and typed forms are
    // exercised through the decoder's own lexical guard.
    expect(bytesEqual(
      await agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      valid.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(persist).toHaveBeenCalledOnce();

    // A row whose lexical form is not a plain or typed string literal is skipped.
    const untyped = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      queryResult: {
        type: 'bindings',
        bindings: [
          { evidence: '<https://example.invalid/not-a-literal>' },
          {},
          { evidence: `"${valid.evidence}"^^<http://www.w3.org/2001/XMLSchema#string>` },
        ],
      },
    });
    expect(bytesEqual(
      await untyped.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      valid.canonicalEnvelopeBytes,
    )).toBe(true);
  });

  it('contains a failing write-through at debug, attempts it once, and still serves the compat copy', async () => {
    const seed = await mintSeed();
    const { agent, query, persist, log } = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      literals: [seed.evidence],
      persistFailure: new Error('inventory is closed'),
    });

    expect(bytesEqual(
      await agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      seed.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledOnce();
    expect(String(log.debug.mock.calls[0]?.[1])).toMatch(/write-through failed.*inventory is closed/u);

    // The keyed store still misses, so the compat copy is served again, but
    // the write-through is not retried on the request path.
    expect(bytesEqual(
      await agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      seed.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('bounds the negative cache and evicts the oldest remembered absence first', async () => {
    const graphs = Array.from({ length: 1_025 }, (_, index) => `${OWNER}/absent-${index}` as ContextGraphIdV1);
    const { agent, query } = createFetchAgent({ created: graphs, literals: [] });
    for (const contextGraphId of graphs) {
      await expect(agent.readRfc64UnregisteredAuthoritySeedForServingV1({
        networkId: NETWORK_ID,
        contextGraphId,
      })).resolves.toBeNull();
    }
    expect(query).toHaveBeenCalledTimes(graphs.length);
    // The oldest scope was evicted to make room, so it is read again; the
    // newest is still remembered.
    await agent.readRfc64UnregisteredAuthoritySeedForServingV1({ networkId: NETWORK_ID, contextGraphId: graphs[0]! });
    expect(query).toHaveBeenCalledTimes(graphs.length + 1);
    await agent.readRfc64UnregisteredAuthoritySeedForServingV1({ networkId: NETWORK_ID, contextGraphId: graphs.at(-1)! });
    expect(query).toHaveBeenCalledTimes(graphs.length + 1);
  });

  it('surfaces the requester abort after the shared read settles and prefers a keyed hit over the ontology', async () => {
    const seed = await mintSeed();
    const aborted = createFetchAgent({ created: [CONTEXT_GRAPH_ID], literals: [seed.evidence] });
    await expect(aborted.agent.readRfc64UnregisteredAuthoritySeedForServingV1(
      SCOPE,
      AbortSignal.abort(new Error('stream closed by peer')),
    )).rejects.toThrow(/stream closed by peer/u);

    const stored = createFetchAgent({
      created: [CONTEXT_GRAPH_ID],
      literals: [seed.evidence],
      storedSeed: seed.canonicalEnvelopeBytes,
    });
    expect(bytesEqual(
      await stored.agent.readRfc64UnregisteredAuthoritySeedForServingV1(SCOPE),
      seed.canonicalEnvelopeBytes,
    )).toBe(true);
    expect(stored.query).not.toHaveBeenCalled();
  });
});

describe('Rfc64SeedFetchMethods replica peer selection', () => {
  function libp2pWith(input: Readonly<{
    readonly self: string;
    readonly peers: readonly string[];
    readonly connections?: readonly string[];
  }>) {
    const libp2p: Record<string, unknown> = {
      peerId: { toString: () => input.self },
      getPeers: () => input.peers.map((peerId) => ({ toString: () => peerId })),
    };
    if (input.connections !== undefined) {
      libp2p['getConnections'] = () => input.connections!.map((peerId) => ({
        remotePeer: { toString: () => peerId },
      }));
    }
    return libp2p;
  }

  const CAP = RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1;
  const RESERVED = RFC64_UNREGISTERED_AUTHORITY_RESERVED_NON_CORE_PEERS_V1;

  it('drops self and rejected peers, dedupes, orders cores first, and caps the fan-out', () => {
    const { agent } = createFetchAgent({
      libp2p: libp2pWith({
        self: 'peer-self',
        peers: ['peer-self', 'peer-edge-b', 'peer-core-z', 'peer-rejected'],
        connections: ['peer-edge-a', 'peer-core-a', 'peer-edge-b'],
      }),
      corePeerIds: ['peer-core-a', 'peer-core-z'],
      rejectedPeerIds: ['peer-rejected'],
    });

    const peers = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1();

    expect(peers).toEqual(['peer-core-a', 'peer-core-z', 'peer-edge-a', 'peer-edge-b']);
    expect(Object.isFrozen(peers)).toBe(true);

    const many = Array.from({ length: CAP + 5 }, (_, index) =>
      `peer-${String(index).padStart(2, '0')}`);
    const capped = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: many }),
      corePeerIds: [many.at(-1)!],
    });
    const selected = capped.agent.resolveRfc64UnregisteredAuthoritySeedPeersV1();
    expect(selected).toHaveLength(CAP);
    // The single core peer sorts ahead of every edge regardless of its id;
    // edges backfill every slot the cores cannot use.
    expect(selected[0]).toBe(many.at(-1));
    expect(selected.slice(1)).toEqual(many.slice(0, CAP - 1));
  });

  it('reorders seed fetch peers when shared P2P role evidence changes', () => {
    const { agent } = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: ['peer-edge', 'peer-promoted'] }),
    });
    const capabilities = Reflect.get(agent, 'peerCapabilityRegistry') as ACKCapabilityRegistry;
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(['peer-edge', 'peer-promoted']);
    capabilities.reconcile('peer-promoted', [PROTOCOL_STORAGE_ACK]);
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(['peer-promoted', 'peer-edge']);
    capabilities.reconcile('peer-promoted', ['/dkg/10.0.0/sync']);
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(['peer-edge', 'peer-promoted']);
  });

  it('reserves window slots for non-core peers so a lone edge author is asked in the first window', () => {
    // The review scenario: eight connected cores without the seed and the
    // connected author edge as the ninth peer. Cores-first alone would drop
    // the only seed holder on every attempt.
    const cores = Array.from({ length: CAP }, (_, index) => `peer-core-${index}`);
    const { agent } = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: [...cores, 'peer-edge-author'] }),
      corePeerIds: cores,
    });

    const first = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1();

    expect(first).toHaveLength(CAP);
    expect(first.slice(0, CAP - 1)).toEqual(cores.slice(0, CAP - 1));
    expect(first.at(-1)).toBe('peer-edge-author');
    // Without a scope the selection is the same deterministic first window.
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(first);

    // With enough edges the reserve is exactly RESERVED and cores keep the rest.
    const edges = ['peer-edge-a', 'peer-edge-b', 'peer-edge-c'];
    const crowded = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: [...cores, ...edges] }),
      corePeerIds: cores,
    });
    const window = crowded.agent.resolveRfc64UnregisteredAuthoritySeedPeersV1();
    expect(window).toHaveLength(CAP);
    expect(window.slice(0, CAP - RESERVED)).toEqual(cores.slice(0, CAP - RESERVED));
    expect(window.slice(CAP - RESERVED)).toEqual(edges.slice(0, RESERVED));
  });

  it('rotates each group window across attempts for one scope, keeping the cap and the edge slot', () => {
    const cores = Array.from({ length: 20 }, (_, index) => `peer-core-${String(index).padStart(2, '0')}`);
    const { agent } = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: [...cores, 'peer-edge-author'] }),
      corePeerIds: cores,
    });
    const scope = { contextGraphId: CONTEXT_GRAPH_ID };

    const attempt1 = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1(scope);
    const attempt2 = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1(scope);
    const attempt3 = agent.resolveRfc64UnregisteredAuthoritySeedPeersV1(scope);

    for (const window of [attempt1, attempt2, attempt3]) {
      expect(window).toHaveLength(CAP);
      expect(window.at(-1)).toBe('peer-edge-author');
      expect(Object.isFrozen(window)).toBe(true);
    }
    expect(attempt1.slice(0, CAP - 1)).toEqual(cores.slice(0, CAP - 1));
    expect(attempt2.slice(0, CAP - 1)).toEqual(cores.slice(CAP - 1, 2 * (CAP - 1)));
    expect(attempt2).not.toEqual(attempt1);
    // Two attempts already reach more peers than one window can; three tile
    // every connected core (the last window wraps around).
    expect(new Set([...attempt1, ...attempt2]).size).toBe(2 * (CAP - 1) + 1);
    expect(new Set([...attempt1, ...attempt2, ...attempt3]).size).toBe(cores.length + 1);
    // Another scope starts its own rotation; unscoped callers never rotate.
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({
      contextGraphId: `${OWNER}/other-scope`,
    })).toEqual(attempt1);
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(attempt1);
  });

  it('asks connected configured complete providers first and ignores absent or rejected pins', () => {
    const { agent } = createFetchAgent({
      libp2p: libp2pWith({
        self: 'peer-self',
        peers: ['peer-core-a', 'peer-core-b', 'peer-edge-a', 'peer-provider', 'peer-rejected-provider'],
      }),
      corePeerIds: ['peer-core-a', 'peer-core-b'],
      rejectedPeerIds: ['peer-rejected-provider'],
      completeProviders: {
        [CONTEXT_GRAPH_ID]: ['peer-offline-provider', 'peer-rejected-provider', 'peer-provider'],
      },
    });

    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId: CONTEXT_GRAPH_ID }))
      .toEqual(['peer-provider', 'peer-core-a', 'peer-core-b', 'peer-edge-a']);
    // The hint is scoped: without the graph, or for a graph with no pins, the
    // provider is an ordinary edge peer.
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1())
      .toEqual(['peer-core-a', 'peer-core-b', 'peer-edge-a', 'peer-provider']);
    expect(agent.resolveRfc64UnregisteredAuthoritySeedPeersV1({ contextGraphId: `${OWNER}/unpinned` }))
      .toEqual(['peer-core-a', 'peer-core-b', 'peer-edge-a', 'peer-provider']);
  });

  it('keeps every connected peer without an admission coordinator and yields nothing without libp2p', () => {
    const noCoordinator = createFetchAgent({
      libp2p: libp2pWith({ self: 'peer-self', peers: ['peer-b', 'peer-a'] }),
      coordinator: false,
    });
    expect(noCoordinator.agent.resolveRfc64UnregisteredAuthoritySeedPeersV1()).toEqual(['peer-a', 'peer-b']);

    const offline = createFetchAgent();
    const none = offline.agent.resolveRfc64UnregisteredAuthoritySeedPeersV1();
    expect(none).toEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
  });
});

describe('Rfc64SeedFetchMethods replica fetch outcomes', () => {
  function service(result: unknown = null) {
    return { fetchUnregisteredAuthorityFromPeers: vi.fn(async () => result) };
  }

  it('resolves the exact (network, graph) scope only for wallet-namespaced graphs on a trusted network', () => {
    const { agent } = createFetchAgent();
    expect(agent.resolveRfc64UnregisteredAuthorityScopeV1(CONTEXT_GRAPH_ID)).toEqual(SCOPE);
    expect(agent.resolveRfc64UnregisteredAuthorityScopeV1('plain-global-name')).toBeNull();
    expect(agent.resolveRfc64UnregisteredAuthorityScopeV1('')).toBeNull();
    expect(createFetchAgent({ networkId: 'none' }).agent
      .resolveRfc64UnregisteredAuthorityScopeV1(CONTEXT_GRAPH_ID)).toBeNull();
    expect(createFetchAgent({ networkId: '' }).agent
      .resolveRfc64UnregisteredAuthorityScopeV1(CONTEXT_GRAPH_ID)).toBeNull();
  });

  it('short-circuits before any network I/O when dormant, non-wallet, already present, or peerless', async () => {
    const seed = await mintSeed();

    const dormant = createFetchAgent({ service: undefined });
    await expect(dormant.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1(CONTEXT_GRAPH_ID))
      .resolves.toBe('service-dormant');

    const plain = createFetchAgent({ service: service() });
    await expect(plain.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1('plain-global-name'))
      .resolves.toBe('not-wallet-namespaced');

    const present = createFetchAgent({
      service: service(),
      storedSeed: seed.canonicalEnvelopeBytes,
      libp2p: { peerId: { toString: () => 'self' }, getPeers: () => [{ toString: () => 'peer-a' }] },
    });
    await expect(present.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1(CONTEXT_GRAPH_ID))
      .resolves.toBe('already-present');
    expect(present.read).toHaveBeenCalledOnce();
    expect(present.read.mock.calls[0]![0]).toMatchObject(SCOPE);

    const peerless = createFetchAgent({
      service: service(),
      libp2p: { peerId: { toString: () => 'self' }, getPeers: () => [] },
    });
    await expect(peerless.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1(CONTEXT_GRAPH_ID))
      .resolves.toBe('no-connected-peers');

    for (const { agent } of [plain, present, peerless]) {
      expect((agent as unknown as { rfc64PublicCatalogServiceV1: ReturnType<typeof service> })
        .rfc64PublicCatalogServiceV1.fetchUnregisteredAuthorityFromPeers).not.toHaveBeenCalled();
    }
  });

  it('reports not-found on a miss and persists exactly the verified bytes on a hit', async () => {
    const seed = await mintSeed();
    const libp2p = {
      peerId: { toString: () => 'self' },
      getPeers: () => [{ toString: () => 'peer-b' }, { toString: () => 'peer-a' }],
    };
    const miss = createFetchAgent({ service: service(null), libp2p });
    await expect(miss.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1(CONTEXT_GRAPH_ID))
      .resolves.toBe('not-found');
    expect(miss.persist).not.toHaveBeenCalled();

    const hitService = service({
      remotePeerId: 'peer-a',
      seed: { canonicalBytes: seed.canonicalEnvelopeBytes, policyDigest: seed.policyDigest },
    });
    const hit = createFetchAgent({ service: hitService, libp2p });
    const selectPeers = vi.spyOn(hit.agent, 'resolveRfc64UnregisteredAuthoritySeedPeersV1');
    const signal = new AbortController().signal;
    await expect(hit.agent.fetchRfc64UnregisteredAuthoritySeedFromPeersV1(CONTEXT_GRAPH_ID, signal))
      .resolves.toBe('fetched');
    expect(selectPeers).toHaveBeenCalledWith({ contextGraphId: CONTEXT_GRAPH_ID });
    expect(hitService.fetchUnregisteredAuthorityFromPeers).toHaveBeenCalledOnce();
    expect(hitService.fetchUnregisteredAuthorityFromPeers.mock.calls[0]![0]).toEqual({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      peerIds: ['peer-a', 'peer-b'],
      signal,
    });
    expect(hit.persist).toHaveBeenCalledOnce();
    expect(hit.persist.mock.calls[0]![0]).toMatchObject({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, signal });
    expect(bytesEqual(hit.persist.mock.calls[0]![0].canonicalEnvelopeBytes, seed.canonicalEnvelopeBytes)).toBe(true);
    expect(hit.log.info).toHaveBeenCalledOnce();
    expect(String(hit.log.info.mock.calls[0]?.[1])).toContain('peer-a');
  });
});
