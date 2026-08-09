import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  SYSTEM_CONTEXT_GRAPHS,
  Logger,
  TypedEventBus,
  encodePublishRequest,
  decodePublishAck,
} from '@origintrail-official/dkg-core';
import { generateTentativeMetadata, type KAMetadata } from '../src/index.js';
import {
  pruneSupersededAgentRegistryMeta,
  insertBoundedAgentRegistryMeta,
} from '../src/agent-registry-meta-retention.js';
import { PublishHandler } from '../src/publish-handler.js';

// #1233 follow-up — the residual, LOAD-BEARING `_meta` write sites (the
// direct-protocol receive handler + the confirmed-metadata restatement) cannot
// be write-skipped for the agents system CG the way #1234 skipped the two
// high-volume paths, because their record drives the tentative→confirm/expire
// lifecycle. Instead they PRUNE the same agent's prior record before inserting
// the fresh one. This suite exercises that exact write-site sequence
// (generateTentativeMetadata → pruneSupersededAgentRegistryMeta → insert) against
// a real store and asserts: (b) agents/_meta stays bounded across N heartbeats,
// (a) the live tentative record survives and still expires, (c) a user CG keeps
// full history.

const AGENTS = SYSTEM_CONTEXT_GRAPHS.AGENTS;
const STATUS = 'http://dkg.io/ontology/status';
const metaOf = (cg: string) => `did:dkg:context-graph:${cg}/_meta`;

function agentDid(id: number): string {
  return `did:dkg:agent:0x${id.toString(16).padStart(40, '0')}`;
}

// Every heartbeat mints a FRESH UAL (mirrors production: agents publishes never
// confirm on-chain, so each heartbeat is a new publish with a new UAL). The tag
// makes each UAL globally unique across agents AND rounds.
function mkUal(tag: string): string {
  return `did:dkg:evm:31337/0x1111111111111111111111111111111111111111/${tag}`;
}

/**
 * Replays what the load-bearing tentative write site does per heartbeat: build
 * the tracking rows for a fresh UAL, prune the SAME agent's prior rows, insert.
 * Returns the inserted quads — the object `expireTentativePublish` would later
 * delete — so the lifecycle-teardown assertion can use it verbatim.
 */
async function heartbeat(
  store: OxigraphStore,
  cg: string,
  rootEntity: string,
  ual: string,
): Promise<Quad[]> {
  const kaMeta: KAMetadata[] = [
    { rootEntity, kcUal: ual, tokenId: 1n, publicTripleCount: 1, privateTripleCount: 0 },
  ];
  const metaQuads = generateTentativeMetadata(
    { ual, contextGraphId: cg, merkleRoot: new Uint8Array(32), publisherPeerId: 'peer', timestamp: new Date() },
    kaMeta,
  );
  await pruneSupersededAgentRegistryMeta({
    store,
    contextGraphId: cg,
    metaGraph: metaOf(cg),
    rootEntities: [rootEntity],
    keepUal: ual,
  });
  await store.insert(metaQuads);
  return metaQuads;
}

/** Build (without inserting) the collapsed tentative `_meta` rows for a heartbeat. */
function metaQuadsFor(cg: string, rootEntity: string, ual: string): Quad[] {
  return generateTentativeMetadata(
    { ual, contextGraphId: cg, merkleRoot: new Uint8Array(32), publisherPeerId: 'peer', timestamp: new Date() },
    [{ rootEntity, kcUal: ual, tokenId: 1n, publicTripleCount: 1, privateTripleCount: 0 }],
  );
}

/** Build (without inserting) a MULTI-root record — one member row per root, same UAL. */
function metaQuadsForRoots(cg: string, roots: string[], ual: string): Quad[] {
  return generateTentativeMetadata(
    { ual, contextGraphId: cg, merkleRoot: new Uint8Array(32), publisherPeerId: 'peer', timestamp: new Date() },
    roots.map((rootEntity, i) => ({
      rootEntity, kcUal: ual, tokenId: BigInt(i + 1), publicTripleCount: 1, privateTripleCount: 0,
    })),
  );
}

