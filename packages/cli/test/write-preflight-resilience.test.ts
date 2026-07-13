// Write-preflight resilience under local-store failure — NO MOCKS.
//
// Track B of the testnet store-outage fixes: on a live node, a slow or dead
// triple store made BOTH write-preflight legs throw (the exact probe's
// Promise.all of 4 store reads, then listContextGraphs' store-wide scan), so
// EVERY write route answered 503 CONTEXT_GRAPH_VALIDATION_UNAVAILABLE — even
// for a registered PUBLIC context graph the daemon actively hosts.
//
// This file pins the rescue design end-to-end with real components:
//
//   • the REAL `probeContextGraphWritePreflight` /
//     `contextGraphActivePublicOnChainFromRegistry` / `contextGraphExists`
//     methods (invoked via ContextGraphResolveMethods.prototype on a narrow
//     harness carrying real state, the same shape the DKGAgent mixin sees), and
//   • a REAL SparqlHttpStore pointed at an unavailable loopback endpoint — the
//     honest connection failure an unavailable external/managed store produces
//     live — alongside a healthy embedded store for the no-change paths, and
//   • the REAL `resolveRequiredWriteContextGraphId` resolver with a real
//     captured ServerResponse sink (same conventions as
//     context-graph-write-path-validation.test.ts).
//
// Accept-only-on-positive-evidence invariant pinned here:
//   the rescue accepts ONLY on positive on-chain proof that an id ALREADY in
//   the in-memory registry is an ACTIVE, PUBLIC context graph
//   (isContextGraphActiveOnChain AND getContextGraphAccessPolicy === 0). It
//   deliberately does NOT accept on an in-memory subscription alone: a
//   subscribed CG may be PRIVATE, whose per-caller authorization is derived
//   from the local `_meta` allowlist — exactly what's unavailable store-down —
//   so admitting it would convert the healthy path's authoritative-bearer DENY
//   into an accept. A raw unknown candidate, a chain "not-active", a NON-public
//   policy, a chain throw, or a missing adapter all keep the legacy fail-closed
//   responses byte-for-byte.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ServerResponse } from 'node:http';
import {
  resolveRequiredWriteContextGraphId,
  WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS,
} from '../src/daemon/http-utils.js';
import { ContextGraphResolveMethods } from '../../agent/src/dkg-agent-cg-resolve.js';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';

const CG = 'resilience-cg';
const UNSCOPED = { callerAgentAddress: undefined, allowLocalExactFallback: true } as const;

// Real prototype methods from the agent mixin — the exact code the daemon
// runs, bound to a narrow harness instead of a full DKGAgent (which would
// need libp2p + hardhat here for no additional coverage of THIS seam).
const resolveProto = ContextGraphResolveMethods.prototype;

type SubEntry = { subscribed: boolean; synced: boolean; onChainId?: string };
type ChainStub = {
  isContextGraphActiveOnChain?: (id: bigint) => Promise<boolean>;
  getContextGraphAccessPolicy?: (id: bigint) => Promise<number>;
};

function recorder<A extends unknown[], R>(impl: (...a: A) => R) {
  const calls: A[] = [];
  const fn = (...a: A): R => {
    calls.push(a);
    return impl(...a);
  };
  return Object.assign(fn, { calls });
}

// Narrow agent harness: real store, real in-memory registry map, real
// prototype methods. `chain` is the injected-adapter seam the agent already
// has (config.chainAdapter), carrying only the two reads under test.
function agentHarness(
  store: TripleStore,
  subs: Map<string, SubEntry>,
  chain?: ChainStub,
) {
  const harness: any = {
    store,
    config: {},
    subscribedContextGraphs: subs,
    chain,
    contextGraphExists: resolveProto.contextGraphExists,
    contextGraphHasLocalContent: resolveProto.contextGraphHasLocalContent,
    // Only reachable with a caller + a locally-declared private CG — none of
    // these scenarios. Present so an accidental reach fails an assertion
    // rather than a TypeError.
    curatorDidMatchesChecksumAgent: () => false,
    callerIsAllowlistedAgentParticipant: async () => false,
  };
  harness.probeContextGraphWritePreflight = (
    id: string,
    opts?: { callerAgentAddress?: string | null },
  ) => resolveProto.probeContextGraphWritePreflight.call(harness, id, opts);
  harness.contextGraphActivePublicOnChainFromRegistry = (id: string) =>
    resolveProto.contextGraphActivePublicOnChainFromRegistry.call(harness, id);
  // High-level store-outage rescue decision the daemon calls — owns the
  // on-chain active+public policy semantics (wraps the registry read above).
  harness.validateWriteTargetDuringStoreOutage = (id: string) =>
    resolveProto.validateWriteTargetDuringStoreOutage.call(harness, id);
  return harness;
}

