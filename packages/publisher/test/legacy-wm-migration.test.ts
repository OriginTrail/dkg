/**
 * Legacy root-scoped Working Memory migration (issue #2149).
 *
 * A focused spec mirroring the production boundary in
 * `packages/publisher/src/legacy-wm-migration.ts`: the migration is its own
 * state machine, so its crash-window and refusal cases live in their own
 * file rather than deepening the catch-all draft-lifecycle spec. A change to
 * the durable marker vocabulary or a migration state should land here.
 *
 * These stay publisher-level integration tests against a real
 * `DKGPublisher` + `OxigraphStore`, exactly as they were in
 * `draft-lifecycle.test.ts` — only their home changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  MemoryLayer,
  ASSERTION_SEAL_PREDICATES,
  assertionLifecycleUri,
  LegacyKnowledgeAssetReadOnlyError,
} from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { createEVMAdapter, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const CG_ID = 'test-assertion-cg';
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';

describe('Legacy root-scoped WM migration', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  // ── Legacy-WM migration fixtures (#2149) ─────────────────────────────
  // The migration cases below are about MIGRATION STATES, so the URI and
  // marker-vocabulary construction lives here once. Changing the durable
  // marker vocabulary should touch these helpers, not every case.
  const LEGACY_MIGRATION_STATE_PRED = 'http://dkg.io/ontology/legacyWorkingMemoryMigrationState';

  /** The graph URIs one legacy-WM migration reads and writes. */
  const legacyMigrationUris = (name: string, agent = AGENT) => {
    const metaGraph = contextGraphMetaUri(CG_ID);
    return {
      metaGraph,
      lifecycle: assertionLifecycleUri(CG_ID, agent, name),
      sourceGraph: contextGraphAssertionUri(CG_ID, agent, name),
      backupGraph: `${metaGraph}/legacy-wm-backup/${encodeURIComponent(agent.toLowerCase())}`
        + `/${encodeURIComponent(name)}`,
    };
  };

  /** Stamp the durable restart marker a partially-applied migration leaves. */
  const stampMigrationMarker = async (
    name: string,
    state: 'prepared' | 'completed',
    extra: Array<{ predicate: string; object: string }> = [],
  ): Promise<void> => {
    const { sourceGraph, backupGraph } = legacyMigrationUris(name);
    await store.createGraph(backupGraph);
    await store.insert([
      { subject: sourceGraph, predicate: LEGACY_MIGRATION_STATE_PRED, object: `"${state}"`, graph: backupGraph },
      ...extra.map((row) => ({ subject: sourceGraph, ...row, graph: backupGraph })),
    ]);
  };

  /** Does the marker report the migration as finished? */
  const migrationMarkerCompleted = async (name: string): Promise<boolean> => {
    const { sourceGraph, backupGraph } = legacyMigrationUris(name);
    const result = await store.query(
      `ASK { GRAPH <${backupGraph}> { <${sourceGraph}> <${LEGACY_MIGRATION_STATE_PRED}> "completed" } }`,
    );
    return result.type === 'boolean' && result.value;
  };

  /** An allocator that mints one fixed KA number, recording each call. */
  const recordingAllocator = (number: bigint, agent = AGENT) => {
    const calls: number[] = [];
    return {
      calls,
      allocateKaNumber: async () => {
        calls.push(1);
        return { number, reservedUal: `did:dkg:31337/${agent.toLowerCase()}/${number}` };
      },
    };
  };

  const createPublisher = async (): Promise<DKGPublisher> => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    return new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  };

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = await createPublisher();
  });

  it('migrates a legacy local WM draft without deleting its public or private backup', async () => {
    const name = 'legacy-chat-turns';
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const sourceGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
    const targetGraph = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.WorkingMemory,
      AGENT,
      42n,
    );
    const publicQuads = [
      { subject: 'urn:test:chat:turn:1', predicate: 'http://schema.org/text', object: '"hello"' },
      { subject: 'urn:test:chat:turn:2', predicate: 'http://schema.org/text', object: '"reply"' },
    ];
    const privateQuads = [
      { subject: 'urn:test:chat:private:1', predicate: 'http://schema.org/text', object: '"secret"', graph: '' },
    ];

    // Build a valid draft first so its private partition uses the production
    // private-store key, then replace only the lifecycle metadata with the
    // legacy shape observed in #2149 (kaId=0, reservedUal ending in /1).
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, publicQuads);
    await publisher.assertionWritePrivate(CG_ID, name, AGENT, privateQuads);
    const lifecycleSubjects = await store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o . `
      + `FILTER(STR(?s) = "${lifecycle}" || STRSTARTS(STR(?s), "${lifecycle}/")) } }`,
    );
    if (lifecycleSubjects.type === 'bindings') {
      for (const row of lifecycleSubjects.bindings) {
        if (row['s']) await store.deleteByPattern({ graph: metaGraph, subject: row['s'] });
      }
    }
    const oldEvent = `${lifecycle}/event/legacy`;
    await store.insert([
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/contentScopeVersion',
        object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      },
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/kaId',
        object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      },
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/reservedUal',
        object: `"did:dkg:31337/${AGENT.toLowerCase()}/1"`,
        graph: metaGraph,
      },
      {
        subject: oldEvent,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/AssertionCreated',
        graph: metaGraph,
      },
    ]);

    const result = await publisher.migrateLegacyRootScopedWorkingMemory(
      CG_ID,
      name,
      AGENT,
      undefined,
      {
        allocateKaNumber: async () => ({
          number: 42n,
          reservedUal: `did:dkg:31337/${AGENT.toLowerCase()}/42`,
        }),
      },
    );

    expect(result).toMatchObject({
      status: 'migrated',
      copiedPublic: 2,
      preservedPrivate: 1,
      sourceGraph,
      targetGraph,
    });
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual(
      expect.arrayContaining(publicQuads.map((quad) => expect.objectContaining(quad))),
    );
    expect(await publisher.assertionQueryPrivate(CG_ID, name, AGENT)).toEqual(privateQuads);

    // The old name-keyed graph is deliberately retained as a data backup.
    const sourceRows = await store.query(
      `SELECT ?s WHERE { GRAPH <${sourceGraph}> { ?s ?p ?o } }`,
    );
    expect(sourceRows.type).toBe('bindings');
    if (sourceRows.type === 'bindings') expect(sourceRows.bindings).toHaveLength(2);
    const backupRows = await store.query(
      `ASK { GRAPH <${result.backupGraph}> { <${oldEvent}> ?p ?o } }`,
    );
    expect(backupRows.type === 'boolean' && backupRows.value).toBe(true);

    const identityRows = await store.query(
      `SELECT ?scope ?id ?ual WHERE { GRAPH <${metaGraph}> { <${lifecycle}> `
      + `<http://dkg.io/ontology/contentScopeVersion> ?scope ; `
      + `<http://dkg.io/ontology/kaId> ?id ; `
      + `<http://dkg.io/ontology/reservedUal> ?ual } }`,
    );
    expect(identityRows.type).toBe('bindings');
    if (identityRows.type === 'bindings') {
      expect(identityRows.bindings).toEqual([expect.objectContaining({
        scope: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
        id: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
        ual: `"did:dkg:31337/${AGENT.toLowerCase()}/42"`,
      })]);
    }

    // The normal graph-scoped write path works after migration, and a second
    // migration call is a no-op rather than duplicating or replacing content.
    await publisher.assertionWrite(CG_ID, name, AGENT, [{
      subject: 'urn:test:chat:turn:3',
      predicate: 'http://schema.org/text',
      object: '"again"',
    }]);
    const second = await publisher.migrateLegacyRootScopedWorkingMemory(
      CG_ID,
      name,
      AGENT,
    );
    expect(second.status).toBe('not-needed');
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toHaveLength(3);
  });

  it('resumes a prepared legacy WM migration after active metadata was removed', async () => {
    const name = 'legacy-chat-resume';
    const { sourceGraph, backupGraph } = legacyMigrationUris(name);
    await store.createGraph(sourceGraph);
    await stampMigrationMarker(name, 'prepared');
    await store.insert([
      {
        subject: 'urn:test:chat:resume',
        predicate: 'http://schema.org/text',
        object: '"recover me"',
        graph: sourceGraph,
      },
    ]);

    const result = await publisher.migrateLegacyRootScopedWorkingMemory(
      CG_ID,
      name,
      AGENT,
      undefined,
      {
        allocateKaNumber: async () => ({
          number: 43n,
          reservedUal: `did:dkg:31337/${AGENT.toLowerCase()}/43`,
        }),
      },
    );

    expect(result.status).toBe('resumed');
    expect(result.copiedPublic).toBe(1);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:chat:resume', object: '"recover me"' }),
    ]);
    expect(await migrationMarkerCompleted(name)).toBe(true);
  });

  it('refuses to migrate a legacy SWM lifecycle and leaves it untouched', async () => {
    const name = 'legacy-shared';
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const sourceGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
    await store.createGraph(sourceGraph);
    await store.insert([
      {
        subject: 'urn:test:shared',
        predicate: 'http://schema.org/text',
        object: '"must remain"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"shared"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"SWM"', graph: metaGraph },
      {
        subject: lifecycle,
        predicate: 'http://dkg.io/ontology/swmCurrentAssertion',
        object: 'urn:test:swm:snapshot',
        graph: metaGraph,
      },
    ]);

    await expect(
      publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT),
    ).rejects.toMatchObject({ code: 'KA_LEGACY_WM_MIGRATION_REFUSED' });
    const stillThere = await store.query(
      `ASK { GRAPH <${sourceGraph}> { <urn:test:shared> <http://schema.org/text> "must remain" } }`,
    );
    expect(stillThere.type === 'boolean' && stillThere.value).toBe(true);
    const state = await store.query(
      `SELECT ?state WHERE { GRAPH <${metaGraph}> { <${lifecycle}> <http://dkg.io/ontology/state> ?state } }`,
    );
    expect(state.type).toBe('bindings');
    if (state.type === 'bindings') expect(state.bindings[0]?.['state']).toBe('"shared"');
  });

  it(
    'with no identity lane the migration DECLINES and leaves the draft usable — '
    + 'throwing would brick chat memory on every node without a default agent',
    async () => {
    const name = 'legacy-without-allocator';
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const sourceGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
    await store.insert([
      {
        subject: 'urn:test:allocator-required',
        predicate: 'http://schema.org/text',
        object: '"must remain"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
    ]);

    // No allocator is passed and this publisher has no `kaAllocator`, which
    // is the shape of a node with no registered default agent: the author is
    // its libp2p peerId, which cannot own a graph-scoped KA number. There is
    // nothing to migrate TO, so declining is correct — and survivable, which
    // throwing was not: this runs ahead of `createAssertion` outside its
    // idempotent catch.
    const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);
    expect(result.status).toBe('not-needed');

    // Metadata untouched and the draft still holds its content...
    const unchanged = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${lifecycle}> `
      + '<http://dkg.io/ontology/state> "created" } }',
    );
    expect(unchanged.type === 'boolean' && unchanged.value).toBe(true);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:allocator-required', object: '"must remain"' }),
    ]);

    // ...and migration is no longer what fails. Such a node still cannot
    // WRITE this draft — a legacy root-scoped KA is read-only by design,
    // which is the whole premise of #2149 — but the error it gets is now
    // that accurate one rather than a migration-internal refusal, and the
    // migration no longer throws from ahead of `createAssertion`.
    await expect(
      publisher.assertionWrite(CG_ID, name, AGENT, [
        { subject: 'urn:test:still-legacy', predicate: 'http://schema.org/text', object: '"x"' },
      ]),
    ).rejects.toBeInstanceOf(LegacyKnowledgeAssetReadOnlyError);
  },
  );

  it('a completed marker with no active lifecycle is a no-op, not a refusal', async () => {
    // Regression: a successful migration leaves a `completed` marker behind
    // forever. If the active lifecycle is later cleared, the next chat-memory
    // initialization runs migration BEFORE create — misclassifying that as a
    // fresh legacy draft made it refuse, permanently blocking createAssertion.
    //
    // NOTE on how this state actually arises: `assertionDiscard` does NOT
    // produce it. Discard is predicate-scoped and leaves `contentScopeVersion`
    // in place, so a discarded migrated draft classifies as
    // already-graph-scoped. The real producer is a partial failure of a
    // non-atomic per-subject delete sweep (see the orphan-event case below).
    const name = 'legacy-completed-then-discarded';
    await stampMigrationMarker(name, 'completed', [{
      predicate: 'http://dkg.io/ontology/legacyWorkingMemoryMigrationCopiedPublic',
      object: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
    }]);

    const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);

    expect(result.status).toBe('not-needed');
    // The stale marker describes an assertion that no longer exists, so its
    // recorded counts must not be echoed back as if data were preserved.
    expect(result.copiedPublic).toBe(0);
    expect(result.targetGraph).toBeUndefined();

    // ...and the daemon's create-after-migrate path still works afterwards.
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:fresh', predicate: 'http://schema.org/text', object: '"new"' },
    ]);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:fresh' }),
    ]);
  });

  for (const markerState of ['completed', undefined] as const) {
    it(
      `orphan lifecycle event rows are not a legacy draft (marker: ${markerState ?? 'none'}) — `
      + 'migration must no-op so create can sweep them',
      async () => {
        // The lifecycle query intentionally spans the active subject AND its
        // `…/event/{id}` provenance children. Counting both made an orphan
        // event row read as "a draft exists", so the classifier fell through
        // to the eligibility gate, found no state/layer rows, and refused —
        // permanently, since the daemon runs migration ahead of create and
        // create is the only thing that sweeps those orphans away.
        //
        // Reachable via a partial failure of `assertionCreateUnlocked`'s
        // non-atomic per-subject stale-event sweep: the active subject is
        // deleted, then the process dies before its event children are.
        const name = `legacy-orphan-event-${markerState ?? 'none'}`;
        const { lifecycle, metaGraph } = legacyMigrationUris(name);
        await store.insert([
          // An orphan event child with NO rows on the active lifecycle subject.
          {
            subject: `${lifecycle}/event/orphaned`,
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://dkg.io/ontology/AssertionCreated',
            graph: metaGraph,
          },
        ]);
        if (markerState) await stampMigrationMarker(name, markerState);

        const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);
        expect(result.status).toBe('not-needed');

        // The daemon's create-after-migrate path stays open.
        await publisher.assertionCreate(CG_ID, name, AGENT);
        await publisher.assertionWrite(CG_ID, name, AGENT, [
          { subject: 'urn:test:after-orphan', predicate: 'http://schema.org/text', object: '"ok"' },
        ]);
        expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
          expect.objectContaining({ subject: 'urn:test:after-orphan' }),
        ]);
      },
    );
  }

  // The content gate is a data-integrity boundary distinct from the
  // eligibility gate: it stops unsafe legacy triples entering the
  // graph-scoped draft. The draft below is OTHERWISE eligible, so only the
  // content can be what rejects it.
  //
  // Only the reserved-namespace half is exercised end-to-end. The oversized
  // literal half of `validateMigratableContent` cannot be reached through
  // this harness: `OxigraphStore.insert` applies the same MUTF-8 limit, so an
  // oversized literal cannot be seeded into a legacy graph in the first
  // place. That guard remains as defense for stores written by an older,
  // looser version, and `assertQuadLiteralsMutf8Safe` is covered directly in
  // core.
  it('refuses to migrate legacy content carrying a reserved protocol-namespace subject', async () => {
    const name = 'legacy-content-reserved-subject';
    const { lifecycle, metaGraph, sourceGraph, backupGraph } = legacyMigrationUris(name);
    await store.insert([
      {
        subject: 'urn:dkg:file:keccak256:deadbeef',
        predicate: 'http://schema.org/text',
        object: '"smuggled"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
    ]);

    await expect(
      publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT, undefined, {
        allocateKaNumber: recordingAllocator(97n).allocateKaNumber,
      }),
    ).rejects.toThrow();

    // Rejected BEFORE any metadata rewrite: the legacy lifecycle is intact
    // and no `prepared` marker was stamped.
    const stateIntact = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${lifecycle}> <http://dkg.io/ontology/state> "created" } }`,
    );
    expect(stateIntact.type === 'boolean' && stateIntact.value).toBe(true);
    const markerStamped = await store.query(
      `ASK { GRAPH <${backupGraph}> { ?s <${LEGACY_MIGRATION_STATE_PRED}> ?o } }`,
    );
    expect(markerStamped.type === 'boolean' && markerStamped.value).toBe(false);
  });

  it(
    'orphan lifecycle rows with surviving source content: create is unblocked AND the '
    + 'legacy data is retained, not destroyed',
    async () => {
      // The trade this no-op makes. Migration cannot verify eligibility with
      // no active lifecycle rows, so it declines rather than migrating an
      // unprovable draft — but it must not let the subsequent create DESTROY
      // the old content. It does not: the legacy source graph is never
      // deleted, so the turns remain recoverable.
      const name = 'legacy-orphan-with-content';
      const { lifecycle, metaGraph, sourceGraph } = legacyMigrationUris(name);
      await store.insert([
        {
          subject: `${lifecycle}/event/orphaned`,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          object: 'http://dkg.io/ontology/AssertionCreated',
          graph: metaGraph,
        },
        {
          subject: 'urn:test:stranded-turn',
          predicate: 'http://schema.org/text',
          object: '"an old chat turn"',
          graph: sourceGraph,
        },
      ]);

      const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);
      expect(result.status).toBe('not-needed');

      // The daemon's create-after-migrate proceeds (the whole point of the
      // no-op) and mints a GRAPH-SCOPED draft. The allocator is essential:
      // without one the new draft's WM graph resolves back to the legacy
      // name-keyed graph, which would make the retention assertion below
      // trivially true for the wrong reason.
      await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
        allocateKaNumber: recordingAllocator(44n).allocateKaNumber,
      });
      await publisher.assertionWrite(CG_ID, name, AGENT, [
        { subject: 'urn:test:new-turn', predicate: 'http://schema.org/text', object: '"new"' },
      ]);

      // The new draft is genuinely a DIFFERENT graph: it reads back only the
      // new turn, not the stranded one.
      expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
        expect.objectContaining({ subject: 'urn:test:new-turn' }),
      ]);

      // The legacy content was NOT deleted by any of that — it is still
      // queryable in the source graph, which is the documented backup.
      const retained = await store.query(
        `ASK { GRAPH <${sourceGraph}> { <urn:test:stranded-turn> <http://schema.org/text> "an old chat turn" } }`,
      );
      expect(retained.type === 'boolean' && retained.value).toBe(true);
    },
  );

  it('a prepared marker resumes from the EARLIEST crash window, with legacy metadata still present', async () => {
    // The first durable `prepared` state: `prepareBackup` stamped the marker
    // and then the process died BEFORE `createGraphScopedDraft` cleared the
    // legacy active lifecycle rows. The rerun must take `resume-create` —
    // replace that legacy metadata, mint the identity, and copy the content.
    const name = 'legacy-resume-earliest';
    const { lifecycle, metaGraph, sourceGraph } = legacyMigrationUris(name);
    await store.insert([
      {
        subject: 'urn:test:earliest-resume',
        predicate: 'http://schema.org/text',
        object: '"must be preserved"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
    ]);
    await stampMigrationMarker(name, 'prepared');

    const allocator = recordingAllocator(66n);
    const result = await publisher.migrateLegacyRootScopedWorkingMemory(
      CG_ID,
      name,
      AGENT,
      undefined,
      { allocateKaNumber: allocator.allocateKaNumber },
    );

    expect(result.status).toBe('resumed');
    expect(result.copiedPublic).toBe(1);
    // A fresh identity WAS minted on this path (unlike resume-copy).
    expect(allocator.calls).toHaveLength(1);
    // Content reached the graph-scoped draft...
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:earliest-resume' }),
    ]);
    // ...the legacy root-scoped metadata was replaced...
    const legacyScope = await store.query(
      `SELECT ?v WHERE { GRAPH <${metaGraph}> { <${lifecycle}> `
      + '<http://dkg.io/ontology/contentScopeVersion> ?v } }',
    );
    expect(legacyScope.type).toBe('bindings');
    if (legacyScope.type === 'bindings') {
      expect(legacyScope.bindings[0]?.['v']).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
    }
    // ...and the marker completed.
    expect(await migrationMarkerCompleted(name)).toBe(true);
  });

  it('refuses to migrate unsafe PRIVATE legacy content, before touching metadata', async () => {
    // The private half of the content gate. The store rejects an oversized
    // literal at insert, so an unsafe private draft cannot be seeded through
    // the normal API — the read is stubbed instead, which is the only way to
    // reach this migration boundary. Without this, deleting the privateQuads
    // rejection would not redden a single test.
    const name = 'legacy-content-private-unsafe';
    const { lifecycle, metaGraph, backupGraph, sourceGraph } = legacyMigrationUris(name);
    await store.insert([
      {
        subject: 'urn:test:private-gate',
        predicate: 'http://schema.org/text',
        object: '"benign public"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
    ]);

    const privateStore = (publisher as any).privateStore;
    const original = privateStore.getKnowledgeAssetPrivateDraftTriples.bind(privateStore);
    privateStore.getKnowledgeAssetPrivateDraftTriples = async () => [{
      subject: 'urn:test:private-oversized',
      predicate: 'http://schema.org/text',
      object: `"${'x'.repeat(70_000)}"`,
      graph: '',
    }];
    try {
      await expect(
        publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT, undefined, {
          allocateKaNumber: recordingAllocator(96n).allocateKaNumber,
        }),
      ).rejects.toThrow();
    } finally {
      privateStore.getKnowledgeAssetPrivateDraftTriples = original;
    }

    // Rejected before any mutation: lifecycle intact, no marker stamped.
    const stateIntact = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${lifecycle}> <http://dkg.io/ontology/state> "created" } }`,
    );
    expect(stateIntact.type === 'boolean' && stateIntact.value).toBe(true);
    const markerStamped = await store.query(
      `ASK { GRAPH <${backupGraph}> { ?s <${LEGACY_MIGRATION_STATE_PRED}> ?o } }`,
    );
    expect(markerStamped.type === 'boolean' && markerStamped.value).toBe(false);
  });

  it(
    'a prepared migration whose draft was discarded mid-window declines the copy '
    + 'instead of throwing — the create that follows must not be blocked',
    async () => {
      // The terminal trap this guard exists to prevent. Crash inside the
      // prepared window leaves marker='prepared' + a graph-scoped draft.
      // `assertionDiscard` then removes the created/WM state but LEAVES
      // contentScopeVersion, so the draft still looks graph-scoped and the
      // run classifies as resume-copy — while the publisher will refuse the
      // outstanding write. Throwing here is unrecoverable: migration runs
      // ahead of createAssertion outside its idempotent catch, resume-copy
      // never re-mints, and only completeMarker clears the marker.
      const name = 'legacy-resume-discarded-target';
      const { sourceGraph } = legacyMigrationUris(name);
      await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
        allocateKaNumber: recordingAllocator(55n).allocateKaNumber,
      });
      // Legacy content still uncopied, so the copy branch is genuinely live.
      await store.insert([{
        subject: 'urn:test:uncopied-then-discarded',
        predicate: 'http://schema.org/text',
        object: '"still here"',
        graph: sourceGraph,
      }]);
      await stampMigrationMarker(name, 'prepared');
      await publisher.assertionDiscard(CG_ID, name, AGENT);

      const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);
      expect(result.status).toBe('not-needed');

      // The daemon's create-after-migrate is not blocked.
      await publisher.assertionCreate(CG_ID, name, AGENT);
      await publisher.assertionWrite(CG_ID, name, AGENT, [
        { subject: 'urn:test:after-discard', predicate: 'http://schema.org/text', object: '"ok"' },
      ]);
      expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
        expect.objectContaining({ subject: 'urn:test:after-discard' }),
      ]);

      // The uncopied legacy content is retained, not destroyed.
      const retained = await store.query(
        `ASK { GRAPH <${sourceGraph}> { <urn:test:uncopied-then-discarded> <http://schema.org/text> "still here" } }`,
      );
      expect(retained.type === 'boolean' && retained.value).toBe(true);
    },
  );

  it('a prepared marker resumes the CONTENT COPY when the draft exists but data was not copied', async () => {
    // The riskiest crash window: `prepareBackup` ran, `createGraphScopedDraft`
    // minted graph-scoped metadata, and the process died BEFORE
    // `writeGraphScopedDraft` copied the legacy source quads. This is the
    // data-preservation path — the rerun is the only thing that will ever
    // move that content — so it is asserted on an EMPTY target graph rather
    // than one already holding the data.
    const name = 'legacy-resume-pre-copy';
    const { sourceGraph } = legacyMigrationUris(name);

    // Graph-scoped metadata exists (the draft was already minted)...
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: recordingAllocator(88n).allocateKaNumber,
    });
    // ...but the legacy content is still sitting in the old name-keyed graph,
    // and the target WM graph is empty.
    await store.insert([{
      subject: 'urn:test:uncopied',
      predicate: 'http://schema.org/text',
      object: '"must be preserved"',
      graph: sourceGraph,
    }]);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([]);
    await stampMigrationMarker(name, 'prepared');

    // No allocator passed: once the identity exists, resuming must not need one.
    const result = await publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT);

    expect(result.status).toBe('resumed');
    expect(result.copiedPublic).toBe(1);
    // The legacy quad reached the graph-scoped draft.
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:uncopied', object: '"must be preserved"' }),
    ]);
    expect(await migrationMarkerCompleted(name)).toBe(true);
  });

  it('a prepared marker resumes idempotently after the graph-scoped draft already exists', async () => {
    // Crash-recovery coverage for the OTHER side of the prepared window: the
    // draft was already created and its content copied, but the process died
    // before `completeMarker`. The rerun must resume, not re-allocate a new
    // identity, and must not duplicate the copied content.
    const name = 'legacy-resume-post-apply';
    const publicQuads = [
      { subject: 'urn:test:resume:1', predicate: 'http://schema.org/text', object: '"copied"' },
    ];

    // Build a draft that is genuinely graph-scoped WITH a minted number, then
    // rewind ONLY the marker to `prepared` — exactly the durable state a
    // crash before completeMarker leaves behind (graph-scoped metadata
    // present, content already copied into the target WM graph).
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: recordingAllocator(77n).allocateKaNumber,
    });
    await publisher.assertionWrite(CG_ID, name, AGENT, publicQuads);
    await stampMigrationMarker(name, 'prepared');

    const resumeAllocator = recordingAllocator(77n);
    const result = await publisher.migrateLegacyRootScopedWorkingMemory(
      CG_ID,
      name,
      AGENT,
      undefined,
      { allocateKaNumber: resumeAllocator.allocateKaNumber },
    );

    expect(result.status).toBe('resumed');
    // Already graph-scoped, so no second identity may be minted.
    expect(resumeAllocator.calls).toHaveLength(0);
    // Content survives exactly once — the resume must not duplicate it.
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual(
      publicQuads.map((quad) => expect.objectContaining(quad)),
    );
    expect(await migrationMarkerCompleted(name)).toBe(true);
  });

  // The eligibility gate refuses a created/WM draft that is not purely local.
  // Each guard gets its own case so removing any one of them fails a test —
  // the SWM case above cannot exercise these, since it differs in state/layer.
  for (const [label, extraLifecycleQuad] of [
    ['an in-flight share operation', {
      predicate: 'http://dkg.io/ontology/shareOperationId',
      object: '"op-in-flight"',
    }],
    ['a durable promote intent', {
      predicate: 'http://dkg.io/ontology/promoteOperationIntent',
      object: '"{\\"version\\":1}"',
    }],
    ['an SWM layer pointer', {
      predicate: 'http://dkg.io/ontology/swmCurrentAssertion',
      object: 'urn:test:swm:snapshot',
    }],
    ['a VM layer pointer', {
      predicate: 'http://dkg.io/ontology/vmCurrentAssertion',
      object: 'urn:test:vm:snapshot',
    }],
  ] as const) {
    it(`refuses an otherwise-eligible created/WM draft carrying ${label}`, async () => {
      const name = `legacy-guard-${label.replace(/[^a-z]+/gi, '-')}`;
      const lifecycle = assertionLifecycleUri(CG_ID, AGENT, name);
      const metaGraph = contextGraphMetaUri(CG_ID);
      const sourceGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
      await store.insert([
        {
          subject: 'urn:test:guarded',
          predicate: 'http://schema.org/text',
          object: '"must remain"',
          graph: sourceGraph,
        },
        { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
        { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
        { subject: lifecycle, predicate: extraLifecycleQuad.predicate, object: extraLifecycleQuad.object, graph: metaGraph },
      ]);

      await expect(
        publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT, undefined, {
          allocateKaNumber: recordingAllocator(99n).allocateKaNumber,
        }),
      ).rejects.toMatchObject({ code: 'KA_LEGACY_WM_MIGRATION_REFUSED' });

      // Refused before any mutation: metadata and source data both intact.
      const stateIntact = await store.query(
        `ASK { GRAPH <${metaGraph}> { <${lifecycle}> <http://dkg.io/ontology/state> "created" } }`,
      );
      expect(stateIntact.type === 'boolean' && stateIntact.value).toBe(true);
      const dataIntact = await store.query(
        `ASK { GRAPH <${sourceGraph}> { <urn:test:guarded> <http://schema.org/text> "must remain" } }`,
      );
      expect(dataIntact.type === 'boolean' && dataIntact.value).toBe(true);
    });
  }

  it('refuses an otherwise-eligible created/WM draft whose source graph is sealed', async () => {
    const name = 'legacy-guard-sealed';
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const sourceGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
    await store.insert([
      {
        subject: 'urn:test:sealed',
        predicate: 'http://schema.org/text',
        object: '"must remain"',
        graph: sourceGraph,
      },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: metaGraph },
      { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: metaGraph },
      // The seal hangs off the SOURCE GRAPH subject, not the lifecycle URN.
      {
        subject: sourceGraph,
        predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
        object: '"deadbeef"^^<http://www.w3.org/2001/XMLSchema#hexBinary>',
        graph: metaGraph,
      },
    ]);

    await expect(
      publisher.migrateLegacyRootScopedWorkingMemory(CG_ID, name, AGENT, undefined, {
        allocateKaNumber: recordingAllocator(98n).allocateKaNumber,
      }),
    ).rejects.toMatchObject({ code: 'KA_LEGACY_WM_MIGRATION_REFUSED' });

    const dataIntact = await store.query(
      `ASK { GRAPH <${sourceGraph}> { <urn:test:sealed> <http://schema.org/text> "must remain" } }`,
    );
    expect(dataIntact.type === 'boolean' && dataIntact.value).toBe(true);
  });
});