async function tentativeUals(store: OxigraphStore, cg: string): Promise<string[]> {
  const res = await store.query(
    `SELECT DISTINCT ?ual WHERE { GRAPH <${metaOf(cg)}> { ?ual <${STATUS}> "tentative" } }`,
  );
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((r) => (typeof r['ual'] === 'string' ? r['ual'].replace(/^<(.*)>$/, '$1') : ''))
    .filter((u) => u.length > 0);
}

async function ask(store: OxigraphStore, sparql: string): Promise<boolean> {
  const res = await store.query(sparql);
  return res.type === 'boolean' && res.value === true;
}

// A call-counting proxy over a real store. The prune MUST reach the store only
// via a single structured server-side prune — never via `countQuads`/`deleteByPattern`/
// `deleteBySubjectPrefix`, each of which brackets its work with full-graph COUNT
// scans on the production Blazegraph backend (the BLOCKER this rewrite fixes,
// invisible to a plain Oxigraph assertion). The OxigraphStore backing the proxy
// implements `structuredMutation()`, so the real DELETE still runs.
const COUNTED = ['structuredMutation', 'update', 'countQuads', 'deleteByPattern', 'deleteBySubjectPrefix', 'query', 'insert', 'delete'] as const;
type Counts = Record<(typeof COUNTED)[number], number>;

function makeCountingStore(inner: OxigraphStore): { store: OxigraphStore; calls: Counts } {
  const calls = Object.fromEntries(COUNTED.map((k) => [k, 0])) as Counts;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig === 'function' && typeof prop === 'string' && (COUNTED as readonly string[]).includes(prop)) {
        return (...args: unknown[]) => {
          calls[prop as keyof Counts]++;
          return (orig as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return orig;
    },
  }) as unknown as OxigraphStore;
  return { store, calls };
}

