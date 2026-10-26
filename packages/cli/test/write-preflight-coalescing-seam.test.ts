/**
 * Write-preflight coalescing with the real parts (OT-RFC-73 S4a, AC10): the agent's real probe, its real
 * store-mutation observer over a real in-process store, the real identity rules and the real resolver
 * (`resolveRequiredWriteContextGraphId`). The race that matters: a policy ratchet commits while a probe is
 * in flight, and a caller arriving after the commit must not be given the answer read before it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type QueryOptions } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../../agent/src/dkg-agent-cg-resolve.js';
import {
  WritePreflightGeneration,
  WritePreflightIdentityMethods,
  attachWritePreflightGeneration,
  withWritePreflightGeneration,
} from '../../agent/src/dkg-agent-write-preflight.js';
import { createMutationObservedStore } from '../../agent/src/internal/context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from '../../agent/src/internal/observed-store-mutation.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { WRITE_PREFLIGHT_CACHE_ENV, configureWritePreflightCoalescing } from '../src/daemon/write-preflight-coalescing.js';

const CG = '0x1111111111111111111111111111111111111111/seam-cg';
const CG_URI = `did:dkg:context-graph:${CG}`;
const CALLER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ON_ALLOWLIST = '0x2222222222222222222222222222222222222222';
const SCOPED = { callerAgentAddress: CALLER, allowLocalExactFallback: false } as const;
const ALLOWED = { callerAgentAddress: ON_ALLOWLIST, allowLocalExactFallback: false } as const;
const DECLARATION_SOURCE = 'agent.writePreflight.declaration';
const resolveProto = ContextGraphResolveMethods.prototype;

const policyQuad = (policy: 'public' | 'private', graph: string): Quad => ({
  subject: CG_URI, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${policy}"`, graph,
});

function captureRes(): { res: ServerResponse; out: { status?: number; body?: any } } {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) {
      if (typeof body === 'string' && body.length) out.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { res, out };
}

/** A public context graph with local content, held by a real in-process store the agent's observer watches. */
async function seamAgent() {
  const raw = new OxigraphStore();
  const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  await raw.insert([
    { subject: CG_URI, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontology },
    policyQuad('public', ontology),
    { subject: 'urn:task:1', predicate: 'urn:p', object: '"task"', graph: `${contextGraphDataGraphUri(CG)}/tasks` },
  ]);
  const generation = new WritePreflightGeneration();
  const store = createMutationObservedStore(raw, createObservedStoreMutation(
    () => {},
    withWritePreflightGeneration({ begin: () => () => {} }, generation),
  ));
  const subs = new Map<string, Record<string, unknown>>();
  const harness: any = {
    store,
    config: {},
    subscribedContextGraphs: subs,
    getSubscribedContextGraphs: () => subs,
    contextGraphExists: resolveProto.contextGraphExists,
    contextGraphHasLocalContent: resolveProto.contextGraphHasLocalContent,
    curatorDidMatchesChecksumAgent: () => false,
    // The allowlist of the graph, once it is private: one caller is on it.
    callerIsAllowlistedAgentParticipant: async (_contextGraphId: string, checksum: string) => checksum === ON_ALLOWLIST,
  };
  harness.probeContextGraphWritePreflight = (id: string, opts?: { callerAgentAddress?: string | null; onChainLookup?: () => void }) =>
    resolveProto.probeContextGraphWritePreflight.call(harness, id, opts);
  harness.writePreflightIdentity = (id: string, caller?: string | null) =>
    WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(harness, id, caller);
  attachWritePreflightGeneration(harness, generation);

  // Lets the first declaration read, the read that sees the policy, run and then holds its answer until the
  // test lets it go: that probe has read the graph as it was, and ends after the writes the test makes meanwhile.
  let declarationReads = 0;
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const query = store.query.bind(store);
  store.query = async (sparql: string, options?: QueryOptions) => {
    const answer = await query(sparql, options);
    if (options?.source === DECLARATION_SOURCE) {
      declarationReads += 1;
      if (declarationReads === 1) { reached(); await gate; }
    }
    return answer;
  };

  const provider = {
    listContextGraphs: async () => [],
    probeContextGraphWritePreflight: harness.probeContextGraphWritePreflight,
    writePreflightIdentity: harness.writePreflightIdentity,
    getSubscribedContextGraphs: harness.getSubscribedContextGraphs,
  };
  return {
    raw, store, subs, generation, provider, release, reached: reachedGate,
    declarationReads: () => declarationReads,
    resolve: async (caller: typeof SCOPED = SCOPED) => {
      const { res, out } = captureRes();
      const id = await resolveRequiredWriteContextGraphId(provider as never, CG, res, caller);
      return { id, out };
    },
  };
}

/** A caller that must finish while the older probe is held fails fast instead of waiting for it. */
function whileHeld<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('still waiting on the probe that was held')), 5_000);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

beforeEach(() => { configureWritePreflightCoalescing({}, { info: () => {}, warn: () => {} }); });
afterEach(() => { configureWritePreflightCoalescing({}, { info: () => {}, warn: () => {} }); });

