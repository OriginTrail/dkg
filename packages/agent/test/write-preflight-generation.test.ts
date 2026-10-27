/**
 * The agent's side of write-preflight coalescing (OT-RFC-73 S4a): which writes move the policy generation,
 * what makes two probe calls interchangeable, and the probe's chain-lookup hook. The daemon's side (joining
 * a probe in flight, the result cache) is in the CLI package's `write-preflight-coalescing.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  OxigraphStore,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS,
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT,
  WritePreflightGeneration,
  WritePreflightIdentityMethods,
  attachWritePreflightGeneration,
  mutationMayChangeWritePreflight,
  withWritePreflightGeneration,
} from '../src/dkg-agent-write-preflight.js';
import {
  normalizeWritePreflightCaller,
  probeContextGraphWritePreflight,
  type WritePreflightHost,
} from '../src/context-graph-write-preflight.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';
import { MAX_TRACKED_SUBSCRIPTION_CHANGES, VersionedSubscriptionRegistry } from '../src/internal/versioned-subscription-registry.js';
import type { StoreMutation, StoreMutationObserver, StoreMutationOutcome } from '../src/internal/store-mutation.js';

const CG = '0x1111111111111111111111111111111111111111/policy-cg';
const ONTOLOGY = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const AGENTS = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const META = contextGraphMetaGraphUri(CG);
// EIP-55 test vector: the checksum spelling, its lowercase form, and a mixed-case spelling whose checksum is wrong.
const CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const LOWERCASE = CHECKSUM.toLowerCase();
const BAD_CHECKSUM = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

const quad = (graph: string, predicate = DKG_ONTOLOGY.DKG_ACCESS_POLICY): Quad => ({
  subject: `did:dkg:context-graph:${CG}`, predicate, object: '"private"', graph,
});

describe('which writes may change what a write preflight reads', () => {
  it.each<[string, StoreMutation, boolean]>([
    ['a quad in the ontology graph', { quads: [quad(ONTOLOGY)] }, true],
    ['a quad in the agents graph', { quads: [quad(AGENTS)] }, true],
    ['a quad in a context graph meta graph', { quads: [quad(META)] }, true],
    ['a quad in the meta graph of another context graph', { quads: [quad(contextGraphMetaGraphUri('other-cg'))] }, true],
    ['a quad in a sub-graph meta graph', { quads: [quad(`${META.slice(0, -'/_meta'.length)}/tasks/_meta`)] }, true],
    ['a quad in an angle-bracketed meta graph', { quads: [quad(`<${META}>`)] }, true],
    ['a removal that names a policy graph', { removals: [{ graph: META, subject: 'urn:s' }] }, true],
    ['a removal that names no graph', { removals: [{ subject: 'urn:s' }] }, true],
    ['a removal with an empty graph name', { removals: [{ graph: '' }] }, true],
    ['a write that may change anything', { everything: true }, true],
    ['a quad whose graph name is not a safe IRI', { quads: [quad('did:dkg:context-graph:x/_meta> } DROP ALL #')] }, true],
    ['a quad in the data graph of a context graph', { quads: [quad(contextGraphDataGraphUri(CG))] }, false],
    ['a quad in a shared-memory meta graph', { quads: [quad(`${contextGraphDataGraphUri(CG)}/_shared_memory_meta`)] }, false],
    ['a quad in a context graph catalog graph', { quads: [quad(`${contextGraphDataGraphUri(CG)}/_catalog`)] }, false],
    ['a quad in a queue graph', { quads: [quad('urn:dkg:promote-queue:control-plane')] }, false],
    ['a quad in the default graph', { quads: [quad('')] }, false],
    ['a quad with no graph at all', { quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"' } as unknown as Quad] }, false],
    ['a removal whose graph is not a string', { removals: [{ graph: null as unknown as string }] }, true],
    ['a bulk write of many quads in one data graph', { quads: Array.from({ length: 5_000 }, (_, i) => ({ ...quad(contextGraphDataGraphUri(CG)), subject: `urn:s:${i}` })) }, false],
    ['a bulk write that reaches a policy graph at its end', { quads: [...Array.from({ length: 50 }, () => quad(contextGraphDataGraphUri(CG))), quad(META)] }, true],
    ['a removal that names a data graph', { removals: [{ graph: contextGraphDataGraphUri(CG) }] }, false],
    ['no quads and no removals', {}, false],
  ])('%s: %s', (_label, mutation, expected) => {
    expect(mutationMayChangeWritePreflight(mutation)).toBe(expected);
  });
});

describe('the generation follows writes as they settle', () => {
  function observed(outcome: StoreMutationOutcome, mutation: StoreMutation) {
    const generation = new WritePreflightGeneration();
    const settled: StoreMutationOutcome[] = [];
    const inner: StoreMutationObserver = { begin: () => (result) => { settled.push(result); } };
    const settle = withWritePreflightGeneration(inner, generation).begin(mutation);
    return { generation, settled, settle: () => settle(outcome) };
  }

  it('moves when a relevant write changed something, not before it settles', () => {
    const { generation, settle, settled } = observed('changed', { quads: [quad(META)] });
    expect(generation.current).toBe(0);
    settle();
    expect(generation.current).toBe(1);
    expect(settled).toEqual(['changed']);
  });

  it('moves for an indeterminate write, which may still have committed', () => {
    const { generation, settle } = observed('indeterminate', { quads: [quad(ONTOLOGY)] });
    settle();
    expect(generation.current).toBe(1);
  });

  it('stays for a write that provably changed nothing, and for an irrelevant one', () => {
    const unchanged = observed('unchanged', { quads: [quad(META)] });
    unchanged.settle();
    expect(unchanged.generation.current).toBe(0);
    const irrelevant = observed('changed', { quads: [quad('urn:dkg:promote-queue:control-plane')] });
    irrelevant.settle();
    expect(irrelevant.generation.current).toBe(0);
    expect(irrelevant.settled).toEqual(['changed']);
  });

  it('still settles the wrapped observer when the bump cannot run', () => {
    const generation = new WritePreflightGeneration();
    vi.spyOn(generation, 'bump').mockImplementation(() => { throw new Error('bump failed'); });
    const settled: StoreMutationOutcome[] = [];
    const settle = withWritePreflightGeneration({ begin: () => (result) => { settled.push(result); } }, generation)
      .begin({ everything: true });
    expect(() => settle('changed')).toThrow('bump failed');
    expect(settled).toEqual(['changed']);
  });

  describe('through the agent store wrapper and a real store', () => {
    async function setup() {
      const raw = new OxigraphStore();
      const generation = new WritePreflightGeneration();
      const store = createMutationObservedStore(raw, createObservedStoreMutation(
        () => {},
        withWritePreflightGeneration({ begin: () => () => {} }, generation),
      ));
      return { raw, store, generation };
    }

    it('moves on a policy write once it has been acknowledged', async () => {
      const { store, generation } = await setup();
      const write = store.insert([quad(META)]);
      expect(generation.current).toBe(0);
      await write;
      expect(generation.current).toBe(1);
      await store.insert([quad(ONTOLOGY, DKG_ONTOLOGY.RDF_TYPE)]);
      expect(generation.current).toBe(2);
    });

    it('moves on a subject replacement and a delete in a policy graph', async () => {
      const { store, generation } = await setup();
      await store.insert([quad(AGENTS)]);
      const before = generation.current;
      await store.replaceSubject!(AGENTS, `did:dkg:context-graph:${CG}`, [quad(AGENTS)]);
      expect(generation.current).toBeGreaterThan(before);
      const afterReplace = generation.current;
      await store.delete([quad(AGENTS)]);
      expect(generation.current).toBeGreaterThan(afterReplace);
    });

    it('moves on a SPARQL update, which may change anything', async () => {
      const { raw, store, generation } = await setup();
      // The in-process engine takes updates through `update`; what is under test is the wrapper's reading of the text.
      vi.spyOn(raw, 'query').mockResolvedValue({ type: 'bindings', bindings: [] } as never);
      await store.query('INSERT DATA { GRAPH <urn:elsewhere> { <urn:s> <urn:p> "o" } }');
      expect(generation.current).toBe(1);
    });

    it('does not move on content or queue writes, or on reads', async () => {
      const { store, generation } = await setup();
      await store.insert([quad(contextGraphDataGraphUri(CG)), quad('urn:dkg:promote-queue:control-plane')]);
      await store.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(generation.current).toBe(0);
    });

    it('does not move when a policy write is refused before it was dispatched', async () => {
      const { raw, store, generation } = await setup();
      vi.spyOn(raw, 'insert').mockRejectedValue(
        new StoreSchedulerBusyError('queue_full', 'normal', 'agent.test', { storeOperation: 'insert' }),
      );
      await expect(store.insert([quad(META)])).rejects.toThrow(/queue full/);
      expect(generation.current).toBe(0);
    });

    it('moves when a policy write fails in a way that may have committed', async () => {
      const { raw, store, generation } = await setup();
      vi.spyOn(raw, 'insert').mockRejectedValue(new Error('response lost'));
      await expect(store.insert([quad(META)])).rejects.toThrow('response lost');
      expect(generation.current).toBe(1);
    });
  });
});

describe('what makes two probe calls interchangeable', () => {
  // The agent's own registry, which counts the writes made to each entry; the rows here are partial on purpose.
  function agentWith(subs = new VersionedSubscriptionRegistry() as unknown as Map<string, Record<string, unknown>>) {
    const generation = new WritePreflightGeneration();
    const agent = { subscribedContextGraphs: subs } as never;
    const identity = (contextGraphId: string, caller?: string | null) =>
      WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent, contextGraphId, caller);
    return { agent, generation, subs, identity, attach: () => attachWritePreflightGeneration(agent, generation) };
  }

  it('has no identity for an agent whose store observer does not feed the generation', () => {
    const { identity } = agentWith();
    expect(identity(CG, CHECKSUM)).toBeUndefined();
  });

  it('keys on the context graph and on the caller as the probe judges it', () => {
    const { identity, attach } = agentWith();
    attach();
    const key = identity(CG, CHECKSUM)!.key;
    expect(identity(CG, LOWERCASE)!.key).toBe(key);
    expect(identity(CG, ` did:dkg:agent:${LOWERCASE} `)!.key).toBe(key);
    expect(identity(CG, '0x2222222222222222222222222222222222222222')!.key).not.toBe(key);
    expect(identity('0x1111111111111111111111111111111111111111/other', CHECKSUM)!.key).not.toBe(key);
    // A string that names nobody is judged as no caller: it shares with no caller, and with no address.
    const nobody = identity(CG, null)!.key;
    expect(identity(CG, undefined)!.key).toBe(nobody);
    expect(identity(CG, '')!.key).toBe(nobody);
    expect(identity(CG, 'not-an-address')!.key).toBe(nobody);
    expect(identity(CG, BAD_CHECKSUM)!.key).toBe(nobody);
    expect(nobody).not.toBe(key);
  });

  it('moves the stamp with the generation, not with the caller', () => {
    const { identity, generation, attach } = agentWith();
    attach();
    const first = identity(CG, CHECKSUM)!.stamp;
    expect(identity(CG, '0x2222222222222222222222222222222222222222')!.stamp).toBe(first);
    generation.bump();
    expect(identity(CG, CHECKSUM)!.stamp).not.toBe(first);
  });

  it('moves the stamp when this graph\'s subscription entry is written, and only then', () => {
    const { identity, subs, attach } = agentWith();
    attach();
    const absent = identity(CG, CHECKSUM)!.stamp;
    subs.set(CG, { subscribed: true, synced: false });
    const unsynced = identity(CG, CHECKSUM)!.stamp;
    expect(unsynced).not.toBe(absent);
    subs.set(CG, { subscribed: true, synced: true });
    const synced = identity(CG, CHECKSUM)!.stamp;
    expect(synced).not.toBe(unsynced);
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    const withParticipants = identity(CG, CHECKSUM)!.stamp;
    expect(withParticipants).not.toBe(synced);
    // Another graph's entry leaves the stamp where it was, and so does a read.
    subs.set('another-cg', { subscribed: true, synced: true });
    subs.delete('another-cg');
    subs.get(CG);
    expect(identity(CG, CHECKSUM)!.stamp).toBe(withParticipants);
    // A write of an equal row is still a write: the entry may have been changed and put back.
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    expect(identity(CG, CHECKSUM)!.stamp).not.toBe(withParticipants);
  });

  it('never returns to a stamp it had once: a change that is reverted is still a change', () => {
    const { identity, subs, attach } = agentWith();
    attach();
    const stamps = new Set<string>();
    const seen = (): void => {
      const stamp = identity(CG, CHECKSUM)!.stamp;
      expect(stamps.has(stamp)).toBe(false);
      stamps.add(stamp);
    };
    seen(); // no entry
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    seen();
    // The participant list is flipped and put back: the entry is equal to what it was, the stamp is not.
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM, '0x2222222222222222222222222222222222222222'] });
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    seen();
    // The entry removed and put back, and removed for good: neither is the stamp of before.
    subs.delete(CG);
    seen();
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    seen();
    subs.delete(CG);
    seen();
    // A registry cleared with the entry in it is a change of the entry too.
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM] });
    seen();
    subs.clear();
    seen();
  });

  it('has no identity when the subscription registry does not count its writes', () => {
    const generation = new WritePreflightGeneration();
    const agent = { subscribedContextGraphs: new Map() } as never;
    attachWritePreflightGeneration(agent, generation);
    expect(WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent, CG, CHECKSUM)).toBeUndefined();
  });
});

describe('a policy write whose outcome is unknown', () => {
  // The protection is the agent's own policy: two minutes, a best-effort estimate of how long a remote store
  // takes to apply a write its caller gave up on. Every offset below is spelled out in milliseconds, never
  // derived from the production constant, so that shortening the window fails these tests instead of moving
  // them along with it.
  const TWO_MINUTES_MS = 120_000;

  // The agent's own registry and a clock the test moves, under the generation's default window unless told.
  function sharing(options: { unresolvedWindowMs?: number } = {}) {
    const clock = { now: 0 };
    const generation = new WritePreflightGeneration({ now: () => clock.now, ...options });
    const agent = { subscribedContextGraphs: new VersionedSubscriptionRegistry() } as never;
    attachWritePreflightGeneration(agent, generation);
    const identity = (caller: string = CHECKSUM) =>
      WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent, CG, caller);
    const settle = (outcome: StoreMutationOutcome, mutation: StoreMutation = { quads: [quad(META)] }) =>
      withWritePreflightGeneration({ begin: () => () => {} }, generation).begin(mutation)(outcome);
    return { clock, generation, identity, settle };
  }

  it('is exactly two minutes by default, as a named policy of the preflight', () => {
    expect(WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS).toBe(TWO_MINUTES_MS);
    expect(WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT).toBe(0);
    expect(new WritePreflightGeneration().unresolvedWindowMs).toBe(TWO_MINUTES_MS);
    expect(new WritePreflightGeneration().strict).toBe(false);
    expect(new WritePreflightGeneration({ unresolvedWindowMs: 0 }).strict).toBe(true);
  });

  it('hands out no identity until two minutes have passed, so nothing begun meanwhile can be joined or kept', () => {
    const { clock, identity, settle } = sharing();
    const before = identity()!;
    settle('indeterminate');
    expect(identity()).toBeUndefined();
    // A probe begun at 64 s reads the policy a late commit may still change (a one-minute window would let it share).
    clock.now = 64_000;
    expect(identity()).toBeUndefined();
    clock.now = 119_999;
    expect(identity()).toBeUndefined();
    expect(identity('0x2222222222222222222222222222222222222222')).toBeUndefined();
    clock.now = 120_000;
    const after = identity()!;
    expect(after.key).toBe(before.key);
    expect(after.stamp).not.toBe(before.stamp);
  });

  it.each([1, 30_000, 60_000, 64_000, 90_000, 119_999])('is still off %i ms after an unknown outcome', (elapsedMs) => {
    const { clock, identity, settle } = sharing();
    settle('indeterminate');
    clock.now = elapsedMs;
    expect(identity()).toBeUndefined();
  });

  it.each([120_000, 120_001, 600_000])('has resumed %i ms after an unknown outcome', (elapsedMs) => {
    const { clock, identity, settle } = sharing();
    settle('indeterminate');
    clock.now = elapsedMs;
    expect(identity()).toBeDefined();
  });

  it('resumes under a generation that is neither the one before the write nor the one at its report', () => {
    const { clock, generation, identity, settle } = sharing();
    const before = generation.current;
    settle('indeterminate');
    const reported = generation.current;
    expect(reported).toBe(before + 1);
    clock.now = 120_000;
    expect(identity()).toBeDefined();
    expect(generation.current).toBe(reported + 1);
    // The resumption is counted once; ordinary sharing goes on from there.
    const stamp = identity()!.stamp;
    expect(identity()!.stamp).toBe(stamp);
    expect(generation.current).toBe(reported + 1);
  });

  it('is extended by a further unknown outcome, and resumes only after the last window', () => {
    const { clock, identity, settle } = sharing();
    settle('indeterminate');
    clock.now = 119_000;
    settle('indeterminate'); // its window runs to 239 s
    clock.now = 238_999;
    expect(identity()).toBeUndefined();
    clock.now = 239_000;
    expect(identity()).toBeDefined();
  });

  it('is not shortened by an earlier write that is reported later', () => {
    const { clock, identity, settle } = sharing();
    settle('indeterminate');
    clock.now = 10;
    settle('indeterminate'); // its window runs to 120.010 s
    clock.now = 120_009;
    expect(identity()).toBeUndefined();
    clock.now = 120_010;
    expect(identity()).toBeDefined();
  });

  it.each<[string, StoreMutationOutcome, StoreMutation]>([
    ['a policy write that was confirmed', 'changed', { quads: [quad(META)] }],
    ['a policy write that provably changed nothing', 'unchanged', { quads: [quad(META)] }],
    ['an unknown outcome of a write that is no policy source', 'indeterminate', { quads: [quad(contextGraphDataGraphUri(CG))] }],
  ])('does not stop sharing for %s', (_label, outcome, mutation) => {
    const { identity, settle } = sharing();
    settle(outcome, mutation);
    expect(identity()).toBeDefined();
  });

  it('keeps sharing off when the generation cannot be moved', () => {
    const { generation, identity, settle } = sharing();
    vi.spyOn(generation, 'bump').mockImplementation(() => { throw new Error('bump failed'); });
    expect(() => settle('indeterminate')).toThrow('bump failed');
    expect(identity()).toBeUndefined();
  });

  describe('with another window set by the daemon', () => {
    it('resumes exactly when that window has passed', () => {
      const { clock, identity, settle } = sharing({ unresolvedWindowMs: 5_000 });
      settle('indeterminate');
      clock.now = 4_999;
      expect(identity()).toBeUndefined();
      clock.now = 5_000;
      expect(identity()).toBeDefined();
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '120000' as unknown as number])(
      'refuses %s: a safety bound is not guessed at',
      (unresolvedWindowMs) => {
        expect(() => new WritePreflightGeneration({ unresolvedWindowMs })).toThrow(RangeError);
      },
    );
  });

  describe('with the strict window (0)', () => {
    const FAR_FUTURE_MS = 10 ** 12;

    it('never shares again after an unknown outcome, however long it has been', () => {
      const { clock, generation, identity, settle } = sharing({ unresolvedWindowMs: 0 });
      expect(identity()).toBeDefined();
      settle('indeterminate');
      expect(generation.strict).toBe(true);
      for (const elapsedMs of [0, 1, 119_999, 120_000, 600_000, 24 * 3_600_000, FAR_FUTURE_MS]) {
        clock.now = elapsedMs;
        expect(identity()).toBeUndefined();
        expect(identity('0x2222222222222222222222222222222222222222')).toBeUndefined();
      }
    });

    it('is not ended by a write that is confirmed afterwards, nor by a further unknown outcome', () => {
      const { clock, identity, settle } = sharing({ unresolvedWindowMs: 0 });
      settle('indeterminate');
      settle('changed');
      settle('unchanged');
      settle('indeterminate');
      clock.now = FAR_FUTURE_MS;
      expect(identity()).toBeUndefined();
    });

    it('keeps the ordinary rules while no policy write has an unknown outcome', () => {
      const { clock, generation, identity, settle } = sharing({ unresolvedWindowMs: 0 });
      const first = identity()!;
      expect(identity()!.stamp).toBe(first.stamp);
      // Confirmed policy writes move the stamp and never suspend sharing.
      settle('changed');
      const afterChange = identity()!;
      expect(afterChange.stamp).not.toBe(first.stamp);
      settle('unchanged');
      expect(identity()!.stamp).toBe(afterChange.stamp);
      // An unknown outcome of a write that is no policy source does not suspend it either.
      settle('indeterminate', { quads: [quad(contextGraphDataGraphUri(CG))] });
      clock.now = FAR_FUTURE_MS;
      expect(identity()!.stamp).toBe(afterChange.stamp);
      expect(generation.current).toBe(1);
    });
  });

  describe('as a policy of the preflight, not of any store', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

    it('takes no part of its value from a store\'s timeout configuration', async () => {
      const defaultWindow = new WritePreflightGeneration().unresolvedWindowMs;
      for (const configured of ['1000', '5000', '90000', '600000']) {
        vi.stubEnv('DKG_BLAZEGRAPH_OPERATION_TIMEOUT_MS', configured);
        // A store configured with another deadline, as the daemon might build it.
        new BlazegraphStore('http://127.0.0.1:9999/blazegraph/namespace/kb/sparql', { timeout: Number(configured) });
        vi.resetModules();
        const fresh = await import('../src/dkg-agent-write-preflight.js');
        expect(fresh.WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS).toBe(TWO_MINUTES_MS);
        expect(new fresh.WritePreflightGeneration().unresolvedWindowMs).toBe(defaultWindow);
      }
    });

    it('does not import from the storage package, so no deadline of a store can reach it', () => {
      for (const file of ['dkg-agent-write-preflight.ts', 'write-preflight-unresolved-window.ts']) {
        const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
        expect(source, file).not.toMatch(/dkg-storage/);
        expect(source, file).not.toMatch(/blazegraph/i);
      }
    });
  });

  describe('through the agent store wrapper and a store that loses the response', () => {
    it('gives no identity after a policy insert times out, and one again after the window', async () => {
      const raw = new OxigraphStore();
      let now = 0;
      const generation = new WritePreflightGeneration({ now: () => now });
      const store = createMutationObservedStore(raw, createObservedStoreMutation(
        () => {},
        withWritePreflightGeneration({ begin: () => () => {} }, generation),
      ));
      const agent = { subscribedContextGraphs: new VersionedSubscriptionRegistry() } as never;
      attachWritePreflightGeneration(agent, generation);
      const identity = () => WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent, CG, CHECKSUM);
      expect(identity()).toBeDefined();

      vi.spyOn(raw, 'insert').mockRejectedValueOnce(
        new StoreOperationTimeoutError({ backend: 'controlled', operation: 'insert', storeOperation: 'insert', timeoutMs: 30_000 }),
      );
      await expect(store.insert([quad(META)])).rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
      expect(identity()).toBeUndefined();

      now = 64_000;
      expect(identity()).toBeUndefined();
      now = 120_000;
      expect(identity()).toBeDefined();
      // A write that is confirmed afterwards moves the generation but does not stop sharing.
      await store.insert([quad(META)]);
      expect(identity()).toBeDefined();
    });

    it('gives no identity again for the rest of the process after a policy insert times out, when strict', async () => {
      const raw = new OxigraphStore();
      let now = 0;
      const generation = new WritePreflightGeneration({ now: () => now, unresolvedWindowMs: 0 });
      const store = createMutationObservedStore(raw, createObservedStoreMutation(
        () => {},
        withWritePreflightGeneration({ begin: () => () => {} }, generation),
      ));
      const agent = { subscribedContextGraphs: new VersionedSubscriptionRegistry() } as never;
      attachWritePreflightGeneration(agent, generation);
      const identity = () => WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent, CG, CHECKSUM);

      vi.spyOn(raw, 'insert').mockRejectedValueOnce(
        new StoreOperationTimeoutError({ backend: 'controlled', operation: 'insert', storeOperation: 'insert', timeoutMs: 30_000 }),
      );
      await expect(store.insert([quad(META)])).rejects.toMatchObject({ code: 'STORE_OPERATION_TIMEOUT' });
      now = 10 ** 12;
      expect(identity()).toBeUndefined();
      await store.insert([quad(META)]);
      expect(identity()).toBeUndefined();
    });
  });
});

describe('the subscription registry\'s versions', () => {
  const row = { subscribed: true, synced: true } as never;

  it('moves an entry\'s version on set, replace and delete, and not on a read or another entry', () => {
    const registry = new VersionedSubscriptionRegistry();
    const initial = registry.versionOf('a');
    registry.get('a');
    registry.has('a');
    registry.delete('a'); // nothing to delete
    expect(registry.versionOf('a')).toBe(initial);
    registry.set('a', row);
    const created = registry.versionOf('a');
    expect(created).not.toBe(initial);
    registry.set('b', row);
    expect(registry.versionOf('a')).toBe(created);
    registry.set('a', row); // an equal row is a write
    const replaced = registry.versionOf('a');
    expect(replaced).not.toBe(created);
    expect(registry.delete('a')).toBe(true);
    expect(registry.versionOf('a')).not.toBe(replaced);
    expect(registry.versionOf('a')).not.toBe(initial);
    expect(registry.has('b')).toBe(true);
  });

  it('keeps the map behavior of the registry it replaces', () => {
    const registry = new VersionedSubscriptionRegistry();
    expect(registry).toBeInstanceOf(Map);
    expect(registry.set('a', row)).toBe(registry);
    expect(registry.get('a')).toBe(row);
    expect([...registry.keys()]).toEqual(['a']);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('moves every entry\'s version when the registry is cleared, and not when an empty one is', () => {
    const registry = new VersionedSubscriptionRegistry();
    const emptied = registry.versionOf('a');
    registry.clear();
    expect(registry.versionOf('a')).toBe(emptied);
    registry.set('a', row);
    const before = [registry.versionOf('a'), registry.versionOf('b')];
    registry.clear();
    expect([registry.versionOf('a'), registry.versionOf('b')]).not.toContain(before[0]);
    expect(registry.versionOf('b')).not.toBe(before[1]);
  });

  it('forgets old changes in bounded memory without ever repeating a version', () => {
    const registry = new VersionedSubscriptionRegistry();
    registry.set('first', row);
    const first = registry.versionOf('first');
    const seen = new Set<string>();
    for (let i = 0; i < MAX_TRACKED_SUBSCRIPTION_CHANGES + 10; i += 1) {
      registry.set(`cg-${i}`, row);
      registry.delete(`cg-${i}`);
      expect(seen.has(registry.versionOf(`cg-${i}`))).toBe(false);
      seen.add(registry.versionOf(`cg-${i}`));
    }
    // A graph whose change was forgotten has a version it never had.
    expect(registry.versionOf('first')).not.toBe(first);
    expect(seen.has(registry.versionOf('first'))).toBe(false);
  });
});

describe('the caller a probe judges', () => {
  it.each([
    [CHECKSUM, CHECKSUM],
    [LOWERCASE, CHECKSUM],
    [`did:dkg:agent:${LOWERCASE}`, CHECKSUM],
    [`  ${CHECKSUM}\n`, CHECKSUM],
    [BAD_CHECKSUM, null],
    ['did:dkg:agent:', null],
    ['0x1234', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('%s is %s', (raw, expected) => {
    expect(normalizeWritePreflightCaller(raw)).toBe(expected);
  });
});

describe('the probe reports an on-chain allowlist lookup', () => {
  function host(allowlist: WritePreflightHost['callerIsAllowlistedAgentParticipant']): WritePreflightHost {
    return {
      store: { query: async () => ({ type: 'bindings', bindings: [
        { kind: '"declared"' }, { kind: '"access"', value: '"private"' }, { kind: '"curator"', value: 'did:dkg:agent:0x9999999999999999999999999999999999999999' },
      ] }) } as never,
      contextGraphExists: async () => true,
      contextGraphHasLocalContent: async () => true,
      curatorDidMatchesChecksumAgent: () => false,
      callerIsAllowlistedAgentParticipant: allowlist,
    };
  }
  const subscriptions = { current: () => undefined };

  it('calls the allowlist exactly as before when no hook is given', async () => {
    const allowlist = vi.fn(async () => true);
    const probe = await probeContextGraphWritePreflight(host(allowlist), subscriptions, CG, { callerAgentAddress: LOWERCASE });
    expect(probe.callerAuthorized).toBe(true);
    expect(allowlist).toHaveBeenCalledTimes(1);
    expect(allowlist.mock.calls[0]).toEqual([CG, CHECKSUM]);
  });

  it('hands the hook to the allowlist, which calls it when it consults the chain', async () => {
    const onChainLookup = vi.fn();
    const allowlist = vi.fn(async (_cg: string, _caller: string, options?: { onChainLookup?: () => void }) => {
      options?.onChainLookup?.();
      return false;
    });
    const probe = await probeContextGraphWritePreflight(host(allowlist), subscriptions, CG, { callerAgentAddress: CHECKSUM, onChainLookup });
    expect(probe.callerAuthorized).toBe(false);
    expect(allowlist).toHaveBeenCalledWith(CG, CHECKSUM, { onChainLookup });
    expect(onChainLookup).toHaveBeenCalledTimes(1);
  });

  it('never calls the hook when the caller is judged without the allowlist', async () => {
    const onChainLookup = vi.fn();
    const allowlist = vi.fn(async () => true);
    await probeContextGraphWritePreflight(host(allowlist), subscriptions, CG, { onChainLookup });
    expect(allowlist).not.toHaveBeenCalled();
    expect(onChainLookup).not.toHaveBeenCalled();
  });
});