// The narrow data interface resolveRequiredWriteContextGraphId consumes.
// `listContextGraphs` performs a real read against the harness store so a
// unavailable store rejects with a genuine adapter error (the same failure
// mode the real list path hits), and a healthy store returns the given rows.
function providerFor(harness: any, rows: Array<Record<string, unknown>> = []) {
  const listCalls: Array<unknown> = [];
  return {
    listCalls,
    provider: {
      async listContextGraphs(opts?: { callerAgentAddress?: string | null }) {
        listCalls.push(opts);
        await (harness.store as TripleStore).query(
          'SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1',
        );
        return rows as any;
      },
      probeContextGraphWritePreflight: harness.probeContextGraphWritePreflight,
      validateWriteTargetDuringStoreOutage: harness.validateWriteTargetDuringStoreOutage,
      contextGraphExists: (id: string) => resolveProto.contextGraphExists.call(harness, id),
      contextGraphHasLocalContent: (id: string) =>
        resolveProto.contextGraphHasLocalContent.call(harness, id),
    },
  };
}

// Captured HTTP response sink (same shape as the resolver's other unit
// tests): on the success path the resolver returns the id and never touches
// `res`.
function captureRes(): { res: ServerResponse; out: { status?: number; body?: any } } {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string' && body.length) {
        try {
          out.body = JSON.parse(body);
        } catch {
          out.body = body;
        }
      }
    },
  } as unknown as ServerResponse;
  return { res, out };
}

// The exact legacy 503 body the pre-resilience code produced when both legs
// threw. Live callers and tests grep for this — the rescue must leave it
// byte-compatible whenever it does NOT accept.
const LEGACY_503_ERROR = /^Failed to validate contextGraphId against known context graphs: exact preflight failed: .*fetch failed.*; list validation failed: .*fetch failed/;

let closedStore: TripleStore;
let healthyStore: TripleStore;

beforeAll(async () => {
  // A real external-store adapter pointed at an unavailable endpoint: every
  // query rejects through the same fetch path used by managed/external stores.
  closedStore = await createTripleStore({
    backend: 'sparql-http',
    options: {
      queryEndpoint: 'http://127.0.0.1:65535/query',
      updateEndpoint: 'http://127.0.0.1:65535/update',
    },
  });
  healthyStore = await createTripleStore({ backend: 'oxigraph' });
});

afterAll(async () => {
  await closedStore.close();
  await healthyStore.close();
});

describe('probeContextGraphWritePreflight — store-failure resilience (real probe, unavailable store)', () => {
  it('detects local content from indexed graph names while ignoring bookkeeping-only graphs', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const listGraphsByPrefix = store.listGraphsByPrefix?.bind(store);
    expect(typeof listGraphsByPrefix).toBe('function');
    const prefixCalls: string[] = [];
    store.listGraphsByPrefix = async (prefix, options) => {
      prefixCalls.push(prefix);
      return listGraphsByPrefix!(prefix, options);
    };
    const metaOnly = 'local-content-meta-only';
    const withContent = 'local-content-data';
    try {
      await store.insert([
        {
          subject: 'urn:meta',
          predicate: 'urn:p',
          object: '"meta"',
          graph: `${contextGraphDataGraphUri(metaOnly)}/_meta`,
        },
        {
          subject: 'urn:shared-meta',
          predicate: 'urn:p',
          object: '"shared-meta"',
          graph: `${contextGraphDataGraphUri(metaOnly)}/_shared_memory_meta`,
        },
        {
          subject: 'urn:task',
          predicate: 'urn:p',
          object: '"task"',
          graph: `${contextGraphDataGraphUri(withContent)}/tasks`,
        },
        {
          subject: 'urn:context-entry',
          predicate: 'urn:p',
          object: '"context"',
          graph: `${contextGraphDataGraphUri(withContent)}/context/1`,
        },
      ]);
      const harness = agentHarness(store, new Map());

      await expect(harness.contextGraphHasLocalContent(metaOnly)).resolves.toBe(false);
      await expect(harness.contextGraphHasLocalContent(withContent)).resolves.toBe(true);
      expect(prefixCalls).toEqual([
        contextGraphDataGraphUri(metaOnly),
        contextGraphDataGraphUri(withContent),
      ]);
    } finally {
      await store.close();
    }
  });

  it('survives a closed store: keeps in-memory subscription state, flags storeUnavailable, reports store facts as UNKNOWN', async () => {
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true }]]),
    );
    const probe = await harness.probeContextGraphWritePreflight(CG);
    expect(probe.storeUnavailable).toBe(true);
    expect(probe.storeErrorMessage).toMatch(/fetch failed/);
    // In-memory registry state needs zero store I/O and must survive.
    expect(probe.inMemorySubscription).toEqual({ subscribed: true, synced: true });
    // Store-derived facts are UNKNOWN — a store outage must never be
    // presentable as a definitive "does not exist" deny.
    expect(probe.exists).toBeUndefined();
    expect(probe.hasLocalContent).toBeUndefined();
    expect(probe.declarationFound).toBeUndefined();
  });

  it('keeps the healthy-store probe shape unchanged (definitive booleans, no storeUnavailable flag)', async () => {
    const harness = agentHarness(healthyStore, new Map());
    const probe = await harness.probeContextGraphWritePreflight('nonexistent-cg');
    expect(probe.storeUnavailable).toBeUndefined();
    expect(probe.storeErrorMessage).toBeUndefined();
    expect(probe.exists).toBe(false);
    expect(probe.hasLocalContent).toBe(false);
    expect(probe.declarationFound).toBe(false);
  });

  it('degrades per-read: a failing persisted-subscription store flags storeUnavailable without discarding healthy store facts', async () => {
    const harness = agentHarness(healthyStore, new Map());
    harness.config = {
      contextGraphSubscriptionStore: {
        load: async () => {
          throw new Error('subscription db locked');
        },
      },
    };
    const probe = await harness.probeContextGraphWritePreflight('nonexistent-cg');
    expect(probe.storeUnavailable).toBe(true);
    expect(probe.storeErrorMessage).toMatch(/subscription db locked/);
    // The triple-store reads succeeded and stay definitive.
    expect(probe.exists).toBe(false);
    expect(probe.declarationFound).toBe(false);
    expect(probe.persistedSubscription).toBeUndefined();
  });
});

