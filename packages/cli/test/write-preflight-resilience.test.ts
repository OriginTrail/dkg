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
//   • a REAL OxigraphWorkerStore that has been close()d — the honest
//     "the store is closed" failure a crashed/closed worker produces live —
//     alongside a healthy in-memory worker store for the no-change paths, and
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
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { ContextGraphResolveMethods } from '../../agent/src/dkg-agent-cg-resolve.js';
import { OxigraphWorkerStore, type TripleStore } from '@origintrail-official/dkg-storage';
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
  return harness;
}

// The narrow data interface resolveRequiredWriteContextGraphId consumes.
// `listContextGraphs` performs a real read against the harness store so a
// closed store rejects with the genuine worker error (the same failure mode
// the real list path hits), and a healthy store returns the given rows.
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
      contextGraphActivePublicOnChainFromRegistry: harness.contextGraphActivePublicOnChainFromRegistry,
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
const LEGACY_503_ERROR = /^Failed to validate contextGraphId against known context graphs: exact preflight failed: .*store is closed.*; list validation failed: .*store is closed/;

let closedStore: OxigraphWorkerStore;
let healthyStore: OxigraphWorkerStore;

beforeAll(async () => {
  // A real worker-backed store that has been closed: every subsequent call
  // rejects with the real `oxigraph-worker: cannot run "…" — the store is
  // closed.` error — the exact live failure this track fixes.
  closedStore = new OxigraphWorkerStore(undefined);
  await closedStore.close();
  healthyStore = new OxigraphWorkerStore(undefined);
});

afterAll(async () => {
  await healthyStore.close();
});

describe('probeContextGraphWritePreflight — store-failure resilience (real probe, real closed store)', () => {
  it('survives a closed store: keeps in-memory subscription state, flags storeUnavailable, reports store facts as UNKNOWN', async () => {
    const harness = agentHarness(
      closedStore,
      new Map([[CG, { subscribed: true, synced: true }]]),
    );
    const probe = await harness.probeContextGraphWritePreflight(CG);
    expect(probe.storeUnavailable).toBe(true);
    expect(probe.storeErrorMessage).toMatch(/store is closed/);
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

describe('resolveRequiredWriteContextGraphId — both-legs-failed rescue (real resolver, real closed store)', () => {
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
      contextGraphActivePublicOnChainFromRegistry:
        closedHarness.contextGraphActivePublicOnChainFromRegistry,
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
