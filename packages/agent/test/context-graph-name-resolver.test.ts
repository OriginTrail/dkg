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
    log: { info: () => undefined, debug: () => undefined, warn: () => undefined },
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

  it('records a declined adoption for a row that still wants an id, and leaves it off the retry schedule', async () => {
    vi.useFakeTimers();
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    let adoptCalls = 0;
    // The row stays current: the adopter refuses the id itself (a binding conflict).
    state.deps.adopt = async () => {
      adoptCalls += 1;
      return false;
    };
    const resolver = resolverFor(state, { retryBaseMs: 1_000, retryMaxMs: 1_000, peerAskTtlMs: 0 });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.entryFor(NAME_HASH)).toEqual({
      state: 'declined',
      nameHash: NAME_HASH,
      onChainId: '33',
      contextGraphId: CLEARTEXT,
      source: 'peer-protocol',
      declinedAt: expect.any(Number),
    });
    expect(adoptCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // Background passes, identify updates and time do not decline it again.
    resolver.request();
    resolver.onPeerUpdated('holder');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adoptCalls).toBe(1);
    expect(state.asked).toEqual(['holder']);
    expect(vi.getTimerCount()).toBe(0);

    // An explicit request (the operator subscribing again) checks once more.
    expect(await resolver.resolveNow(TARGET)).toMatchObject({ state: 'declined', contextGraphId: CLEARTEXT });
    expect(adoptCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adoptCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.adopted).toEqual([]);
  });

  it('records a decline reached through a pulled ontology graph, and leaves it off the retry schedule', async () => {
    vi.useFakeTimers();
    const state = harness({
      peers: ['old-core'],
      protocols: { 'old-core': false },
      ontology: { 'old-core': new Map([[NAME_HASH, CLEARTEXT]]) },
    });
    let adoptCalls = 0;
    state.deps.adopt = async () => {
      adoptCalls += 1;
      return false;
    };
    const resolver = resolverFor(state, {
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
      ontologyPullCooldownMs: 0,
      ontologyPullFailureCooldownMs: 0,
    });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({
      state: 'declined',
      contextGraphId: CLEARTEXT,
      source: 'peer-ontology',
    });
    expect(vi.getTimerCount()).toBe(0);

    resolver.request();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.pulled).toEqual(['old-core']);
    expect(adoptCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adopts on an explicit request once a declined id is accepted, with no background pass', async () => {
    vi.useFakeTimers();
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    let conflict = true;
    const adopt = state.deps.adopt;
    state.deps.adopt = async (target, contextGraphId, source) => (
      conflict ? false : adopt(target, contextGraphId, source)
    );
    const resolver = resolverFor(state);
    expect(await resolver.resolveNow(TARGET)).toMatchObject({ state: 'declined' });

    conflict = false; // the operator removed the conflicting row
    const entry = await resolver.resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, source: 'peer-protocol' });
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT });
    expect(state.adopted).toEqual([{ contextGraphId: CLEARTEXT, source: 'peer-protocol' }]);
    // No timer ran and none is left: the explicit request alone did it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records nothing when adoption was declined because the row went away', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    state.deps.adopt = async () => {
      state.targets = []; // e.g. the operator unsubscribed while the peer answered
      return false;
    };
    const resolver = resolverFor(state);
    expect(await resolver.resolveNow(TARGET)).toBeUndefined();
    expect(resolver.entryFor(NAME_HASH)).toBeUndefined();
    expect(state.adopted).toEqual([]);
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

  it('falls through to peers when the local store cannot be read', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    state.deps.findLocalCandidates = async () => { throw new Error('store closed'); };
    expect(await resolverFor(state).resolveNow(TARGET))
      .toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, source: 'peer-protocol' });
  });

  it('adopts every pending hash that one ontology pull answers', async () => {
    const OTHER = 'acme-trivia';
    const OTHER_HASH = ethers.keccak256(ethers.toUtf8Bytes(OTHER)).toLowerCase();
    const OTHER_TARGET: ContextGraphNameTarget = { nameHash: OTHER_HASH, onChainId: '34' };
    const state = harness({ peers: [] });
    state.targets = [TARGET, OTHER_TARGET];
    const adoptedHashes = new Set<string>();
    state.deps.isTargetCurrent = (target) => !adoptedHashes.has(target.nameHash);
    state.deps.adopt = async (target, contextGraphId, source) => {
      adoptedHashes.add(target.nameHash);
      state.adopted.push({ contextGraphId, source });
      return true;
    };
    const resolver = resolverFor(state);
    await resolver.resolveNow(TARGET);
    await resolver.resolveNow(OTHER_TARGET);
    expect(resolver.entryFor(OTHER_HASH)).toMatchObject({ state: 'pending', lastOutcome: 'no-peers' });

    const requestedHashes: string[][] = [];
    state.deps.listPeers = () => ['old-core'];
    state.deps.peerSupportsNameProtocol = async () => false;
    state.deps.pullPeerOntology = async (peerId, nameHashes) => {
      state.pulled.push(peerId);
      requestedHashes.push([...nameHashes]);
      return new Map([[NAME_HASH, CLEARTEXT], [OTHER_HASH, OTHER]]);
    };
    expect(await resolver.resolveNow(TARGET)).toMatchObject({ state: 'resolved', source: 'peer-ontology' });
    // One pull, for both hashes, resolved both.
    expect(state.pulled).toEqual(['old-core']);
    expect(requestedHashes).toEqual([[NAME_HASH, OTHER_HASH]]);
    expect(resolver.entryFor(OTHER_HASH))
      .toMatchObject({ state: 'resolved', contextGraphId: OTHER, source: 'peer-ontology' });
    expect(state.adopted).toEqual([
      { contextGraphId: CLEARTEXT, source: 'peer-ontology' },
      { contextGraphId: OTHER, source: 'peer-ontology' },
    ]);
  });
});