describe('resolveRequiredWriteContextGraphId — both-legs-failed rescue (real resolver, unavailable store)', () => {
  it('(a) ACCEPTS on positive on-chain proof the CG is active AND PUBLIC', async () => {
    const isActive = recorder(async (id: bigint) => id === 7n);
    const getAccessPolicy = recorder(async (_id: bigint) => 0); // 0 = public
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true, onChainId: '7' }]]),
      { isContextGraphActiveOnChain: isActive, getContextGraphAccessPolicy: getAccessPolicy },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBe(CG);
    expect(out.status).toBeUndefined();
    expect(isActive.calls).toEqual([[7n]]);
    expect(getAccessPolicy.calls).toEqual([[7n]]);
  });

  it('(a) accepts even when the subscription is not marked synced, as long as on-chain proof is active+public', async () => {
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: false, synced: false, onChainId: '7' }]]),
      {
        isContextGraphActiveOnChain: async (id) => id === 7n,
        getContextGraphAccessPolicy: async () => 0,
      },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBe(CG);
    expect(out.status).toBeUndefined();
  });

  it('(SECURITY) refuses to rescue a PRIVATE CG even when it is active on-chain AND actively subscribed — never converts the private-CG bearer DENY into an accept', async () => {
    // The exact adversarial-review scenario: node hosts a private CG (subscribed
    // + synced + on-chain id), the store is down so per-caller authorization
    // (from _meta) can't be checked, and an authenticated caller targets it. On
    // a healthy store this is a 400 authoritative-bearer deny; the rescue must
    // NOT upgrade it to an accept just because the node tracks the CG.
    const getAccessPolicy = recorder(async (_id: bigint) => 1); // 1 = private
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true, onChainId: '7' }]]),
      {
        isContextGraphActiveOnChain: async (id) => id === 7n,
        getContextGraphAccessPolicy: getAccessPolicy,
      },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(out.body.error).toMatch(LEGACY_503_ERROR);
    // The policy read must actually have been consulted (active → policy).
    expect(getAccessPolicy.calls).toEqual([[7n]]);
  });

  it('(SECURITY) an ACTIVE in-memory subscription ALONE (no on-chain adapter) does NOT rescue — keeps the 503', async () => {
    // Subscription alone proves the node hosts the CG but carries no access
    // policy and no caller authorization; without on-chain public proof the
    // rescue must fail closed.
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true }]]),
      undefined,
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(out.body.error).toMatch(LEGACY_503_ERROR);
  });

  it('(c) keeps the exact legacy 503 when the chain says the CG is NOT active (policy never read)', async () => {
    const isActive = recorder(async () => false);
    const getAccessPolicy = recorder(async () => 0);
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: false, synced: false, onChainId: '7' }]]),
      { isContextGraphActiveOnChain: isActive, getContextGraphAccessPolicy: getAccessPolicy },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(out.body.error).toMatch(LEGACY_503_ERROR);
    // Short-circuit: no active ⇒ no policy read.
    expect(isActive.calls).toEqual([[7n]]);
    expect(getAccessPolicy.calls).toEqual([]);
  });

  it('(c) keeps the exact legacy 503 when the chain read throws', async () => {
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: false, synced: false, onChainId: '7' }]]),
      {
        isContextGraphActiveOnChain: async () => {
          throw new Error('rpc unavailable');
        },
        getContextGraphAccessPolicy: async () => 0,
      },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(out.body.error).toMatch(LEGACY_503_ERROR);
  });

  it('(c) never rescues a raw unknown candidate: no registry entry ⇒ 503, chain never consulted', async () => {
    const isActive = recorder(async () => true);
    const getAccessPolicy = recorder(async () => 0);
    const harness = agentHarness(closedStore, new Map(), {
      isContextGraphActiveOnChain: isActive,
      getContextGraphAccessPolicy: getAccessPolicy,
    });
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'unknown-cg', res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    // Shadow-CG fail-closed design: the rescue may only accept ids the
    // daemon ALREADY tracks — an untracked candidate never reaches the
    // chain read (contextGraphActivePublicOnChainFromRegistry short-circuits).
    expect(isActive.calls).toEqual([]);
    expect(getAccessPolicy.calls).toEqual([]);
  });

  it('(c) keeps the 503 when the agent has no chain adapter at all', async () => {
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: false, synced: false, onChainId: '7' }]]),
      undefined,
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
  });

  it('(GATE) a DEFINITIVE local miss from a HEALTHY exact probe is authoritative — when only the list leg throws, keep the legacy 503 and NEVER run the chain rescue', async () => {
    // Bug-bot 🔴: the rescue previously ran on EVERY both-legs-failed. But if
    // the exact probe SUCCEEDED against a healthy store and returned a
    // definitive local miss (storeAvailable, exists:false, no local content, no
    // declaration), that probe is AUTHORITATIVE for local existence — the id
    // genuinely is not here. If only listContextGraphs then throws (a transient
    // list-path failure), the on-chain rescue must NOT override that definitive
    // miss and admit an id the store just told us it lacks. So the rescue is
    // GATED to run only when the exact probe itself was unavailable.
    //
    // On-chain state here WOULD say active+public (id 7n), so if the gate were
    // absent the rescue would wrongly accept. The recorders prove the chain read
    // is never even consulted.
    const isActive = recorder(async () => true);
    const getAccessPolicy = recorder(async () => 0);
    // Healthy store + empty registry ⇒ the real probe returns a definitive
    // miss (exists:false, storeAvailable:true). The registry still carries the
    // onChainId so the rescue COULD resolve it — the gate, not a missing id, is
    // what keeps it out.
    const harness = agentHarness(
      healthyStore,
      new Map([[CG, { subscribed: false, synced: false, onChainId: '7' }]]),
      { isContextGraphActiveOnChain: isActive, getContextGraphAccessPolicy: getAccessPolicy },
    );
    // A provider whose exact probe uses the HEALTHY harness (definitive miss)
    // but whose list leg throws a transient failure — the exact scenario the
    // gate protects: successful probe, failed list.
    const provider = {
      listContextGraphs: async () => {
        throw new Error('list projection transiently unavailable');
      },
      probeContextGraphWritePreflight: harness.probeContextGraphWritePreflight,
      validateWriteTargetDuringStoreOutage: harness.validateWriteTargetDuringStoreOutage,
      contextGraphExists: (id: string) => resolveProto.contextGraphExists.call(harness, id),
    };
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    // Fail-closed: legacy 503, NOT an accept.
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    // A healthy probe means no "exact preflight failed:" prefix — only the list
    // leg failed, so the message is the bare list error.
    expect(out.body.error).toBe(
      'Failed to validate contextGraphId against known context graphs: list projection transiently unavailable',
    );
    // THE gate assertion: the chain rescue read was never consulted, because a
    // definitive healthy miss is authoritative and blocks the rescue entirely.
    expect(isActive.calls).toEqual([]);
    expect(getAccessPolicy.calls).toEqual([]);
  });

  it('(TIMEOUT) a chain rescue that never resolves falls back to the legacy 503 via the bounded timeout', async () => {
    // Bug-bot 🟡: the 5s Promise.race timeout guards a hung RPC stack. Drive it
    // with a validateWriteTargetDuringStoreOutage that NEVER settles; an
    // injected tiny timeout (production default stays 5s) makes the test finish
    // instantly. The resolver must fall back to the fail-closed 503, exactly as
    // if the chain read had resolved false.
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true, onChainId: '7' }]]),
      {
        // Never resolves — simulates an RPC stack hung on connect.
        isContextGraphActiveOnChain: () => new Promise<boolean>(() => {}),
        getContextGraphAccessPolicy: async () => 0,
      },
    );
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const started = Date.now();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, {
      ...UNSCOPED,
      // Test-only seam: shrink the rescue timeout so we don't wait 5 real
      // seconds. Production callers never pass this.
      chainRescueTimeoutMs: 25,
    });
    // Sanity: the injected bound (25ms) is well under the production default,
    // proving the seam — not real wall-clock luck — ended the race.
    expect(Date.now() - started).toBeLessThan(WRITE_PREFLIGHT_CHAIN_RESCUE_TIMEOUT_MS);
    expect(resolved).toBeNull();
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(out.body.error).toMatch(LEGACY_503_ERROR);
  });
});

