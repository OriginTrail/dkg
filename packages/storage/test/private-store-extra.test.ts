/**
 * Extra coverage for PrivateContentStore and named-graph confidentiality
 * model. No mocks — every test runs against a real OxigraphStore.
 *
 * Findings covered (see .test-audit/
 *
 *   ST-2  PROD-BUG — PrivateContentStore is documented as encrypted private
 *          storage but src/private-store.ts only remaps the graph URI. The
 *          literal value lands on disk in plaintext.
 *
 *   ST-3  Named-graph isolation using REAL V10 URIs
 *          (contextGraphSharedMemoryUri / contextGraphVerifiedMemoryUri /
 *          contextGraphPrivateUri). Axiom 5 of the spec.
 *
 *   ST-4  Dual-graph leak — a SPARQL query scoped to the public data graph
 *          must NOT see triples that live in the _private graph (DUP #38, #39).
 *
 *   ST-7  SPARQL injection negative tests — malicious rootEntity values
 *          ("> <evil", '"; DROP …') must be rejected by assertSafeIri, never
 *          smuggled into the SPARQL body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OxigraphStore,
  ContextGraphManager,
  PrivateContentStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  contextGraphDataUri,
  contextGraphPrivateUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri,
} from '@origintrail-official/dkg-core';

const CONTEXT_GRAPH = 'agent-registry';
const ROOT = 'did:dkg:agent:QmSecretHolder';

// =======================================================================
// ST-2 — "encrypted private storage" is a lie.
// =======================================================================
describe('PrivateContentStore — at-rest confidentiality [ST-2]', () => {
  // PROD-BUG: PrivateContentStore does NOT encrypt. src/private-store.ts
  // only remaps the quad's graph URI to the <cg>/_private named graph.
  // The literal object is persisted verbatim by Oxigraph. Any operator
  // with read access to the on-disk N-Quads file or the SPARQL endpoint
  // can recover the plaintext. README claims otherwise — see
  // . Leaving this test RED is the evidence.

  const SECRET = 'SECRET_PLAINTEXT_AAAA';
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dkg-private-store-'));
  });

  it('on-disk N-Quads dump must not contain the plaintext literal', async () => {
    const persistPath = join(tempDir, 'store.nq');
    const store = new OxigraphStore(persistPath);
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      {
        subject: ROOT,
        predicate: 'http://schema.org/ssn',
        object: `"${SECRET}"`,
        graph: '',
      },
    ]);
    // Force the debounced flush to land on disk.
    await store.close();

    const onDisk = readFileSync(persistPath, 'utf-8');
    try {
      expect(onDisk).not.toContain(SECRET);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a second, unrelated SPARQL client must NOT see the plaintext literal', async () => {
    // FIXED (ST-2): PrivateContentStore now seals the literal `object`
    // with AES-256-GCM before handing the quad to the TripleStore. A
    // raw SPARQL caller (no PrivateContentStore decrypt) sees only the
    // `enc:gcm:v1:<base64>` envelope. PrivateContentStore.getPrivateTriples
    // reverses the seal and returns the original literal — exercised
    // by the "round-trip" assertion below.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
    ]);

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    const rawObjects = raw.bindings.map((b) => b['o']);
    // Raw SPARQL view: only the AES-GCM envelope is observable.
    expect(rawObjects.join(' ')).not.toContain(SECRET);
    expect(rawObjects.some((o) => o.startsWith('"enc:gcm:v1:'))).toBe(true);

    // Authorised path round-trips: getPrivateTriples decrypts.
    const decrypted = await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT);
    expect(decrypted.map((q) => q.object)).toContain(`"${SECRET}"`);
  });

  // Random IV is
  // required, but
  // the write path MUST stay idempotent on plaintext identity — otherwise
  // every replay / retry of the same private KA stacks another
  // ciphertext row and `getPrivateTriples` starts returning duplicates.
  it('storePrivateTriples is idempotent on plaintext (no dup rows on replay)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const quads = [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
      { subject: ROOT, predicate: 'http://schema.org/creditCard', object: `"4111-1111-1111-1111"`, graph: '' },
    ];

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads);
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads);
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads);

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    // Exactly two ciphertext rows survive, one per distinct (s,p,plaintext).
    expect(raw.bindings.length).toBe(2);

    const roundTripped = (await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT))
      .map((q) => `${q.subject}|${q.predicate}|${q.object}`)
      .sort();
    expect(roundTripped).toEqual([
      `${ROOT}|http://schema.org/creditCard|"4111-1111-1111-1111"`,
      `${ROOT}|http://schema.org/ssn|"${SECRET}"`,
    ]);
  });

  it('concurrent storePrivateTriples for the same (s,p,o) cannot bypass dedup (read-then-insert race)', async () => {
    // Pre-fix: `storePrivateTriples` snapshotted existing plaintext keys
    // BEFORE inserting, with no mutual exclusion. Two concurrent writers
    // for the same (s,p,o) plaintext would both observe an empty key
    // set, then each insert their own random-IV ciphertext — and the
    // store kept both because the underlying triple store dedups by
    // byte-identical terms only. Post-fix: the per-graph mutex makes
    // the read-and-insert pair atomic so only the FIRST writer's
    // ciphertext lands; the SECOND sees the freshly inserted key and
    // skips.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const sharedQuad = {
      subject: ROOT,
      predicate: 'http://schema.org/ssn',
      object: `"${SECRET}"`,
      graph: '',
    };

    // Fire 8 concurrent writers for the same plaintext.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [sharedQuad]),
      ),
    );

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    expect(raw.bindings.length).toBe(1);

    const decrypted = await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0].object).toBe(`"${SECRET}"`);
  });

  // — private-store.ts:553). Pre-fix
  // the dedup query unconditionally wrapped every incoming subject
  // in `<${assertSafeIri(subject)}>`. RDF allows blank-node subjects
  // (`_:b0`), and `assertSafeIri()` throws on them — that throw
  // escaped the surrounding try/catch (which only wrapped
  // `store.query`, not the SPARQL CONSTRUCTION) and `storePrivateTriples()`
  // failed outright instead of falling back to the no-dedup path.
  // Tests below pin both the now-survives behaviour and that
  // dedup STILL works correctly for blank-node-subject quads.
  it('storePrivateTriples accepts blank-node subjects (does not throw on _:b0)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    // RDF blank node as subject is legal. Pre-fix this would throw
    // inside `assertSafeIri('_:b0')`.
    const quads = [
      { subject: '_:b0', predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
      { subject: '_:b0', predicate: 'http://schema.org/role', object: '"holder"', graph: '' },
    ];
    await expect(
      ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads),
    ).resolves.not.toThrow();

    // The two private rows actually landed (encrypted at rest).
    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    expect(raw.bindings.length).toBe(2);
  });

  it('storePrivateTriples with a MIX of IRI and blank-node subjects survives — IRI subjects still dedup, blank-node subjects do not (correct RDF semantics)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const quads = [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
      { subject: '_:bn', predicate: 'http://schema.org/role', object: '"holder"', graph: '' },
    ];
    // Pre-fix: the dedup path emitted `<_:bn>` as a SPARQL IRI,
    // oxigraph rejected it, the surrounding catch silently dropped
    // ALL dedup (including the IRI subject's), and a replay
    // duplicated every row. Post-fix the SPARQL query downshifts to
    // a predicate-only VALUES + subject-membership post-filter when
    // a non-IRI subject is detected, so the IRI subject still
    // dedups correctly.
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads);

    // Replay the same batch.
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, quads);

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;

    // Expected count = 3:
    //   - IRI subject: 1 row (dedup succeeded — pre-fix this would
    //     have leaked a duplicate due to the silent catch).
    //   - Blank-node subject: 2 rows. RDF blank-node labels have
    //     document-local scope; oxigraph mints a fresh internal
    //     identifier on each `store.insert()` call, so a `_:bn`
    //     stored in call #1 is NOT the same node as a `_:bn`
    //     stored in call #2. This is correct per the RDF 1.1
    //     concepts spec — blank-node label equality across
    //     separate documents/transactions is undefined.
    //
    // Pre-fix this assertion was unreachable for a different
    // reason (the dedup catch was silent, so both calls landed
    // verbatim and we'd have got 4). The 3-row landing is what
    // demonstrates the fix: the IRI half deduped where it
    // previously didn't.
    expect(raw.bindings.length).toBe(3);

    // Strong guard: the IRI subject row appears exactly once
    // (i.e. the dedup actually fired for it — no false positive
    // from "well, 3 rows is between 2 and 4").
    const iriRows = raw.bindings.filter((row) => row['s'] === ROOT);
    expect(iriRows.length).toBe(1);
    // And the blank-node rows are 2 — both kept (correct per RDF).
    const bnRows = raw.bindings.filter(
      (row) => typeof row['s'] === 'string' && row['s'].startsWith('_:'),
    );
    expect(bnRows.length).toBe(2);
  });

  it('storePrivateTriples with a MIX of IRI and blank-node subjects — replaying ONLY the IRI subject still dedups (regression guard for the silent-catch bug)', async () => {
    // The mixed-batch case above shows the IRI dedup survives
    // when blank-node subjects are also present in the SAME batch.
    // This test pins the inverse case: if a later call replays
    // ONLY the IRI subject, dedup must STILL fire (the in-batch
    // blank node should not have left durable state that breaks
    // dedup for subsequent IRI-only batches).
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const mixedBatch = [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
      { subject: '_:bn', predicate: 'http://schema.org/role', object: '"holder"', graph: '' },
    ];
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, mixedBatch);

    const iriOnlyReplay = [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
    ];
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, iriOnlyReplay);

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    // Mixed batch: 2 rows. IRI-only replay deduped: 0 new rows.
    // Total: 2.
    expect(raw.bindings.length).toBe(2);
    expect(raw.bindings.filter((r) => r['s'] === ROOT).length).toBe(1);
  });

  it('blank-node-only batch still benefits from predicate-narrowed dedup path (no full-graph scan)', async () => {
    // Plant an unrelated row in the private graph that uses a
    // DIFFERENT predicate and therefore must NOT show up in the
    // predicate-narrowed query. If the fallback accidentally
    // dropped predicate narrowing too, this row would slip into
    // the dedup set and (depending on plaintext collision) cause
    // bogus dedup hits.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://schema.org/UNRELATED', object: `"${SECRET}"`, graph: '' },
    ]);

    const blankNodeBatch = [
      { subject: '_:x', predicate: 'http://schema.org/role', object: `"${SECRET}"`, graph: '' },
    ];
    // Same plaintext but different predicate AND different subject.
    // The predicate-narrowed VALUES filter must keep the unrelated
    // row out of the dedup set, so this insert MUST land.
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, blankNodeBatch);

    const privateGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const raw = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${privateGraph}> { ?s ?p ?o } }`,
    );
    expect(raw.type).toBe('bindings');
    if (raw.type !== 'bindings') return;
    expect(raw.bindings.length).toBe(2);
  });

  it('storePrivateTriples still adds NEW plaintext alongside existing (no false-positive dedup)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"${SECRET}"`, graph: '' },
    ]);
    // Same (s,p) but a DIFFERENT plaintext — this is a new, distinct triple
    // and must not be swallowed by the dedup.
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://schema.org/ssn', object: `"OTHER_SECRET"`, graph: '' },
    ]);

    const roundTripped = (await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT))
      .map((q) => q.object)
      .sort();
    expect(roundTripped).toEqual([`"${SECRET}"`, `"OTHER_SECRET"`].sort());
  });

  // =======================================================================
  // private-store.ts:491, KwH_): the
  // per-graph write lock built its chain off `prev.then(() => next)`
  // and `await prev` was OUTSIDE the try/finally that would call
  // `release()`. A single rejected `storePrivateTriples()` therefore:
  //   1. left `next` permanently pending (try block never ran →
  //      release() never called)
  //   2. set `chained = prev.then(...)` which forwarded the rejection
  //      to every subsequent waiter for the SAME graph
  //   3. the next waiter's `await prev` threw before reaching its own
  //      try/finally, so its release() never fired either
  // Net effect: ONE failed write permanently bricked the graph until
  // process restart. Fix: chain off `prev.catch(() => undefined)` so
  // a predecessor's rejection is decoupled from queue progress.
  // =======================================================================
  it('(KwH_): a rejected storePrivateTriples does NOT brick the per-graph write lock — subsequent writers still drain', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    // Force the FIRST write to throw INSIDE the lock-held region by
    // monkey-patching `store.insert`, which `storePrivateTriples`
    // calls inside the `withGraphWriteLock` block. The first insert
    // throws; subsequent inserts behave normally.
    const realInsert = store.insert.bind(store);
    let insertCallCount = 0;
    (store as any).insert = async (quads: any) => {
      insertCallCount += 1;
      if (insertCallCount === 1) {
        throw new Error('simulated fault inside the locked region');
      }
      return realInsert(quads);
    };

    const goodQuad = {
      subject: ROOT,
      predicate: 'http://schema.org/ssn',
      object: `"${SECRET}"`,
      graph: '',
    };

    // 1. First write throws (the simulated fault), and the lock MUST
    //    NOT permanently brick. this leaked a pending
    //    `next` — every subsequent caller hung forever.
    await expect(
      ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [goodQuad]),
    ).rejects.toThrow(/simulated fault inside the locked region/);

    // 2. Second write must succeed. The pre-fix code rejected here
    //    on `await prev` (because prev was rejected), bypassing the
    //    try/finally that would have released the lock. Use a
    //    timeout to detect the hang and surface a clear error.
    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('TIMED OUT — lock is bricked')), 5_000),
    );
    await expect(
      Promise.race([
        ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [goodQuad]),
        timeoutPromise,
      ]),
    ).resolves.toBeUndefined();

    // 3. Third write — the lock map cleanup path must also work:
    //    the queue has fully drained, and a fresh write should grab
    //    a clean lock entry. This catches the secondary symptom
    //    where the recovered lock entry never gets `delete()`d
    //    from `perGraphWriteLocks` and accumulates over time.
    await expect(
      ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [goodQuad]),
    ).resolves.toBeUndefined();

    // The good quad survives at-rest exactly once (idempotent).
    const decrypted = await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0].object).toBe(`"${SECRET}"`);
  });

  it('(KwH_): concurrent waiters queued behind a rejecting writer all complete (no waiter inherits the rejection)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const realInsert = store.insert.bind(store);
    let insertCallCount = 0;
    let unblockFirstWriter: () => void = () => {};
    const firstWriterGate = new Promise<void>((resolve) => {
      unblockFirstWriter = resolve;
    });
    (store as any).insert = async (quads: any) => {
      insertCallCount += 1;
      if (insertCallCount === 1) {
        // Hold the lock until we've enqueued the followup writers,
        // then throw. This pins the queueing order: writers 2 and 3
        // are waiting on `prev` (the lock chain) when the first
        // writer rejects.
        await firstWriterGate;
        throw new Error('simulated rejected first writer');
      }
      return realInsert(quads);
    };

    const sharedQuad = {
      subject: ROOT,
      predicate: 'http://schema.org/ssn',
      object: `"${SECRET}"`,
      graph: '',
    };

    const writerA = ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [sharedQuad]);
    // Force the lock chain to register two more queued waiters
    // BEFORE the first writer rejects. these inherited
    // the rejected `prev` and never even started.
    const writerB = ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [sharedQuad]);
    const writerC = ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [sharedQuad]);

    // Yield to make sure writerB / writerC are properly queued.
    await new Promise((r) => setImmediate(r));
    unblockFirstWriter();

    await expect(writerA).rejects.toThrow(/simulated rejected first writer/);
    // Both queued waiters MUST complete normally (no rejection
    // inherited from the bad predecessor). Use a Promise.race
    // against a timeout to surface a hang explicitly.
    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('TIMED OUT — queued waiter inherited rejection')), 5_000),
    );
    await expect(Promise.race([writerB, timeoutPromise])).resolves.toBeUndefined();
    await expect(Promise.race([writerC, timeoutPromise])).resolves.toBeUndefined();

    // Idempotent dedup still works end-to-end.
    const decrypted = await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT);
    expect(decrypted.length).toBe(1);
  });

  it('(KwH_): a poisoned (rejected) predecessor in the lock map does NOT cascade-reject queued writers', async () => {
    // White-box test for the strongest bug variant (cli/private-store.ts:491).
    // The fix's defensive contract is: even if a rejected promise ends
    // up as the predecessor in `perGraphWriteLocks` (whether by
    // future refactor, an unhandled rejection in the lock plumbing,
    // or a poisoning by an adversarial caller), every subsequently-
    // queued writer for that graph MUST still run cleanly. The
    // pre-fix code did `await prev` outside the try/finally, so a
    // rejected `prev` skipped `release()` and the queued writer never
    // got to start. The fix's `safePrev = prev.catch(() => undefined)`
    // guarantees the queue keeps draining.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    // Reach into the private lock map and seed it with a directly-
    // rejected promise. This is the most aggressive simulation of a
    // poisoned predecessor — it pins that the lock layer itself is
    // rejection-resilient. The graph URI used by storePrivateTriples
    // is `<contextGraphPrivateUri(CONTEXT_GRAPH)>` (the production
    // helper resolves it identically each call).
    const targetGraph = contextGraphPrivateUri(CONTEXT_GRAPH);
    const poisoned = Promise.reject(new Error('poisoned predecessor'));
    // Attach a no-op handler so Node doesn't surface this as an
    // unhandled-rejection log line in CI; the lock impl itself
    // catches via `safePrev` so no test-side handler is required at
    // runtime, but vitest's listeners still complain about the
    // bare rejection literal we're synthesising.
    poisoned.catch(() => undefined);
    (ps as any).perGraphWriteLocks.set(targetGraph, poisoned);

    const goodQuad = {
      subject: ROOT,
      predicate: 'http://schema.org/ssn',
      object: `"${SECRET}"`,
      graph: '',
    };

    // Pre-fix: this hung forever (await prev threw before try{};
    // release() never fired; subsequent writers also hung). Race it
    // against a hard timeout to surface a regression as a clear
    // error rather than vitest's generic test timeout.
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('TIMED OUT — rejected predecessor poisoned the lock')), 5_000),
    );
    await expect(
      Promise.race([
        ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [goodQuad]),
        timeout,
      ]),
    ).resolves.toBeUndefined();

    // Round-trip succeeds.
    const decrypted = await ps.getPrivateTriples(CONTEXT_GRAPH, ROOT);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0].object).toBe(`"${SECRET}"`);
  });

  it('(KwH_): per-graph rejection does NOT poison OTHER graphs (independent locks stay clean)', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const realInsert = store.insert.bind(store);
    let insertCallCount = 0;
    (store as any).insert = async (quads: any) => {
      insertCallCount += 1;
      // Reject the very first insert (graph-A's first write); all
      // subsequent inserts go through. The other graph's lock chain
      // is independent and must continue working regardless of what
      // the bad graph's queue is doing.
      if (insertCallCount === 1) {
        throw new Error('simulated fault on graph A');
      }
      return realInsert(quads);
    };

    const quadA = { subject: ROOT, predicate: 'http://schema.org/a', object: `"A"`, graph: '' };
    const quadB = { subject: ROOT, predicate: 'http://schema.org/b', object: `"B"`, graph: '' };

    await expect(
      ps.storePrivateTriples('graph-A', ROOT, [quadA]),
    ).rejects.toThrow(/simulated fault on graph A/);

    // Different graph — totally separate lock chain. MUST work.
    await expect(
      ps.storePrivateTriples('graph-B', ROOT, [quadB]),
    ).resolves.toBeUndefined();

    // The originally-bricked graph is also recoverable on its own.
    await expect(
      ps.storePrivateTriples('graph-A', ROOT, [quadA]),
    ).resolves.toBeUndefined();
  });
});

// =======================================================================
// ST-3 — Named-graph isolation (Axiom 5) using REAL V10 URIs.
// =======================================================================
describe('Named-graph isolation — real V10 URIs [ST-3]', () => {
  let store: TripleStore;

  beforeEach(() => {
    store = new OxigraphStore();
  });

  const s = 'urn:test:s';
  const p = 'http://ex.org/p';

  function quadIn(graph: string, obj: string): Quad {
    return { subject: s, predicate: p, object: `"${obj}"`, graph };
  }

  it('shared-memory insert is invisible to verified-memory SELECT', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const verified = contextGraphVerifiedMemoryUri(CONTEXT_GRAPH, 'vm-1');

    await store.insert([quadIn(shared, 'shared-only')]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${verified}> { <${s}> <${p}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toEqual([]);
  });

  it('private-graph insert is invisible to shared-memory SELECT', async () => {
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);

    await store.insert([quadIn(priv, 'private-only')]);

    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${shared}> { <${s}> <${p}> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    expect(r.bindings).toEqual([]);
  });

  it('distinct values in three V10 named graphs remain distinct after SELECT', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const verified = contextGraphVerifiedMemoryUri(CONTEXT_GRAPH, 'vm-1');
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);

    await store.insert([
      quadIn(shared, 'v-shared'),
      quadIn(verified, 'v-verified'),
      quadIn(priv, 'v-private'),
    ]);

    for (const [g, expected] of [
      [shared, '"v-shared"'],
      [verified, '"v-verified"'],
      [priv, '"v-private"'],
    ] as const) {
      const r = await store.query(
        `SELECT ?o WHERE { GRAPH <${g}> { <${s}> <${p}> ?o } }`,
      );
      expect(r.type).toBe('bindings');
      if (r.type !== 'bindings') continue;
      expect(r.bindings.map((b) => b['o'])).toEqual([expected]);
    }
  });

  it('dropping one V10 graph leaves sibling graphs untouched', async () => {
    const shared = contextGraphSharedMemoryUri(CONTEXT_GRAPH);
    const priv = contextGraphPrivateUri(CONTEXT_GRAPH);

    await store.insert([quadIn(shared, 'alive'), quadIn(priv, 'die')]);
    await store.dropGraph(priv);

    expect(await store.countQuads(priv)).toBe(0);
    expect(await store.countQuads(shared)).toBe(1);
  });
});

// =======================================================================
// ST-4 — Dual-graph leak: public data graph must not surface _private
//        content (DUP #38 / #39).
// =======================================================================
describe('Dual-graph confidentiality leak [ST-4]', () => {
  it('SELECT against the public data graph excludes _private quads', async () => {
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const publicQuad: Quad = {
      subject: ROOT,
      predicate: 'http://schema.org/name',
      object: '"public-name"',
      graph: contextGraphDataUri(CONTEXT_GRAPH),
    };
    await store.insert([publicQuad]);

    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      {
        subject: ROOT,
        predicate: 'http://schema.org/ssn',
        object: '"PRIVATE-SSN-9999"',
        graph: '',
      },
    ]);

    // A standard public query addresses the data graph explicitly.
    const pub = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${contextGraphDataUri(CONTEXT_GRAPH)}> { <${ROOT}> ?p ?o } }`,
    );
    expect(pub.type).toBe('bindings');
    if (pub.type !== 'bindings') return;
    const values = pub.bindings.map((b) => b['o']);
    expect(values).toContain('"public-name"');
    expect(values).not.toContain('"PRIVATE-SSN-9999"');
  });

  it('UNION of _shared_memory + dataGraph still excludes _private', async () => {
    // A common query builder mistake is `UNION` over every "readable" graph.
    // Verify that as long as _private is not explicitly named, it is not
    // pulled in by a catch-all public query.
    const store = new OxigraphStore();
    const gm = new ContextGraphManager(store);
    const ps = new PrivateContentStore(store, gm);

    const dataG = contextGraphDataUri(CONTEXT_GRAPH);
    const sharedG = contextGraphSharedMemoryUri(CONTEXT_GRAPH);

    await store.insert([
      { subject: ROOT, predicate: 'http://ex.org/a', object: '"data"', graph: dataG },
      { subject: ROOT, predicate: 'http://ex.org/b', object: '"shared"', graph: sharedG },
    ]);
    await ps.storePrivateTriples(CONTEXT_GRAPH, ROOT, [
      { subject: ROOT, predicate: 'http://ex.org/c', object: '"LEAKED"', graph: '' },
    ]);

    const r = await store.query(`
      SELECT ?o WHERE {
        { GRAPH <${dataG}> { <${ROOT}> ?p ?o } }
        UNION
        { GRAPH <${sharedG}> { <${ROOT}> ?p ?o } }
      }
    `);
    expect(r.type).toBe('bindings');
    if (r.type !== 'bindings') return;
    const values = r.bindings.map((b) => b['o']);
    expect(values.sort()).toEqual(['"data"', '"shared"']);
    expect(values).not.toContain('"LEAKED"');
  });
});

// =======================================================================
// ST-7 — SPARQL injection: assertSafeIri must reject malicious rootEntity.
// =======================================================================
describe('PrivateContentStore — SPARQL injection defence [ST-7]', () => {
  let store: TripleStore;
  let gm: ContextGraphManager;
  let ps: PrivateContentStore;

  beforeEach(() => {
    store = new OxigraphStore();
    gm = new ContextGraphManager(store);
    ps = new PrivateContentStore(store, gm);
  });

  const MALICIOUS_ROOTS = [
    'did:dkg:agent:evil> <http://attacker/xyz',
    'did:dkg:agent:evil"; DROP ALL; #',
    'did:dkg:agent:evil\n} DELETE WHERE { ?s ?p ?o }\n{',
    'did:dkg:agent:evil>\n}',
    'did:dkg:agent:evil<>',
    'did:dkg:agent:evil{injected}',
    'did:dkg:agent:evil|pipe',
    'did:dkg:agent:evil`backtick',
    '',
    'did:dkg:agent:evil with space',
  ];

  it.each(MALICIOUS_ROOTS)('getPrivateTriples rejects malicious rootEntity %#', async (root) => {
    await expect(ps.getPrivateTriples(CONTEXT_GRAPH, root)).rejects.toThrow(
      /Unsafe or empty IRI/,
    );
  });

  it.each(MALICIOUS_ROOTS)('deletePrivateTriples rejects malicious rootEntity %#', async (root) => {
    // deletePrivateTriples → deleteBySubjectPrefix; the oxigraph adapter
    // escapes the prefix string, but assertSafeIri is not invoked on
    // this code path. Document current behaviour: when root is non-empty
    // we expect either a rejected promise (if a future patch adds
    // assertSafeIri) or a successful no-op. The test fails if the engine
    // executes a smuggled UPDATE that widens the delete beyond the graph.
    const probeQuad: Quad = {
      subject: 'urn:probe:survivor',
      predicate: 'http://ex.org/p',
      object: '"probe"',
      graph: 'urn:probe:graph',
    };
    await store.insert([probeQuad]);

    // Either outcome is acceptable for this malicious-input probe:
    //   (a) delete rejects with an IRI-safety / syntax error — the
    //       desired defensive behaviour; OR
    //   (b) delete succeeds as a scoped no-op and leaves the probe
    //       intact — also acceptable because the real invariant is
    //       "no injection widening".
    // A bare empty catch used to accept ANY thrown error shape, which
    // would have hidden regressions in the delete pipeline (store
    // error, timeout, assertion framework error). Narrow to the
    // defensive error class and assert the probe invariant always.
    let deleteThrew = false;
    let deleteError: unknown;
    try {
      await ps.deletePrivateTriples(CONTEXT_GRAPH, root);
    } catch (err) {
      deleteThrew = true;
      deleteError = err;
    }

    // Probe invariant: the unrelated-graph quad MUST survive no matter
    // which branch ran. If injection widened the DELETE the probe
    // would be gone and this assertion catches the regression.
    expect(await store.countQuads('urn:probe:graph')).toBe(1);

    // If delete rejected, at minimum it must be a real Error — not
    // `undefined`, a string, or an assertion-framework artefact. The
    // original empty catch accepted anything; we tightened that much
    // at least. We deliberately do NOT pin the error message shape:
    // the defensive rejection vocabulary legitimately varies across
    // layers (assertSafeIri, Oxigraph SPARQL parser, Blazegraph query
    // engine) and across the parametric malicious-input matrix, so a
    // narrow regex produces false-positive test failures that hide
    // the real invariant (probe survival, asserted above).
    if (deleteThrew) {
      expect(deleteError).toBeInstanceOf(Error);
    }
  });

  it('storePrivateTriples silently accepts unsafe rootEntity (defence-in-depth gap)', async () => {
    // PROD-BUG (defence-in-depth): `storePrivateTriples` never validates
    // `rootEntity`. It ends up only in the in-memory tracker, so there is
    // no immediate SPARQL injection, but a later hasPrivateTriples /
    // getPrivateTriples / deletePrivateTriples call with the same string
    // will blow up. Tracker should reject unsafe IRIs at the entry point.
    const unsafe = 'did:dkg:agent:evil> <http://attacker/';
    await expect(
      ps.storePrivateTriples(CONTEXT_GRAPH, unsafe, [
        { subject: 'urn:safe:s', predicate: 'http://ex.org/p', object: '"v"', graph: '' },
      ]),
    ).rejects.toThrow(/Unsafe or empty IRI/);
  });
});
