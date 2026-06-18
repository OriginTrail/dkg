import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  RDF_TYPE,
  linesFromNquads,
  lineGraphsFromNquads,
  registerTestSyncHandler,
  subGraphRegistrationQuads,
  workspaceOpQuads,
} from './_helpers/sync-responder.js';

/**
 * R-7 (page-build pushdown) + R-6 (admission ASK memo) regression tests.
 *
 * The HARD invariant for both: the responder's emitted row-set must be
 * BYTE-IDENTICAL to the pre-fix behaviour — the fixes only change HOW the rows
 * are computed (store-side filter / cached ASK), never WHICH rows are returned
 * or WHICH graphs are admitted. Any divergence is a sync-correctness break.
 */

const PUBLISHED = `${DKG_NS}publishedAt`;

function countAskShape(store: OxigraphStore, fragment: string): { count(): number } {
  const original = store.query.bind(store);
  let n = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('ASK') && normalized.includes(fragment)) n += 1;
    return original(sparql);
  }) as OxigraphStore['query'];
  return { count: () => n };
}

describe('R-7 swm-data root-filter pushdown — byte-invariance', () => {
  it('returns EXACTLY the root + genid-descendant rows, dropping unrelated subjects', async () => {
    const store = new OxigraphStore();
    const cgId = 'r7-swm-data';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const dataGraph = `${swmGraph}/0xabc/1`;
    const now = new Date().toISOString();

    const root = 'urn:root:kept';
    const genidChild = `${root}/.well-known/genid/0001`;
    const unrelated = 'urn:root:NOT-fresh';
    const genidLookalike = 'urn:root:keptX/.well-known/genid/0001'; // prefix is a different root

    const rows: Quad[] = [
      // fresh op => root admitted by cutoff
      ...workspaceOpQuads(cgId, 'op-1', root, swmMetaGraph, now),
      // data rows in the bucket
      { graph: dataGraph, subject: root, predicate: `${DKG_NS}label`, object: '"root-row"' },
      { graph: dataGraph, subject: genidChild, predicate: `${DKG_NS}label`, object: '"genid-row"' },
      { graph: dataGraph, subject: unrelated, predicate: `${DKG_NS}label`, object: '"unrelated-row"' },
      { graph: dataGraph, subject: genidLookalike, predicate: `${DKG_NS}label`, object: '"lookalike-row"' },
    ];
    await store.insert(rows);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 5000 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    const lines = linesFromNquads(out);
    // EXACTLY the root row + its genid descendant; NOT the unrelated subject and
    // NOT the look-alike (whose prefix belongs to a different, non-fresh root).
    expect(out).toContain('"root-row"');
    expect(out).toContain('"genid-row"');
    expect(out).not.toContain('"unrelated-row"');
    expect(out).not.toContain('"lookalike-row"');
    expect(lines).toHaveLength(2);
    expect(lineGraphsFromNquads(out)).toEqual(new Set([dataGraph]));
  });

  it('pushes a FILTER into the snapshot read but adds no ORDER BY / OFFSET / LIMIT', async () => {
    const store = new OxigraphStore();
    const cgId = 'r7-swm-data-shape';
    const swmGraph = `did:dkg:context-graph:${cgId}/_shared_memory`;
    const swmMetaGraph = `${swmGraph}_meta`;
    const dataGraph = `${swmGraph}/0xabc/1`;
    const now = new Date().toISOString();
    await store.insert([
      ...workspaceOpQuads(cgId, 'op-1', 'urn:root:a', swmMetaGraph, now),
      { graph: dataGraph, subject: 'urn:root:a', predicate: `${DKG_NS}label`, object: '"a"' },
    ]);

    const original = store.query.bind(store);
    let sawFilteredSnapshotRead = false;
    store.query = (async (sparql: string) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      const isSnapshotRead = /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
        normalized.includes(`VALUES ?g { <${dataGraph}>`) &&
        normalized.includes('GRAPH ?g { ?s ?p ?o }');
      if (isSnapshotRead) {
        sawFilteredSnapshotRead = true;
        // R-7: the root-filter is pushed in; the snapshot read stays unordered/unpaged.
        expect(normalized).toContain('FILTER');
        expect(normalized).toContain('STRSTARTS');
        expect(normalized).not.toContain('ORDER BY');
        expect(normalized).not.toContain('OFFSET ');
        expect(normalized).not.toContain('LIMIT ');
      }
      return original(sparql);
    }) as OxigraphStore['query'];

    await cap_invoke(store, cgId, dataGraph);
    expect(sawFilteredSnapshotRead).toBe(true);
  });
});