describe('resolveRequiredWriteContextGraphId — healthy-store paths unchanged', () => {
  it('(d) still denies an unknown CG with the legacy 400 CONTEXT_GRAPH_NOT_FOUND', async () => {
    const harness = agentHarness(healthyStore, new Map());
    const { provider } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, 'missing-cg', res, UNSCOPED);
    expect(resolved).toBeNull();
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
  });

  it('(e) healthy probe still fast-accepts a declared public synced CG without consulting listContextGraphs', async () => {
    const seededCg = 'declared-public-cg';
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgUri = `did:dkg:context-graph:${seededCg}`;
    await healthyStore.insert([
      {
        subject: cgUri,
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: ontologyGraph,
      },
      {
        subject: cgUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: ontologyGraph,
      },
    ]);
    const harness = agentHarness(
      healthyStore,
      new Map([[seededCg, { subscribed: true, synced: true }]]),
    );
    const { provider, listCalls } = providerFor(harness);
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, seededCg, res, UNSCOPED);
    expect(resolved).toBe(seededCg);
    expect(out.status).toBeUndefined();
    // Fast-accept means the composite list leg is never touched — the
    // resilience changes must not slow down or reroute the healthy path.
    expect(listCalls).toEqual([]);
    // And the healthy probe carries no storeUnavailable residue.
    const probe = await harness.probeContextGraphWritePreflight(seededCg);
    expect(probe.storeUnavailable).toBeUndefined();
    expect(probe.exists).toBe(true);
  });

  it('(e) a storeUnavailable exact probe does not poison a healthy list leg (list evidence still accepts)', async () => {
    // Partial outage: the probe's store reads fail, but the composite list
    // succeeds (e.g. store recovered between the legs). Pre-fix the probe
    // THREW and the list leg decided; the storeUnavailable probe must land
    // in the same place — no stale-subscription deny synthesized from
    // UNKNOWN store facts, and no on-chain rescue needed.
    const closedHarness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true }]]),
    );
    const provider = {
      listContextGraphs: async () => [
        { id: CG, uri: `did:dkg:context-graph:${CG}`, subscribed: true, synced: true },
      ] as any,
      probeContextGraphWritePreflight: closedHarness.probeContextGraphWritePreflight,
      validateWriteTargetDuringStoreOutage:
        closedHarness.validateWriteTargetDuringStoreOutage,
    };
    const { res, out } = captureRes();
    const resolved = await resolveRequiredWriteContextGraphId(provider, CG, res, UNSCOPED);
    expect(resolved).toBe(CG);
    expect(out.status).toBeUndefined();
  });
});

describe('contextGraphExists — bounded survivor fallback (real store)', () => {
  it('finds a shared-memory-only survivor via point lookups (no store-wide scan)', async () => {
    const survivor = 'swm-survivor-cg';
    await healthyStore.insert([
      {
        subject: 'urn:s',
        predicate: 'urn:p',
        object: '"o"',
        graph: `did:dkg:context-graph:${survivor}/_shared_memory`,
      },
    ]);
    const harness = agentHarness(healthyStore, new Map());
    await expect(resolveProto.contextGraphExists.call(harness, survivor)).resolves.toBe(true);
  });

  it('answers curated ids without a declaration as nonexistent, matching the legacy scan semantics', async () => {
    const harness = agentHarness(healthyStore, new Map());
    await expect(
      resolveProto.contextGraphExists.call(harness, '0x1234567890123456789012345678901234567890/slug'),
    ).resolves.toBe(false);
  });
});