describe('concurrent write preflights with the real probe', () => {
  it('read the store once for callers that arrive together, and again once the probe is over', async () => {
    const seam = await seamAgent();
    const first = seam.resolve();
    const joiners = [seam.resolve(), seam.resolve(), seam.resolve(), seam.resolve()];
    seam.release();
    const results = await Promise.all([first, ...joiners]);
    expect(results.map(({ id }) => id)).toEqual(Array(5).fill(CG));
    expect(seam.declarationReads()).toBe(1);
    expect((await seam.resolve()).id).toBe(CG);
    expect(seam.declarationReads()).toBe(2);
  });

  it('give each caller the answer for itself', async () => {
    const seam = await seamAgent();
    await seam.store.insert([policyQuad('private', contextGraphMetaGraphUri(CG))]);
    const stranger = seam.resolve();
    const allowlisted = seam.resolve(ALLOWED);
    const strangerAgain = seam.resolve();
    seam.release();
    const [denied, accepted, alsoDenied] = await Promise.all([stranger, allowlisted, strangerAgain]);
    expect(denied.id).toBeNull();
    expect(denied.out).toMatchObject({ status: 400, body: { code: 'CONTEXT_GRAPH_NOT_FOUND' } });
    expect(alsoDenied.id).toBeNull();
    expect(accepted.id).toBe(CG);
    // The two callers are two probes; the stranger's second call joined the first.
    expect(seam.declarationReads()).toBe(2);
  });
});

describe('a ratchet commit during an in-flight probe', () => {
  it('does not reach a caller that arrives after the commit; the earlier caller keeps what it read', async () => {
    const seam = await seamAgent();
    const before = seam.resolve(); // its probe is blocked at the declaration read
    await seam.reached;
    expect(seam.declarationReads()).toBe(1);

    // The graph is ratcheted to private and the write is acknowledged.
    await seam.store.insert([policyQuad('private', contextGraphMetaGraphUri(CG))]);

    const after = await whileHeld(seam.resolve()); // completes while the older probe is still blocked
    expect(seam.declarationReads()).toBe(2);
    expect(after.id).toBeNull();
    expect(after.out).toMatchObject({ status: 400, body: { code: 'CONTEXT_GRAPH_NOT_FOUND' } });

    seam.release();
    const earlier = await before;
    expect(earlier.id).toBe(CG);
  });

  it('is seen through an agents-graph write and an ontology-graph write alike', async () => {
    for (const graph of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
      const seam = await seamAgent();
      const before = seam.resolve();
      await seam.reached;
      await seam.store.insert([policyQuad('private', contextGraphDataGraphUri(graph))]);
      const after = await whileHeld(seam.resolve());
      expect(seam.declarationReads()).toBe(2);
      expect(after.id).toBeNull();
      seam.release();
      expect((await before).id).toBe(CG);
    }
  });

  it('is seen through a subscription change as well', async () => {
    const seam = await seamAgent();
    const before = seam.resolve();
    await seam.reached;
    seam.subs.set(CG, { subscribed: true, synced: true });
    await whileHeld(seam.resolve());
    expect(seam.declarationReads()).toBe(2);
    seam.release();
    await before;
  });

  it('is not triggered by content arriving in the graph, which is not a policy source', async () => {
    const seam = await seamAgent();
    const before = seam.resolve();
    await seam.reached;
    await seam.store.insert([{ subject: 'urn:task:2', predicate: 'urn:p', object: '"more"', graph: `${contextGraphDataGraphUri(CG)}/tasks` }]);
    const joined = seam.resolve();
    seam.release();
    expect((await joined).id).toBe(CG);
    expect((await before).id).toBe(CG);
    expect(seam.declarationReads()).toBe(1);
  });

  it('boundary: a write that does not pass the agent\'s store observer cannot move the generation', async () => {
    const seam = await seamAgent();
    const before = seam.resolve();
    await seam.reached;
    // Straight into the engine, around the wrapper the agent builds. The daemon has no such writer; this shows
    // what the guarantee rests on, and that the tests above fail for the right reason.
    await seam.raw.insert([policyQuad('private', contextGraphMetaGraphUri(CG))]);
    const joined = seam.resolve();
    seam.release();
    expect((await joined).id).toBe(CG);
    expect((await before).id).toBe(CG);
    expect(seam.declarationReads()).toBe(1);
  });

  it('also holds with the result cache on: a kept fast accept does not survive the ratchet', async () => {
    configureWritePreflightCoalescing({ [WRITE_PREFLIGHT_CACHE_ENV]: '1' }, { info: () => {}, warn: () => {} });
    const seam = await seamAgent();
    seam.release(); // nothing blocked in this scenario
    expect((await seam.resolve()).id).toBe(CG);
    expect((await seam.resolve()).id).toBe(CG);
    expect(seam.declarationReads()).toBe(1); // the second was served from the cache
    await seam.store.insert([policyQuad('private', contextGraphMetaGraphUri(CG))]);
    const after = await seam.resolve();
    expect(after.id).toBeNull();
    expect(seam.declarationReads()).toBe(2);
  });
});