describe('ContextGraphNameResolver: callers with a deadline', () => {
  it('returns the finished entry to a caller that waits with a signal', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    expect(await resolverFor(state).resolveNow(TARGET, { signal: new AbortController().signal }))
      .toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT, source: 'peer-protocol' });
  });

  it('answers a caller that stops waiting with what is known, and finishes the attempt anyway', async () => {
    let release: (() => void) | undefined;
    const state = harness({ peers: ['holder'], protocols: { holder: true } });
    state.deps.askPeer = async (peerId) => {
      state.asked.push(peerId);
      if (state.asked.length === 1) return null;
      await new Promise<void>((resolve) => { release = resolve; });
      return CLEARTEXT;
    };
    const resolver = resolverFor(state);
    expect(await resolver.resolveNow(TARGET)).toMatchObject({ state: 'pending', attempts: 1 });

    // A caller whose budget is already spent (the subscribe route's timeout)
    // gets the current entry at once; the attempt it started keeps running.
    expect(await resolver.resolveNow(TARGET, { signal: AbortSignal.abort() }))
      .toMatchObject({ state: 'pending', attempts: 1 });
    await waitFor(() => release !== undefined);

    // A caller that gives up mid-attempt is answered without waiting for it.
    const giveUp = new AbortController();
    const waiting = resolver.resolveNow(TARGET, { signal: giveUp.signal });
    giveUp.abort();
    expect(await waiting).toMatchObject({ state: 'pending', attempts: 1 });

    release!();
    await waitFor(() => resolver.entryFor(NAME_HASH)?.state === 'resolved');
    // The abandoned attempt did the work; nobody asked twice for it.
    expect(state.asked).toEqual(['holder', 'holder']);
    expect(state.adopted).toEqual([{ contextGraphId: CLEARTEXT, source: 'peer-protocol' }]);
  });

  it('answers a waiting caller when the resolver stops mid-attempt', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true } });
    state.deps.askPeer = (peerId, _target, signal) => {
      state.asked.push(peerId);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const resolver = resolverFor(state);
    const waiting = resolver.resolveNow(TARGET, { signal: new AbortController().signal });
    await waitFor(() => state.asked.length === 1);
    resolver.stop();
    await expect(waiting).resolves.toBeUndefined();
    expect(state.adopted).toEqual([]);
  });
});

