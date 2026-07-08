import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { SYSTEM_CONTEXT_GRAPHS, Logger } from '@origintrail-official/dkg-core';
import { generateTentativeMetadata, type KAMetadata } from '../src/index.js';
import { pruneSupersededAgentRegistryMeta } from '../src/agent-registry-meta-retention.js';

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
// via a single server-side `update()` — never via `countQuads`/`deleteByPattern`/
// `deleteBySubjectPrefix`, each of which brackets its work with full-graph COUNT
// scans on the production Blazegraph backend (the BLOCKER this rewrite fixes,
// invisible to a plain Oxigraph assertion). The OxigraphStore backing the proxy
// implements `update()`, so the real DELETE still runs.
const COUNTED = ['update', 'countQuads', 'deleteByPattern', 'deleteBySubjectPrefix', 'query', 'insert', 'delete'] as const;
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

  it('is count-free: prune reaches the store only via update(), never countQuads/deleteByPattern/deleteBySubjectPrefix', async () => {
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

    // The count-free contract: the single server-side UPDATE, and ZERO of the
    // full-graph-COUNT-bracketed delete/count helpers (the production BLOCKER).
    expect(calls.update, 'prune issues the single server-side UPDATE').toBeGreaterThanOrEqual(1);
    expect(calls.countQuads, 'no full-graph COUNT scans').toBe(0);
    expect(calls.deleteByPattern, 'no per-pattern delete (each does 2 COUNT scans on Blazegraph)').toBe(0);
    expect(calls.deleteBySubjectPrefix, 'no prefix delete (each does 2 COUNT scans on Blazegraph)').toBe(0);
    expect(calls.query, 'no separate SELECT round-trip — one UPDATE does it all').toBe(0);

    // …and the UPDATE actually evicted the superseded prior record.
    expect(await base.countQuads(metaOf(AGENTS)), 'the prior record was deleted by the UPDATE').toBe(0);
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
});