async function cap_invoke(store: OxigraphStore, cgId: string, _dataGraph: string) {
  const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 5000 });
  return cap.invoke({ contextGraphId: cgId, includeSharedMemory: true, phase: 'data', offset: 0, limit: 5000 });
}

describe('R-7 durable-meta de-quadratic assertion-name match — byte-invariance', () => {
  it('keeps trailing-segment assertion-name subjects and drops non-final-segment look-alikes', async () => {
    const store = new OxigraphStore();
    const cgId = 'r7-durable-meta';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const metaGraph = `${cgPrefix}/_meta`;
    const lifecycle = `${cgPrefix}/lifecycle/1`;
    const assertionName = 'myAssertion';
    const matchSubject = `${cgPrefix}/assertion/0xabc/${assertionName}`;          // trailing segment == name
    const nearMissSubject = `${cgPrefix}/assertion/0xabc/${assertionName}/extra`;  // name is NOT the final segment

    await store.insert([
      // a non-working lifecycle that names `myAssertion`
      { graph: metaGraph, subject: lifecycle, predicate: `${DKG_NS}memoryLayer`, object: '"VerifiedMemory"' },
      { graph: metaGraph, subject: lifecycle, predicate: `${DKG_NS}assertionName`, object: `"${assertionName}"` },
      // the two candidate assertion subjects
      { graph: metaGraph, subject: matchSubject, predicate: `${DKG_NS}label`, object: '"match"' },
      { graph: metaGraph, subject: nearMissSubject, predicate: `${DKG_NS}label`, object: '"near-miss"' },
    ]);

    const cap = registerTestSyncHandler(store, { syncPageSize: 5000 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 5000,
    });

    // trailing-segment match kept; non-final-segment look-alike dropped — exactly
    // the semantics of the old `subject.endsWith('/' + name)` predicate.
    expect(out).toContain('"match"');
    expect(out).not.toContain('"near-miss"');
  });
});

describe('R-6 isKnownContextGraph admission-ASK memo', () => {
  it('collapses redundant per-graph/per-segment ASKs to one per unique URI', async () => {
    const store = new OxigraphStore();
    const cgId = 'r6-admission';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    // Several data graphs sharing deep prefixes => the un-memoized walk would
    // re-ASK cg/a, cg/a/b, ... once per sibling graph.
    const graphs = [
      `${cgPrefix}/a/b/c/x`,
      `${cgPrefix}/a/b/c/y`,
      `${cgPrefix}/a/b/d/z`,
    ];
    const rows: Quad[] = [];
    for (const g of graphs) {
      rows.push({ graph: g, subject: `${g}#s`, predicate: `${DKG_NS}label`, object: `"row-${g}"` });
    }
    await store.insert(rows);

    const probe = countAskShape(store, 'registrationStatus');
    const cap = registerTestSyncHandler(store, { syncPageSize: 5000 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });

    // All graphs admitted (none are known child CGs), and the admission ASKs are
    // deduped: with N unique candidate URIs walked, the memo issues each ASK once.
    // The un-memoized code would issue strictly more (shared prefixes re-ASKed
    // per sibling). We assert the count equals the number of DISTINCT URIs walked.
    const uniqueWalked = new Set<string>();
    for (const g of graphs) {
      const rem = g.slice(cgPrefix.length + 1).split('/');
      uniqueWalked.add(g);
      let cur = cgPrefix;
      for (const seg of rem) { cur = `${cur}/${seg}`; uniqueWalked.add(cur); }
    }
    expect(probe.count()).toBe(uniqueWalked.size);
    // and the rows still come through (admitted set unchanged)
    expect(out).toContain(`"row-${graphs[0]}"`);
    expect(out).toContain(`"row-${graphs[2]}"`);
  });
});

describe('R-6 SWM-twin admission memo (readAdmittedSwmSubGraphNames)', () => {
  it('still admits unregistered sub-graphs after memoizing the isKnownContextGraph ASK', async () => {
    const store = new OxigraphStore();
    const cgId = 'r6-swm-twin';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const subName = 'team';
    const subSwm = `${cgPrefix}/${subName}/_shared_memory`;
    const subSwmMeta = `${subSwm}_meta`;
    const now = new Date().toISOString();
    await store.insert([
      ...subGraphRegistrationQuads(cgId, subName),
      ...workspaceOpQuads(cgId, 'op-1', 'urn:root:t', subSwmMeta, now),
      { graph: subSwm, subject: 'urn:root:t', predicate: `${DKG_NS}label`, object: '"sub-row"' },
    ]);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: 60_000, syncPageSize: 5000 });
    const out = await cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data',
      offset: 0,
      limit: 5000,
    });
    // the unregistered-as-child sub-graph's SWM is admitted + served
    expect(out).toContain('"sub-row"');
  });
});
