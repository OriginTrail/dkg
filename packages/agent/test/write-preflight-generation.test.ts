/**
 * The agent's side of write-preflight coalescing (OT-RFC-73 S4a): which writes move the policy generation,
 * what makes two probe calls interchangeable, and the probe's chain-lookup hook. The daemon's side (joining
 * a probe in flight, the result cache) is in the CLI package's `write-preflight-coalescing.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import {
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
  function agentWith(subs: Map<string, Record<string, unknown>> = new Map()) {
    const generation = new WritePreflightGeneration();
    const agent = { getSubscribedContextGraphs: () => subs } as never;
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

  it('moves the stamp when this graph\'s subscription entry changes, and only then', () => {
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
    // The same entry replaced by an equal one, and another graph's entry, leave the stamp where it was.
    subs.set(CG, { subscribed: true, synced: true, participantAgents: [CHECKSUM], onChainId: '7' });
    expect(identity(CG, CHECKSUM)!.stamp).toBe(withParticipants);
    subs.set('another-cg', { subscribed: true, synced: true });
    expect(identity(CG, CHECKSUM)!.stamp).toBe(withParticipants);
    subs.delete(CG);
    expect(identity(CG, CHECKSUM)!.stamp).toBe(absent);
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