describe('ContextGraphNameResolver: background passes', () => {
  it('coalesces requests made during a pass into one more pass, which respects the backoff', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let passes = 0;
    const state = harness({ peers: ['slow'], protocols: { slow: true } });
    const listTargets = state.deps.listTargets;
    state.deps.listTargets = () => {
      passes += 1;
      return listTargets();
    };
    state.deps.askPeer = async (peerId) => {
      state.asked.push(peerId);
      await new Promise<void>((resolve) => { release = resolve; });
      return null;
    };
    const resolver = resolverFor(state, { retryBaseMs: 60_000 });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();

    // Identify churn while the pass is blocked on a slow peer.
    resolver.request();
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1);

    release!();
    await vi.advanceTimersByTimeAsync(0);
    // Exactly one follow-up pass; it found the hash inside its retry backoff.
    expect(passes).toBe(2);
    expect(state.asked).toEqual(['slow']);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('logs a failed pass and recovers on the next request', async () => {
    const debug: string[] = [];
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    let failNext = true;
    const listTargets = state.deps.listTargets;
    state.deps = {
      ...state.deps,
      listTargets: () => {
        if (failNext) {
          failNext = false;
          throw new Error('subscription table busy');
        }
        return listTargets();
      },
      log: { ...state.deps.log, warn: (message) => { debug.push(message); } },
    };
    const resolver = resolverFor(state);
    resolver.request();
    await waitFor(() => debug.includes('Context Graph name resolution pass failed: Error: subscription table busy'));
    expect(resolver.entryFor(NAME_HASH)).toBeUndefined();
    resolver.request();
    await waitFor(() => resolver.entryFor(NAME_HASH)?.state === 'resolved');
  });

  it('keeps retrying in the background after an attempt throws', async () => {
    vi.useFakeTimers();
    const debug: string[] = [];
    const warn: string[] = [];
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    let adoptCalls = 0;
    state.deps = {
      ...state.deps,
      adopt: async (_target, contextGraphId, source) => {
        adoptCalls += 1;
        // The first adoption fails midway (the gossip layer is restarting).
        if (adoptCalls === 1) throw new Error('gossip layer restarting');
        state.adopted.push({ contextGraphId, source });
        return true;
      },
      log: { info: () => undefined, debug: (message) => { debug.push(message); }, warn: (message) => { warn.push(message); } },
    };
    const resolver = resolverFor(state, { retryBaseMs: 1_000, peerAskTtlMs: 0 });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', lastOutcome: 'attempt-failed', attempts: 1 });
    expect(warn).toEqual([
      `Context Graph ${NAME_HASH.slice(0, 18)}… name resolution attempt failed (retrying with backoff): `
        + 'Error: gossip layer restarting',
    ]);
    expect(debug.some((line) => line.includes('attempt failed'))).toBe(false);
    expect(state.adopted).toEqual([]);

    // No request(), no peer update: the retry schedule alone gets it done.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT });
    expect(state.adopted).toEqual([{ contextGraphId: CLEARTEXT, source: 'peer-protocol' }]);
  });

  it('reports every failed attempt at warn at most once per interval, whatever it threw, and keeps retrying', async () => {
    vi.useFakeTimers();
    const debug: string[] = [];
    const warn: string[] = [];
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    // A defect thrown as a plain Error, a routine parse failure, a non-Error
    // value: none is singled out by its class, and none is swallowed.
    const failures: unknown[] = [
      new Error('promoteRow missing'),
      new SyntaxError('Unexpected token < in JSON'),
      new RangeError('Invalid array length'),
      'boom',
    ];
    let adoptCalls = 0;
    state.deps = {
      ...state.deps,
      adopt: async (_target, contextGraphId, source) => {
        const failure = failures[adoptCalls];
        adoptCalls += 1;
        if (failure !== undefined) throw failure;
        state.adopted.push({ contextGraphId, source });
        return true;
      },
      log: { info: () => undefined, debug: (message) => { debug.push(message); }, warn: (message) => { warn.push(message); } },
    };
    const failed = (detail: string) => `Context Graph ${NAME_HASH.slice(0, 18)}… name resolution attempt failed `
      + `(retrying with backoff): ${detail}`;
    const resolver = resolverFor(state, {
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
      peerAskTtlMs: 0,
      failureWarnIntervalMs: 2_500,
    });
    resolver.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', lastOutcome: 'attempt-failed', attempts: 1 });
    expect(warn).toEqual([failed('Error: promoteRow missing')]);

    // Within the interval, repeats go to debug: still logged, not flooding warn.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'pending', lastOutcome: 'attempt-failed', attempts: 3 });
    expect(warn).toHaveLength(1);
    expect(debug.filter((line) => line.includes('attempt failed'))).toEqual([
      failed('SyntaxError: Unexpected token < in JSON'),
      failed('RangeError: Invalid array length'),
    ]);

    // Past the interval it is at warn again, and a thrown non-Error keeps its value.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toEqual([failed('Error: promoteRow missing'), failed('boom')]);

    // It stayed on the retry schedule throughout.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolver.entryFor(NAME_HASH)).toMatchObject({ state: 'resolved', contextGraphId: CLEARTEXT });
  });

  it('guards every row check the same way: a throw warns and keeps the hash on the retry schedule', async () => {
    const warn: string[] = [];
    const state = harness({ peers: ['holder'], protocols: { holder: true }, answers: { holder: CLEARTEXT } });
    state.deps.log = { ...state.deps.log, warn: (message) => { warn.push(message); } };
    state.deps.isTargetCurrent = () => { throw new TypeError('rows.get is not a function'); };
    // The adoption fails too, so the retry decision itself needs the row check.
    state.deps.adopt = async () => { throw new Error('gossip layer restarting'); };
    const entry = await resolverFor(state).resolveNow(TARGET);
    expect(entry).toMatchObject({ state: 'pending', lastOutcome: 'attempt-failed', attempts: 1 });
    expect(entry?.state === 'pending' ? entry.nextAttemptAt : undefined).toBeTypeOf('number');
    expect(state.asked).toEqual(['holder']);
    // Each kind of failure is reported once; the repeats of the row check went to debug.
    expect(warn).toEqual([
      `Context Graph ${NAME_HASH.slice(0, 18)}… row check failed; treating the row as still wanting `
        + 'a cleartext id: TypeError: rows.get is not a function',
      `Context Graph ${NAME_HASH.slice(0, 18)}… name resolution attempt failed (retrying with backoff): `
        + 'Error: gossip layer restarting',
    ]);
  });

  it('logs a failed pass at warn with its error class', async () => {
    const warn: string[] = [];
    const state = harness();
    state.deps = {
      ...state.deps,
      listTargets: () => { throw new TypeError('rows is not iterable'); },
      log: { ...state.deps.log, warn: (message) => { warn.push(message); } },
    };
    resolverFor(state).request();
    await waitFor(() => warn.length > 0);
    expect(warn).toEqual(['Context Graph name resolution pass failed: TypeError: rows is not iterable']);
  });

  it('does not schedule a retry for an attempt cut short by shutdown', async () => {
    const state = harness({ peers: ['holder'], protocols: { holder: true } });
    let stopResolver!: () => void;
    state.deps.askPeer = async () => {
      stopResolver();
      throw new DOMException('stopped', 'AbortError');
    };
    const resolver = resolverFor(state);
    stopResolver = () => resolver.stop();
    await expect(resolver.resolveNow(TARGET)).rejects.toThrow('Context Graph name resolver stopped');
    expect(resolver.entryFor(NAME_HASH)).toBeUndefined();
  });

  it('bounds remembered asks, forgetting the oldest first', async () => {
    const peers = Array.from({ length: 4_097 }, (_, index) => `peer-${index}`);
    const state = harness({ peers, protocols: Object.fromEntries(peers.map((peer) => [peer, true])) });
    // One wide attempt fills the memory past its bound (real attempts ask 8).
    const resolver = resolverFor(state, { maxPeersPerAttempt: peers.length });
    await resolver.resolveNow(TARGET);
    expect(state.asked).toHaveLength(4_097);

    // Identify updates within every peer's ask cooldown: the newest ask is
    // still remembered, the oldest fell out of the bounded memory.
    resolver.onPeerUpdated('peer-4096');
    await waitFor(() => attemptsOf(resolver) === 2);
    resolver.onPeerUpdated('peer-0');
    await waitFor(() => attemptsOf(resolver) === 3);
    expect(state.asked.slice(4_097)).toEqual(['peer-0']);
  });

  it('bounds remembered resolutions, forgetting the oldest first', async () => {
    const ids = Array.from({ length: 257 }, (_, index) => `acme-graph-${index}`);
    const byHash = new Map(ids.map((id) => [ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase(), id]));
    const targets = [...byHash.keys()].map((nameHash, index) => ({ nameHash, onChainId: String(index + 1) }));
    const state = harness({});
    state.targets = targets;
    state.deps.isTargetCurrent = () => true;
    state.deps.findLocalCandidates = async (target) => [byHash.get(target.nameHash)!];
    const resolver = resolverFor(state);
    for (const target of targets) {
      expect(await resolver.resolveNow(target)).toMatchObject({ state: 'resolved', source: 'local-store' });
    }
    expect(resolver.entriesSnapshot()).toHaveLength(256);
    expect(resolver.entryFor(targets[0]!.nameHash)).toBeUndefined();
    expect(resolver.entryFor(targets[1]!.nameHash)).toMatchObject({ contextGraphId: 'acme-graph-1' });
    expect(resolver.entryFor(targets[256]!.nameHash)).toMatchObject({ contextGraphId: 'acme-graph-256' });
  });
});
