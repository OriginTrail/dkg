import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  ContextGraphNameResolver,
  type ContextGraphNamePolicy,
  type ContextGraphNameResolverDeps,
  type ContextGraphNameSource,
  type ContextGraphNameTarget,
} from '../src/context-graph-name-resolver.js';

const CLEARTEXT = 'acme-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const TARGET: ContextGraphNameTarget = { nameHash: NAME_HASH, onChainId: '33' };

interface Harness {
  deps: ContextGraphNameResolverDeps;
  asked: string[];
  pulled: string[];
  adopted: Array<{ contextGraphId: string; source: ContextGraphNameSource }>;
  targets: ContextGraphNameTarget[];
}

function harness(overrides: Partial<{
  policy: ContextGraphNamePolicy;
  local: string[];
  peers: string[];
  protocols: Record<string, boolean | undefined>;
  answers: Record<string, string | null>;
  ontology: Record<string, Map<string, string> | null>;
  adopt: boolean;
}> = {}): Harness {
  const state: Harness = { asked: [], pulled: [], adopted: [], targets: [TARGET], deps: undefined as never };
  state.deps = {
    listTargets: () => state.targets,
    isTargetCurrent: (target) => state.targets.some((t) => t.nameHash === target.nameHash)
      && state.adopted.length === 0,
    classifyPolicy: async () => overrides.policy ?? 'public',
    findLocalCandidates: async () => overrides.local ?? [],
    listPeers: () => overrides.peers ?? [],
    peerSupportsNameProtocol: async (peerId) => (overrides.protocols ?? {})[peerId],
    askPeer: async (peerId) => {
      state.asked.push(peerId);
      return (overrides.answers ?? {})[peerId] ?? null;
    },
    pullPeerOntology: async (peerId) => {
      state.pulled.push(peerId);
      return (overrides.ontology ?? {})[peerId] ?? null;
    },
    adopt: async (_target, contextGraphId, source) => {
      if (overrides.adopt === false) return false;
      state.adopted.push({ contextGraphId, source });
      return true;
    },
    log: { info: () => undefined, debug: () => undefined },
  };
  return state;
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function attemptsOf(resolver: ContextGraphNameResolver): number | undefined {
  const entry = resolver.entryFor(NAME_HASH);
  return entry?.state === 'pending' ? entry.attempts : undefined;
}

const resolvers: ContextGraphNameResolver[] = [];
function resolverFor(state: Harness, options = {}): ContextGraphNameResolver {
  const resolver = new ContextGraphNameResolver(state.deps, options);
  resolvers.push(resolver);
  return resolver;
}

afterEach(() => {
  for (const resolver of resolvers) resolver.stop();
  resolvers.length = 0;
  vi.useRealTimers();
});

describe('ContextGraphNameResolver', () => {
  it('adopts a verified local candidate without touching the network', async () => {
    const state = harness({ local: ['wrong-id', CLEARTEXT], peers: ['peer-a'], protocols: { 'peer-a': true } });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, source: 'local-store' });
    expect(state.asked).toEqual([]);
    expect(state.pulled).toEqual([]);
  });

  it('asks only peers that advertise the protocol and verifies every answer', async () => {
    const state = harness({
      peers: ['old-peer', 'identify-pending', 'liar', 'holder'],
      protocols: { 'old-peer': false, 'identify-pending': undefined, liar: true, holder: true },
      answers: { liar: 'acme-fun-fact', holder: CLEARTEXT },
    });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, source: 'peer-protocol' });
    // Old peers and peers whose identify is still pending are never asked.
    expect(state.asked).toEqual(['liar', 'holder']);
    expect(state.adopted).toEqual([{ contextGraphId: CLEARTEXT, source: 'peer-protocol' }]);
  });

  it('falls back to the ontology graph of peers that predate the protocol', async () => {
    const state = harness({
      peers: ['old-core'],
      protocols: { 'old-core': false },
      ontology: { 'old-core': new Map([[NAME_HASH, CLEARTEXT]]) },
    });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'resolved', source: 'peer-ontology' });
    expect(state.asked).toEqual([]);
    expect(state.pulled).toEqual(['old-core']);
  });

  it('ignores an ontology candidate that does not match the hash', async () => {
    const state = harness({
      peers: ['old-core'],
      protocols: { 'old-core': false },
      ontology: { 'old-core': new Map([[NAME_HASH, 'forged-id']]) },
    });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'pending', lastOutcome: 'not-found' });
    expect(state.adopted).toEqual([]);
  });

  it('never asks anyone about a private graph', async () => {
    const state = harness({ policy: 'private', local: [CLEARTEXT], peers: ['peer-a'], protocols: { 'peer-a': true } });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'private' });
    expect(state.asked).toEqual([]);
    expect(state.pulled).toEqual([]);
    expect(state.adopted).toEqual([]);
  });

  it('treats an unreadable policy as unknown and retries later', async () => {
    const state = harness({ policy: 'unknown', peers: ['peer-a'], protocols: { 'peer-a': true } });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'pending', lastOutcome: 'policy-unavailable', attempts: 1 });
    expect(state.asked).toEqual([]);
  });

  it('backs off between background attempts and succeeds once a peer can answer', async () => {
    vi.useFakeTimers();
    const state = harness({ peers: [] });
    const resolver = resolverFor(state, { retryBaseMs: 1_000, retryMaxMs: 4_000 });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', lastOutcome: 'no-peers', attempts: 1 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', attempts: 2 });

    (state.deps as { listPeers: () => string[] }).listPeers = () => ['holder'];
    (state.deps as { peerSupportsNameProtocol: (peer: string) => Promise<boolean> }).peerSupportsNameProtocol =
      async () => true;
    (state.deps as { askPeer: () => Promise<string> }).askPeer = async () => CLEARTEXT;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT });
  });

  it('does not re-ask a peer within its cooldown, except on an explicit request', async () => {
    const state = harness({ peers: ['peer-a'], protocols: { 'peer-a': true }, answers: {} });
    const resolver = resolverFor(state);
    resolver.request();
    await waitFor(() => resolver.entryFor(NAME_HASH)?.state === 'pending');
    expect(state.asked).toEqual(['peer-a']);
    // Identify updates arrive often; the same peer is not asked again.
    resolver.onPeerUpdated('peer-a');
    await waitFor(() => attemptsOf(resolver) === 2);
    expect(state.asked).toEqual(['peer-a']);
    await resolver.resolveNow(TARGET);
    expect(state.asked).toEqual(['peer-a', 'peer-a']);
  });

  it('queues a peer identified while an attempt is in flight and asks it afterwards', async () => {
    let releaseSlow: (() => void) | undefined;
    const state = harness({ peers: ['slow'], protocols: { slow: true, holder: true } });
    (state.deps as { askPeer: (peer: string) => Promise<string | null> }).askPeer = async (peerId) => {
      state.asked.push(peerId);
      if (peerId === 'holder') return CLEARTEXT;
      if (state.asked.length > 1) {
        // The second ask of `slow` hangs until the test releases it.
        await new Promise<void>((resolve) => { releaseSlow = resolve; });
      }
      return null;
    };
    const resolver = resolverFor(state);
    expect(await resolver.resolveNow(TARGET)).toMatchObject({ state: 'pending' });

    const second = resolver.resolveNow(TARGET);
    await waitFor(() => releaseSlow !== undefined);
    resolver.onPeerUpdated('holder'); // arrives while `slow` is still being asked
    expect(state.asked).toEqual(['slow', 'slow']);
    releaseSlow!();
    await second;
    await waitFor(() => resolver.entryFor(NAME_HASH)?.state === 'resolved');
    expect(state.asked).toEqual(['slow', 'slow', 'holder']);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ source: 'peer-protocol', contextGraphId: CLEARTEXT });
  });

  it('shares one attempt between concurrent explicit requests', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    const resolver = resolverFor(state);
    const [a, b] = await Promise.all([resolver.resolveNow(TARGET), resolver.resolveNow(TARGET)]);
    expect(a).toMatchObject({ state: 'resolved' });
    expect(b).toMatchObject({ state: 'resolved' });
    expect(state.asked).toEqual(['holder']);
    expect(state.adopted).toHaveLength(1);
  });

  it('stays pending when the row changed and adoption was declined', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT }, adopt: false });
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry?.state).not.toBe('resolved');
  });

  it('stops cleanly', async () => {
    vi.useFakeTimers();
    const state = harness({ peers: [] });
    const resolver = resolverFor(state, { retryBaseMs: 1_000 });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    resolver.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ attempts: 1 });
    expect(await resolver.resolveNow(TARGET)).toBeUndefined();
  });
});