describe('agents/_meta bound at the residual load-bearing write sites (#1233)', () => {
  it('(b) bounds agents/_meta to one live record per agent across many heartbeats', async () => {
    const agent = agentDid(0xa1);

    // Baseline: a single heartbeat's record size.
    const single = new OxigraphStore();
    await heartbeat(single, AGENTS, agent, mkUal('ag-0'));
    const singleCount = await single.countQuads(metaOf(AGENTS));
    expect(singleCount).toBeGreaterThan(0);

    // N heartbeats for the SAME agent (fresh UAL each) must NOT accumulate.
    const many = new OxigraphStore();
    const N = 12;
    for (let i = 0; i < N; i++) await heartbeat(many, AGENTS, agent, mkUal(`ag-${i}`));

    expect(
      await many.countQuads(metaOf(AGENTS)),
      'agents/_meta stays the size of ONE record, not N (bounded, not linear)',
    ).toBe(singleCount);
    expect(
      await tentativeUals(many, AGENTS),
      'exactly the latest heartbeat survives as the live tentative record',
    ).toEqual([mkUal(`ag-${N - 1}`)]);
  });

  it('(b) keeps one record PER agent — O(agents), not a single global record', async () => {
    const store = new OxigraphStore();
    const a1 = agentDid(0xa1);
    const a2 = agentDid(0xa2);
    for (let i = 0; i < 5; i++) {
      await heartbeat(store, AGENTS, a1, mkUal(`a1-${i}`));
      await heartbeat(store, AGENTS, a2, mkUal(`a2-${i}`));
    }
    const live = (await tentativeUals(store, AGENTS)).sort();
    expect(live, 'one live record per distinct agent, both preserved').toEqual(
      [mkUal('a1-4'), mkUal('a2-4')].sort(),
    );
    expect(live.length, 'bound is per-agent (2 agents → 2 records), not global (1)').toBe(2);
  });

  it('(a) preserves the tentative lifecycle: latest record is live and still expires', async () => {
    const store = new OxigraphStore();
    const agent = agentDid(0xa1);
    for (let i = 0; i < 3; i++) await heartbeat(store, AGENTS, agent, mkUal(`hb-${i}`));
    const lastUal = mkUal('hb-3');
    const lastMeta = await heartbeat(store, AGENTS, agent, lastUal);

    // The live tentative record for the latest UAL exists — this is exactly the
    // record the tentative→confirm/expire state machine acts on.
    expect(
      await ask(store, `ASK { GRAPH <${metaOf(AGENTS)}> { <${lastUal}> <${STATUS}> "tentative" } }`),
      'the current heartbeat still has its live tentative record',
    ).toBe(true);

    // A superseded prior heartbeat was actually evicted (the bound held).
    expect(
      await ask(store, `ASK { GRAPH <${metaOf(AGENTS)}> { <${mkUal('hb-0')}> ?p ?o } }`),
      'a superseded prior heartbeat record is gone',
    ).toBe(false);

    // Expiry (expireTentativePublish deletes the captured metadataQuads) still
    // tears the live record down → the lifecycle terminates cleanly, nothing left.
    await store.delete(lastMeta);
    expect(
      await store.countQuads(metaOf(AGENTS)),
      'the live record still expires/cleans up — agents/_meta empties out',
    ).toBe(0);
  });

  it('(c) leaves a user CG _meta untouched — full per-heartbeat history preserved', async () => {
    const store = new OxigraphStore();
    const cg = 'user-cg';
    const root = 'did:dkg:entity:some-thing';
    const N = 7;
    for (let i = 0; i < N; i++) await heartbeat(store, cg, root, mkUal(`u-${i}`));

    const live = await tentativeUals(store, cg);
    expect(live.length, 'a normal CG keeps every heartbeat record (no prune)').toBe(N);
    expect(new Set(live).size, 'all N distinct UALs retained').toBe(N);
  });

  it('is count-free: prune reaches the store only via the bounded capability', async () => {
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    const priorUal = mkUal('prior');

    // Seed a prior tentative record directly on the base store (uncounted).
    await base.insert(
      generateTentativeMetadata(
        { ual: priorUal, contextGraphId: AGENTS, merkleRoot: new Uint8Array(32), publisherPeerId: 'peer', timestamp: new Date() },
        [{ rootEntity: agent, kcUal: priorUal, tokenId: 1n, publicTripleCount: 1, privateTripleCount: 0 }],
      ),
    );
    expect(await base.countQuads(metaOf(AGENTS))).toBeGreaterThan(0);

    const { store, calls } = makeCountingStore(base);
    await pruneSupersededAgentRegistryMeta({
      store,
      contextGraphId: AGENTS,
      metaGraph: metaOf(AGENTS),
      rootEntities: [agent],
      keepUal: mkUal('current'),
    });

    // The count-free contract: one structured server-side prune, and ZERO raw
    // updates or
    // full-graph-COUNT-bracketed delete/count helpers (the production BLOCKER).
    expect(calls.structuredMutation, 'prune issues one bounded operation').toBe(1);
    expect(calls.update, 'caller does not issue raw UPDATE').toBe(0);
    expect(calls.countQuads, 'no full-graph COUNT scans').toBe(0);
    expect(calls.deleteByPattern, 'no per-pattern delete (each does 2 COUNT scans on Blazegraph)').toBe(0);
    expect(calls.deleteBySubjectPrefix, 'no prefix delete (each does 2 COUNT scans on Blazegraph)').toBe(0);
    expect(calls.query, 'no separate SELECT round-trip — one UPDATE does it all').toBe(0);

    // …and the capability actually evicted the superseded prior record.
    expect(await base.countQuads(metaOf(AGENTS)), 'the prior record was deleted').toBe(0);
  });

  it('keeps count-free atomic pruning on an update-only store', async () => {
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    const priorUal = mkUal('update-only-prior');
    const currentUal = mkUal('update-only-current');
    await base.insert([
      ...metaQuadsFor(AGENTS, agent, priorUal),
      ...metaQuadsFor(AGENTS, agent, currentUal),
    ]);

    const { store: counted, calls } = makeCountingStore(base);
    const updateOnly = new Proxy(counted, {
      get(target, property, receiver) {
        if (property === 'structuredMutation') return undefined;
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as OxigraphStore;

    await pruneSupersededAgentRegistryMeta({
      store: updateOnly,
      contextGraphId: AGENTS,
      metaGraph: metaOf(AGENTS),
      rootEntities: [agent],
      keepUal: currentUal,
    });

    expect(calls.structuredMutation).toBe(0);
    expect(calls.update).toBe(1);
    expect(calls.countQuads).toBe(0);
    expect(calls.deleteByPattern).toBe(0);
    expect(calls.deleteBySubjectPrefix).toBe(0);
    expect(
      await ask(base, `ASK { GRAPH <${metaOf(AGENTS)}> { <${priorUal}> ?p ?o } }`),
    ).toBe(false);
    expect(
      await ask(base, `ASK { GRAPH <${metaOf(AGENTS)}> { <${currentUal}> ?p ?o } }`),
    ).toBe(true);
  });

  it('declares the exact target graph and roots through the structured capability', async () => {
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    await base.insert(metaQuadsFor(AGENTS, agent, mkUal('prior')));
    const calls: Array<{ mutation: Parameters<NonNullable<OxigraphStore['structuredMutation']>>[0]; options?: { source?: string } }> = [];
    const capturing = new Proxy(base, {
      get(t, p, r) {
        if (p === 'structuredMutation') {
          return (mutation: Parameters<NonNullable<OxigraphStore['structuredMutation']>>[0], options?: { source?: string }) => {
            calls.push({ mutation, options });
            return base.structuredMutation(mutation);
          };
        }
        return Reflect.get(t, p, r);
      },
    }) as unknown as OxigraphStore;

    await pruneSupersededAgentRegistryMeta({
      store: capturing,
      contextGraphId: AGENTS,
      metaGraph: metaOf(AGENTS),
      rootEntities: [agent],
      keepUal: mkUal('prior'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      mutation: { kind: 'prune-linked-record-closures', input: {
        graphUri: metaOf(AGENTS),
        matchObjectIris: [agent],
        protectedRecordIri: mkUal('prior'),
      } },
      options: { source: 'agent-registry-meta.prune' },
    });
  });

  it('(B) evicts the WHOLE record for legacy/multi-root shape (member on <ual>/n with dkg:partOf)', async () => {
    // Legacy / multi-root shape: the member entity sits on the `<ual>/1` TOKEN
    // subject (carrying `dkg:partOf <ual>`), while the KC-level rows (status,
    // merkleRoot, …) sit on the parent `<ual>`. The prune must resolve the member
    // back to the record ROOT and delete BOTH — otherwise the parent rows leak
    // (PR #1526 #1). The buggy first version bound `?ual = <ual>/1` and deleted
    // only the token subtree, stranding the parent.
    const store = new OxigraphStore();
    const g = metaOf(AGENTS);
    const DKG = 'http://dkg.io/ontology/';
    const agentX = agentDid(0xbb);
    const ual = mkUal('legacy');
    const token = `${ual}/1`;

    await store.insert([
      { subject: token, predicate: `${DKG}entity`, object: agentX, graph: g },
      { subject: token, predicate: `${DKG}partOf`, object: ual, graph: g },
      { subject: ual, predicate: `${DKG}status`, object: '"tentative"', graph: g },
      { subject: ual, predicate: `${DKG}merkleRoot`, object: '"deadbeef"', graph: g },
    ]);
    expect(await store.countQuads(g)).toBe(4);

    await pruneSupersededAgentRegistryMeta({
      store,
      contextGraphId: AGENTS,
      metaGraph: g,
      rootEntities: [agentX],
      keepUal: mkUal('current'),
    });

    expect(
      await ask(store, `ASK { GRAPH <${g}> { <${token}> ?p ?o } }`),
      'the <ual>/n token rows are removed',
    ).toBe(false);
    expect(
      await ask(store, `ASK { GRAPH <${g}> { <${ual}> ?p ?o } }`),
      'the parent <ual> status/merkleRoot rows are removed (the legacy-shape leak fix)',
    ).toBe(false);
    expect(await store.countQuads(g), 'the whole legacy record is evicted, no leak').toBe(0);
  });

  it('(C) does NOT silently skip: warns loudly (no throw) when the store lacks server-side update()', async () => {
    // A store missing update() on the agents path is an invariant violation
    // (every real backend implements it). The prune must NOT throw (a defensive
    // bound must never break publishing) but MUST make the skip visible.
    const records: Array<{ level: string; module: string; message: string }> = [];
    Logger.setSink((r) => { records.push(r); });
    try {
      const noUpdateStore = {} as unknown as OxigraphStore; // no update() method
      await expect(
        pruneSupersededAgentRegistryMeta({
          store: noUpdateStore,
          contextGraphId: AGENTS,
          metaGraph: metaOf(AGENTS),
          rootEntities: [agentDid(0xa1)],
          keepUal: mkUal('x'),
        }),
      ).resolves.toBeUndefined(); // no throw, no-op
    } finally {
      Logger.setSink(null);
    }
    const warn = records.find((r) => r.level === 'warn' && /SKIPPED/.test(r.message));
    expect(warn, 'a loud warn was emitted about the skipped agents/_meta bound').toBeDefined();
    expect(warn?.module).toBe('AgentRegistryMetaRetention');
  });

  it('(1) insert-first: an insert failure preserves the prior record and propagates (no loss)', async () => {
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    await base.insert(metaQuadsFor(AGENTS, agent, mkUal('prior')));
    const priorCount = await base.countQuads(metaOf(AGENTS));
    expect(priorCount).toBeGreaterThan(0);

    // A store whose insert() throws — the prune must never be reached, so the
    // prior record can't be lost (the whole reason for insert-before-prune).
    const throwingStore = new Proxy(base, {
      get(t, p, r) {
        if (p === 'insert') return async () => { throw new Error('disk full'); };
        return Reflect.get(t, p, r);
      },
    }) as unknown as OxigraphStore;

    await expect(
      insertBoundedAgentRegistryMeta({
        store: throwingStore,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        recordUal: mkUal('new'),
        metadataQuads: metaQuadsFor(AGENTS, agent, mkUal('new')),
      }),
    ).rejects.toThrow(/disk full/);

    expect(
      await base.countQuads(metaOf(AGENTS)),
      'the prior record is untouched — the prune never ran (no state loss)',
    ).toBe(priorCount);
  });

  it('(1) insert-first: a prune failure after a successful insert is NON-FATAL (resolves + warns)', async () => {
    // The record is durably inserted BEFORE the prune, so a transient prune
    // failure must NOT reject — else the caller (PublishHandler) would abort its
    // ACK and never register pendingPublishes/expireTentativePublish, orphaning
    // the tentative publish (#1533). It must resolve + warn instead.
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    // insert() runs on the real base store (succeeds); the bounded prune throws,
    // so the prune fails AFTER a durable insert.
    const pruneFailsStore = new Proxy(base, {
      get(t, p, r) {
        if (p === 'structuredMutation') return async () => { throw new Error('prune boom'); };
        if (p === 'insert') return (quads: Quad[]) => base.insert(quads);
        return Reflect.get(t, p, r);
      },
    }) as unknown as OxigraphStore;

    const records: Array<{ level: string; module: string; message: string }> = [];
    Logger.setSink((rec) => { records.push(rec); });
    try {
      await expect(
        insertBoundedAgentRegistryMeta({
          store: pruneFailsStore,
          contextGraphId: AGENTS,
          metaGraph: metaOf(AGENTS),
          recordUal: mkUal('new'),
          metadataQuads: metaQuadsFor(AGENTS, agent, mkUal('new')),
        }),
      ).resolves.toBeUndefined(); // NON-FATAL: swallows the prune error, does not reject
    } finally {
      Logger.setSink(null);
    }

    // The just-inserted record is live (the insert ran on the real store).
    expect(
      await tentativeUals(base, AGENTS),
      'the record is durably inserted despite the prune failure',
    ).toEqual([mkUal('new')]);
    // …and the swallowed prune failure was made visible.
    const warn = records.find((r) => r.level === 'warn' && /bound skipped this round/i.test(r.message));
    expect(warn, 'a loud warn was emitted for the swallowed prune failure').toBeDefined();
    expect(warn?.module).toBe('AgentRegistryMetaRetention');
  });

  it('(1) insert-first happy path: after insert+prune only the newest record survives', async () => {
    const store = new OxigraphStore();
    const agent = agentDid(0xa1);
    await store.insert(metaQuadsFor(AGENTS, agent, mkUal('prior')));

    await insertBoundedAgentRegistryMeta({
      store,
      contextGraphId: AGENTS,
      metaGraph: metaOf(AGENTS),
      recordUal: mkUal('new'),
      metadataQuads: metaQuadsFor(AGENTS, agent, mkUal('new')),
    });

    expect(
      await tentativeUals(store, AGENTS),
      'the just-inserted record survives (protected by recordUal); the prior is pruned',
    ).toEqual([mkUal('new')]);
  });

  it('(1) non-agents CG: insertBounded just inserts (prune no-op), full history retained', async () => {
    const store = new OxigraphStore();
    const cg = 'user-cg';
    const root = 'did:dkg:entity:some-thing';
    for (let i = 0; i < 3; i++) {
      await insertBoundedAgentRegistryMeta({
        store,
        contextGraphId: cg,
        metaGraph: metaOf(cg),
        recordUal: mkUal(`u-${i}`),
        metadataQuads: metaQuadsFor(cg, root, mkUal(`u-${i}`)),
      });
    }
    expect(
      (await tentativeUals(store, cg)).length,
      'non-agents CG keeps every record (prune is a no-op)',
    ).toBe(3);
  });

  it('(A) serializes concurrent same-agent heartbeats — collapses to exactly the newest record', async () => {
    // Two concurrent heartbeats for the SAME agent (fresh UAL each). Without the
    // per-root mutex both insert, then each prunes the OTHER's record → the agent
    // ends with ZERO records. The store below defers every bounded prune past
    // the microtask queue via setTimeout(0), so BOTH inserts deterministically
    // land before EITHER prune's DELETE — the exact interleaving that zeroes the
    // graph unserialized. The mutex serialises insert+prune, so the 2nd call (B)
    // chains after the 1st (A), inserts its own record, then prunes A → exactly
    // ONE record survives and it is deterministically the newest (B): `call('A')`
    // is dispatched first, so it acquires the lock first and B prunes last.
    // Asserting the exact survivor (not merely ≥1) also catches a "serialized but
    // unbounded" regression that leaves both records live.
    const base = new OxigraphStore();
    const agent = agentDid(0xa1);
    const raceStore = new Proxy(base, {
      get(t, p, r) {
        if (p === 'insert') return (quads: Quad[]) => base.insert(quads);
        if (p === 'structuredMutation') return async (mutation: Parameters<NonNullable<OxigraphStore['structuredMutation']>>[0]) => {
          await new Promise((res) => setTimeout(res, 0)); // defer the prune past both inserts
          return base.structuredMutation(mutation);
        };
        return Reflect.get(t, p, r);
      },
    }) as unknown as OxigraphStore;

    const call = (ual: string) =>
      insertBoundedAgentRegistryMeta({
        store: raceStore,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        recordUal: ual,
        metadataQuads: metaQuadsFor(AGENTS, agent, ual),
      });

    await Promise.all([call(mkUal('A')), call(mkUal('B'))]);

    expect(
      await tentativeUals(base, AGENTS),
      'concurrent same-agent heartbeats collapse to exactly the newest record (B); ' +
        'this is [] without the mutex and [A,B] if serialized-but-unbounded',
    ).toEqual([mkUal('B')]);
  });

  it('(A2) serializes concurrent OVERLAPPING-root writes — a shared root is never zeroed (#1534)', async () => {
    // Two concurrent agents/_meta writes with INTERSECTING-but-unequal root sets:
    // {A} and {A,B}. A per-root-SET lock keys them differently ("A" vs "A,B"), so
    // both insert then mutually prune on shared root A → A ends with ZERO records
    // (the #1534 review bug). Per-INDIVIDUAL-root locking makes them share the
    // root-A lock and serialize: `call([A])` dispatches first → acquires lock A →
    // completes → then `call([A,B])` inserts and prunes → its {A,B} record survives
    // and still covers A. Deterministic: exactly the {A,B} UAL remains (it is `[]`
    // without per-root serialization).
    const base = new OxigraphStore();
    const agentA = agentDid(0xa1);
    const agentB = agentDid(0xb2);
    const raceStore = new Proxy(base, {
      get(t, p, r) {
        if (p === 'insert') return (quads: Quad[]) => base.insert(quads);
        if (p === 'structuredMutation') return async (mutation: Parameters<NonNullable<OxigraphStore['structuredMutation']>>[0]) => {
          await new Promise((res) => setTimeout(res, 0)); // defer the prune past both inserts
          return base.structuredMutation(mutation);
        };
        return Reflect.get(t, p, r);
      },
    }) as unknown as OxigraphStore;

    const call = (roots: string[], ual: string) =>
      insertBoundedAgentRegistryMeta({
        store: raceStore,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        recordUal: ual,
        metadataQuads: metaQuadsForRoots(AGENTS, roots, ual),
      });

    await Promise.all([call([agentA], mkUal('A')), call([agentA, agentB], mkUal('AB'))]);

    // The surviving {A,B} record carries a member row for agentA, so agentA is NOT
    // zeroed. (Without per-root locking this is `[]`.)
    expect(
      await tentativeUals(base, AGENTS),
      'overlapping-root writes serialize on the shared root; the newest ({A,B}) survives and still covers A',
    ).toEqual([mkUal('AB')]);
  });

  it('(C) throws when recordUal is not a subject of metadataQuads (drift guard)', async () => {
    const store = new OxigraphStore();
    const agent = agentDid(0xa1);
    // metadataQuads describe UAL "real", but we (wrongly) ask to protect "other".
    await expect(
      insertBoundedAgentRegistryMeta({
        store,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        recordUal: mkUal('other'),
        metadataQuads: metaQuadsFor(AGENTS, agent, mkUal('real')),
      }),
    ).rejects.toThrow(/recordUal .* is not a subject of metadataQuads/);

    // The mismatch is caught BEFORE any write — nothing was inserted.
    expect(await store.countQuads(metaOf(AGENTS))).toBe(0);
  });

  it('(C2) throws when the record encodes NO rootEntity rows (no lock/prune domain)', async () => {
    // recordUal IS a subject (status row) so the drift guard passes, but the record
    // has no `dkg:rootEntity` member row → an empty covered-root set. The helper must
    // FAIL LOUDLY (before any write) rather than silently take no locks + prune
    // nothing, which would opt out of the retention invariant it owns (#1534 review).
    const store = new OxigraphStore();
    const ual = mkUal('rootless');
    const rootlessQuads: Quad[] = [
      { subject: ual, predicate: STATUS, object: '"tentative"', graph: metaOf(AGENTS) },
      { subject: ual, predicate: 'http://dkg.io/ontology/merkleRoot', object: '"deadbeef"', graph: metaOf(AGENTS) },
    ];
    await expect(
      insertBoundedAgentRegistryMeta({
        store,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        recordUal: ual,
        metadataQuads: rootlessQuads,
      }),
    ).rejects.toThrow(/no .*rootEntity.* member rows|no lock\/prune domain/i);

    expect(await store.countQuads(metaOf(AGENTS)), 'nothing was written — caught before insert').toBe(0);
  });

  it('(2) warns (not a silent drop) on an unsafe root, and still prunes the safe ones', async () => {
    const store = new OxigraphStore();
    const agent = agentDid(0xa1);
    // A prior record for the SAFE agent that MUST still be pruned.
    await store.insert(metaQuadsFor(AGENTS, agent, mkUal('prior')));

    const records: Array<{ level: string; module: string; message: string }> = [];
    Logger.setSink((r) => { records.push(r); });
    try {
      await pruneSupersededAgentRegistryMeta({
        store,
        contextGraphId: AGENTS,
        metaGraph: metaOf(AGENTS),
        rootEntities: ['bad iri with <> spaces', agent],
        keepUal: mkUal('current'),
      });
    } finally {
      Logger.setSink(null);
    }

    const warn = records.find((r) => r.level === 'warn' && /unsafe root/i.test(r.message));
    expect(warn, 'a loud warn is emitted for the dropped unsafe root').toBeDefined();
    expect(warn?.message, 'the warn names the skipped root').toContain('bad iri with <> spaces');
    expect(warn?.module).toBe('AgentRegistryMetaRetention');
    expect(
      await store.countQuads(metaOf(AGENTS)),
      'the safe root is still pruned — the pass is not silently aborted',
    ).toBe(0);
  });

  it('(E) production path: PublishHandler.handler on an agents-CG publish does NOT reject when the prune fails, and still registers the tentative lifecycle', async () => {
    // Regression guard for the WIRING: the receive path must use
    // insertBoundedAgentRegistryMeta (insert-first + swallowed post-insert prune
    // failure). If it reverts to prune-before-insert or lets the prune error
    // propagate, the ACK rejects and pendingPublishes/expireTentativePublish never
    // register → the tentative publish is orphaned (#1533).
    const base = new OxigraphStore();
    // Every store method delegates to base EXCEPT the bounded prune, which throws,
    // so the prune fails AFTER a durable
    // insert while the rest of handlePublish runs normally.
    const pruneFailsStore = new Proxy(base, {
      get(t, p, r) {
        if (p === 'structuredMutation') return async () => { throw new Error('prune boom'); };
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(base) : v;
      },
    }) as unknown as OxigraphStore;
    const handler = new PublishHandler(pruneFailsStore, new TypedEventBus());

    const publisherAddress = '0x1111111111111111111111111111111111111111';
    const rootEntity = agentDid(0xa1);
    const ntriples = `<${rootEntity}> <http://schema.org/name> "AgentBot" .`;
    const ual = `did:dkg:mock:31337/${publisherAddress}/1`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(ntriples),
      contextGraphId: AGENTS,
      kas: [{ tokenId: 1, rootEntity, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress,
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const records: Array<{ level: string; message: string }> = [];
    Logger.setSink((rec) => { records.push({ level: rec.level, message: rec.message }); });
    // MUST NOT reject even though the agents/_meta prune (update) throws.
    const ackData = await (async () => {
      try {
        return await handler.handler(reqBytes, 'test-peer' as any);
      } finally {
        Logger.setSink(null);
      }
    })();

    const ack = decodePublishAck(ackData);
    expect(ack.accepted, 'the ACK is accepted despite the prune failure').toBe(true);
    expect(handler.hasPendingPublishes, 'the tentative-publish lifecycle was registered').toBe(true);
    expect(
      records.some((r) => r.level === 'warn' && /bound skipped this round/i.test(r.message)),
      'the swallowed prune failure was surfaced by the helper',
    ).toBe(true);
  });
});
