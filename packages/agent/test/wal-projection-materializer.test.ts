import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  WAL_PROJECTION_MARKER_GRAPH,
  buildWalProjectionCommitPlanV1,
  readWalProjectionMarkerV1,
  walProjectionShadowGraphV1,
  type Quad,
  type TripleStore,
  type WalProjectionCommitInputV1,
} from '@origintrail-official/dkg-storage';
import {
  PackedWalObjectStore,
  WalControlStore,
  type RetryQueueEntry,
} from '@origintrail-official/dkg-wal';
import {
  DkgWalProjectionMaterializerError,
  DkgWalProjectionMaterializerV1,
  type DkgWalSemanticProjectionOutcomeV1,
  type LocalWalProjectionRebuildSourceV1,
  type WalProjectionScopeV1,
} from '../src/wal/projection-materializer.js';

function bytes(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-materializer-test-v1\0${label}`).digest());
}

function scope(label = 'default'): WalProjectionScopeV1 {
  return {
    namespaceId: bytes(`${label}-namespace`),
    logicalKey: bytes(`${label}-logical-key`),
  };
}

function projection(
  value: WalProjectionScopeV1,
  label: string,
  overrides: Partial<DkgWalSemanticProjectionOutcomeV1['commit']> = {},
): DkgWalSemanticProjectionOutcomeV1 {
  const graph = walProjectionShadowGraphV1(value.namespaceId, value.logicalKey, 'content');
  const quad: Quad = {
    subject: `urn:test:${label}`,
    predicate: 'urn:test:value',
    object: `"${label}"`,
    graph,
  };
  return {
    commit: {
      adapterVersion: 1,
      mode: 'CAS',
      namespaceId: value.namespaceId,
      logicalKey: value.logicalKey,
      expectedActiveHeadsDigest: null,
      replaceGraphs: [{ graphUri: graph, quads: [quad] }],
      replaceSubjects: [],
      deleteQuads: [],
      insertQuads: [],
      conflictGraphs: [],
      newActiveHeadsDigest: bytes(`${label}-active-heads`),
      newConflictHeadsDigest: bytes(`${label}-conflict-heads`),
      newStateDigest: bytes(`${label}-state`),
      sourceVectorId: bytes(`${label}-vector`),
      ...overrides,
    },
  };
}

function persisted(
  outcome: DkgWalSemanticProjectionOutcomeV1,
): WalProjectionCommitInputV1 {
  return { ...outcome.commit, materializationStatus: 'APPLIED' };
}

function withCommit(
  store: OxigraphStore,
  commit: NonNullable<TripleStore['commitWalProjectionV1']>,
): TripleStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'commitWalProjectionV1') return commit;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function retryKey(value: WalProjectionScopeV1): string {
  return `wal-projection:${Buffer.from(value.namespaceId).toString('hex')}:${Buffer.from(value.logicalKey).toString('hex')}`;
}

describe('WAL-v1 shared-core projection materializer', () => {
  const roots: string[] = [];
  const controls: WalControlStore[] = [];
  const packedStores: PackedWalObjectStore[] = [];
  const graphStores: OxigraphStore[] = [];

  afterEach(async () => {
    for (const control of controls.splice(0)) control.close();
    for (const packed of packedStores.splice(0)) packed.close();
    await Promise.all(graphStores.splice(0).map(store => store.close().catch(() => {})));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function control(label: string, now: () => number = () => 1_000): Promise<{
    root: string;
    control: WalControlStore;
  }> {
    const root = await mkdtemp(join(tmpdir(), `dkg-wal-materializer-${label}-`));
    roots.push(root);
    const packed = new PackedWalObjectStore({ root });
    packedStores.push(packed);
    const value = new WalControlStore({ root, now });
    controls.push(value);
    return { root, control: value };
  }

  function graphStore(path?: string): OxigraphStore {
    const value = new OxigraphStore(path);
    graphStores.push(value);
    return value;
  }

  function closeControl(value: WalControlStore): void {
    value.close();
    controls.splice(controls.indexOf(value), 1);
  }

  async function closeGraphStore(value: OxigraphStore): Promise<void> {
    await value.close();
    graphStores.splice(graphStores.indexOf(value), 1);
  }

  it('persists the opaque shared-core projection and stamps its durable APPLIED marker', async () => {
    const environment = await control('apply');
    const store = graphStore();
    const target = scope();
    const outcome = projection(target, 'first');
    const materializer = new DkgWalProjectionMaterializerV1({
      store,
      control: environment.control,
      now: () => 1_000,
    });

    await expect(materializer.apply(outcome)).resolves.toEqual({
      status: 'APPLIED',
      marker: buildWalProjectionCommitPlanV1(persisted(outcome)).marker,
    });
    expect(materializer.capability()).toEqual({ transactionVersion: 'v1', authoritativeEligible: true });
    expect(environment.control.getMaterialization(target.namespaceId, target.logicalKey)).toEqual(
      expect.objectContaining({
        status: 'APPLIED',
        desiredHeadsDigest: outcome.commit.newActiveHeadsDigest,
        desiredConflictHeadsDigest: outcome.commit.newConflictHeadsDigest,
        desiredStateDigest: outcome.commit.newStateDigest,
        sourceVectorId: outcome.commit.sourceVectorId,
        lastError: null,
      }),
    );
    expect(await readWalProjectionMarkerV1(store, target.namespaceId, target.logicalKey)).toEqual(
      buildWalProjectionCommitPlanV1(persisted(outcome)).marker,
    );
  });

  it('serializes one namespace/logical-key and recalculates a stale guarded outcome', async () => {
    const environment = await control('guard');
    const store = graphStore();
    const target = scope();
    const first = projection(target, 'first');
    const second = projection(target, 'second', {
      expectedActiveHeadsDigest: first.commit.newActiveHeadsDigest,
    });
    const thirdStale = projection(target, 'third-stale', {
      expectedActiveHeadsDigest: first.commit.newActiveHeadsDigest,
    });
    const thirdCurrent = projection(target, 'third-current', {
      expectedActiveHeadsDigest: second.commit.newActiveHeadsDigest,
    });
    const materializer = new DkgWalProjectionMaterializerV1({ store, control: environment.control });
    await materializer.apply(first);
    let recalculations = 0;

    const [secondResult, thirdResult] = await Promise.all([
      materializer.apply(second),
      materializer.apply(thirdStale, async marker => {
        recalculations += 1;
        expect(marker?.activeHeadsDigest).toEqual(second.commit.newActiveHeadsDigest);
        return thirdCurrent;
      }),
    ]);

    expect(secondResult.status).toBe('APPLIED');
    expect(thirdResult.status).toBe('APPLIED');
    expect(recalculations).toBe(1);
    expect((await readWalProjectionMarkerV1(store, target.namespaceId, target.logicalKey))?.activeHeadsDigest)
      .toEqual(thirdCurrent.commit.newActiveHeadsDigest);
  });

  it('converges to identical markers and RDF state under opposite replay scheduling', async () => {
    const firstEnvironment = await control('opposite-a');
    const secondEnvironment = await control('opposite-b');
    const firstStore = graphStore();
    const secondStore = graphStore();
    const target = scope('opposite');
    const base = projection(target, 'opposite-base');
    const left = projection(target, 'opposite-left', {
      expectedActiveHeadsDigest: base.commit.newActiveHeadsDigest,
    });
    const right = projection(target, 'opposite-right', {
      expectedActiveHeadsDigest: base.commit.newActiveHeadsDigest,
    });

    const run = async (
      store: OxigraphStore,
      controlStore: WalControlStore,
      first: DkgWalSemanticProjectionOutcomeV1,
      stale: DkgWalSemanticProjectionOutcomeV1,
    ) => {
      const materializer = new DkgWalProjectionMaterializerV1({ store, control: controlStore });
      await materializer.apply(base);
      await materializer.apply(first);
      await materializer.apply(stale, async marker => projection(target, 'opposite-canonical', {
        expectedActiveHeadsDigest: marker!.activeHeadsDigest,
      }));
      const graph = walProjectionShadowGraphV1(target.namespaceId, target.logicalKey, 'content');
      return {
        marker: await readWalProjectionMarkerV1(store, target.namespaceId, target.logicalKey),
        projection: await store.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
        ),
      };
    };

    const leftThenRight = await run(firstStore, firstEnvironment.control, left, right);
    const rightThenLeft = await run(secondStore, secondEnvironment.control, right, left);
    expect(leftThenRight).toEqual(rightThenLeft);
  });

  it('uses an exact post-read as the only success rule after a lost commit response', async () => {
    const environment = await control('lost-response');
    const raw = graphStore();
    const target = scope();
    const outcome = projection(target, 'lost-response');
    const lostResponse = withCommit(raw, async input => {
      await raw.commitWalProjectionV1(input);
      throw new Error('commit response lost');
    });
    const materializer = new DkgWalProjectionMaterializerV1({ store: lostResponse, control: environment.control });

    await expect(materializer.apply(outcome)).resolves.toMatchObject({ status: 'APPLIED' });
    expect(environment.control.getMaterialization(target.namespaceId, target.logicalKey)?.status).toBe('APPLIED');
    expect(environment.control.leaseRetry(1, 10_000)).toBeNull();
  });

  it('retries a lost response when the post-read marker belongs to another exact outcome', async () => {
    const environment = await control('different-marker');
    const raw = graphStore();
    const target = scope();
    const desired = projection(target, 'desired');
    const different = projection(target, 'different');
    const lostDifferentResponse = withCommit(raw, async () => {
      await raw.commitWalProjectionV1(persisted(different));
      throw new Error('different response lost');
    });
    const materializer = new DkgWalProjectionMaterializerV1({
      store: lostDifferentResponse,
      control: environment.control,
      now: () => 2_000,
      retryDelayMs: 50,
    });

    await expect(materializer.apply(desired)).resolves.toMatchObject({ status: 'RETRY' });
    expect(environment.control.getMaterialization(target.namespaceId, target.logicalKey)).toEqual(
      expect.objectContaining({
        status: 'PENDING',
        attempts: 1,
        lastError: 'different response lost',
        retryAtMs: 2_050,
      }),
    );
    expect(environment.control.leaseRetry(10, 2_049)).toBeNull();
    expect(environment.control.leaseRetry(10, 2_050)?.key).toBe(retryKey(target));
  });

  it('fails closed on unavailable capability or corrupt marker state', async () => {
    const unsupportedEnvironment = await control('unsupported');
    const target = scope('unsupported');
    const unsupported = new DkgWalProjectionMaterializerV1({
      store: {} as TripleStore,
      control: unsupportedEnvironment.control,
    });
    await expect(unsupported.apply(projection(target, 'unsupported'))).resolves.toMatchObject({
      status: 'BLOCKED',
      error: expect.objectContaining({ code: 'WAL_PROJECTION_CAPABILITY_UNAVAILABLE' }),
    });

    const corruptEnvironment = await control('corrupt');
    const raw = graphStore();
    const corruptScope = scope('corrupt');
    const markerSubject = `urn:dkg:wal:projection:v1:${Buffer.from(corruptScope.namespaceId).toString('hex')}:${Buffer.from(corruptScope.logicalKey).toString('hex')}`;
    await raw.insert([{
      subject: markerSubject,
      predicate: 'urn:dkg:wal:projection:v1:unexpected',
      object: '"corrupt"',
      graph: WAL_PROJECTION_MARKER_GRAPH,
    }]);
    const corrupt = new DkgWalProjectionMaterializerV1({ store: raw, control: corruptEnvironment.control });
    await expect(corrupt.apply(projection(corruptScope, 'corrupt'))).resolves.toMatchObject({
      status: 'BLOCKED',
      error: expect.objectContaining({ code: 'WAL_PROJECTION_CORRUPT' }),
    });
    expect(corruptEnvironment.control.getMaterialization(
      corruptScope.namespaceId,
      corruptScope.logicalKey,
    )?.status).toBe('BLOCKED');
  });

  it('repairs full or selected corrupt scopes from local-WAL replay only', async () => {
    const environment = await control('rebuild');
    const store = graphStore();
    const firstScope = scope('rebuild-a');
    const secondScope = scope('rebuild-b');
    for (const value of [firstScope, secondScope]) {
      await store.insert([{
        subject: `urn:dkg:wal:projection:v1:${Buffer.from(value.namespaceId).toString('hex')}:${Buffer.from(value.logicalKey).toString('hex')}`,
        predicate: 'urn:dkg:wal:projection:v1:unexpected',
        object: '"corrupt"',
        graph: WAL_PROJECTION_MARKER_GRAPH,
      }]);
    }
    const replayed: string[] = [];
    const source: LocalWalProjectionRebuildSourceV1 = {
      listLocalScopes: async () => [secondScope, firstScope, secondScope],
      replayLocalScope: async value => {
        replayed.push(Buffer.from(value.namespaceId).toString('hex'));
        return projection(value, `rebuilt-${replayed.length}`, {
          replaceSubjects: [],
          deleteQuads: [],
          insertQuads: [],
        });
      },
    };
    const materializer = new DkgWalProjectionMaterializerV1({ store, control: environment.control });

    const full = await materializer.rebuildFromLocalWal(source);
    expect(full.map(result => result.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(replayed).toHaveLength(2);
    const selected = await materializer.rebuildFromLocalWal(source, firstScope);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.status).toBe('APPLIED');
  });

  it('recovers pending work after restart and completes a leased retry', async () => {
    let clock = 3_000;
    const environment = await control('restart', () => clock);
    const graphPath = join(environment.root, 'projection.nq');
    const firstStore = graphStore(graphPath);
    const target = scope('restart');
    const outcome = projection(target, 'restart');
    const unavailableResponse = withCommit(firstStore, async () => {
      throw new Error('temporary graph failure');
    });
    const firstMaterializer = new DkgWalProjectionMaterializerV1({
      store: unavailableResponse,
      control: environment.control,
      now: () => clock,
      retryDelayMs: 25,
    });
    await expect(firstMaterializer.apply(outcome)).resolves.toMatchObject({ status: 'RETRY' });
    expect(environment.control.cancelRetry(retryKey(target))).toBe(true);
    closeControl(environment.control);
    await closeGraphStore(firstStore);

    const reopenedControl = new WalControlStore({ root: environment.root, now: () => clock });
    controls.push(reopenedControl);
    const reopenedStore = graphStore(graphPath);
    const restarted = new DkgWalProjectionMaterializerV1({
      store: reopenedStore,
      control: reopenedControl,
      now: () => clock,
      retryDelayMs: 25,
    });
    expect(restarted.recoverPendingRetries()).toBe(1);
    expect(restarted.recoverPendingRetries()).toBe(1);
    clock = 3_025;
    const leased = reopenedControl.leaseRetry(100, clock);
    expect(leased?.key).toBe(retryKey(target));
    const source: LocalWalProjectionRebuildSourceV1 = {
      listLocalScopes: async () => [target],
      replayLocalScope: async () => outcome,
    };
    await expect(restarted.handleLeasedRetry(leased!, source)).resolves.toMatchObject({ status: 'APPLIED' });
    expect(reopenedControl.leaseRetry(10, clock)).toBeNull();
    expect(reopenedControl.getMaterialization(target.namespaceId, target.logicalKey)?.status).toBe('APPLIED');
  });

  it('audits APPLIED control state after restart and rebuilds a lost graph projection', async () => {
    let clock = 3_500;
    const environment = await control('applied-restart-audit', () => clock);
    const target = scope('applied-restart-audit');
    const outcome = projection(target, 'applied-restart-audit');
    const firstStore = graphStore();
    const first = new DkgWalProjectionMaterializerV1({
      store: firstStore,
      control: environment.control,
      now: () => clock,
      retryDelayMs: 25,
    });
    await expect(first.apply(outcome)).resolves.toMatchObject({ status: 'APPLIED' });
    closeControl(environment.control);
    // The graph projection is intentionally in-memory and is lost here. The
    // admitted WAL/control DB remains the durable source for recovery.
    await closeGraphStore(firstStore);

    const reopenedControl = new WalControlStore({ root: environment.root, now: () => clock });
    controls.push(reopenedControl);
    const emptyRestartedStore = graphStore();
    const restarted = new DkgWalProjectionMaterializerV1({
      store: emptyRestartedStore,
      control: reopenedControl,
      now: () => clock,
      retryDelayMs: 25,
    });
    await expect(restarted.auditAppliedMaterializations()).resolves.toEqual({
      verifiedApplied: 0,
      requeuedApplied: 1,
      blockedApplied: 0,
    });
    expect(reopenedControl.getMaterialization(target.namespaceId, target.logicalKey)).toEqual(
      expect.objectContaining({ status: 'PENDING', attempts: 1, retryAtMs: 3_525 }),
    );
    clock = 3_525;
    const leased = reopenedControl.leaseRetry(100, clock)!;
    const source: LocalWalProjectionRebuildSourceV1 = {
      listLocalScopes: async () => [target],
      replayLocalScope: async () => outcome,
    };
    await expect(restarted.handleLeasedRetry(leased, source)).resolves.toMatchObject({ status: 'APPLIED' });
    await expect(restarted.auditAppliedMaterializations()).resolves.toEqual({
      verifiedApplied: 1,
      requeuedApplied: 0,
      blockedApplied: 0,
    });
    expect(await readWalProjectionMarkerV1(
      emptyRestartedStore,
      target.namespaceId,
      target.logicalKey,
    )).toEqual(buildWalProjectionCommitPlanV1(persisted(outcome)).marker);

    const markerSubject = `urn:dkg:wal:projection:v1:${Buffer.from(target.namespaceId).toString('hex')}:${Buffer.from(target.logicalKey).toString('hex')}`;
    await emptyRestartedStore.update(`
      INSERT DATA { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> {
        <${markerSubject}> <urn:dkg:wal:projection:v1:unexpected> "corrupt" .
      } }
    `);
    await expect(restarted.auditAppliedMaterializations()).resolves.toEqual({
      verifiedApplied: 0,
      requeuedApplied: 0,
      blockedApplied: 1,
    });
    expect(reopenedControl.getMaterialization(target.namespaceId, target.logicalKey)?.status).toBe('BLOCKED');
  });

  it('returns RECALCULATE without a callback and reschedules leased guard failures', async () => {
    let clock = 4_000;
    const environment = await control('leased-guard', () => clock);
    const store = graphStore();
    const target = scope('leased-guard');
    const current = projection(target, 'current');
    const stale = projection(target, 'stale', { expectedActiveHeadsDigest: bytes('never-current') });
    const materializer = new DkgWalProjectionMaterializerV1({
      store,
      control: environment.control,
      now: () => clock,
      retryDelayMs: 10,
      maximumGuardRetries: 0,
    });
    await materializer.apply(current);
    environment.control.enqueueRetry({
      key: retryKey(target),
      kind: 'WAL_PROJECTION_LOGICAL_KEY',
      payload: new Uint8Array([...target.namespaceId, ...target.logicalKey]),
      availableAtMs: clock,
    });
    const leased = environment.control.leaseRetry(100, clock)!;
    const source: LocalWalProjectionRebuildSourceV1 = {
      listLocalScopes: async () => [target],
      replayLocalScope: async () => stale,
    };

    await expect(materializer.handleLeasedRetry(leased, source)).resolves.toMatchObject({
      status: 'RECALCULATE',
    });
    clock += 10;
    expect(environment.control.leaseRetry(100, clock)).toEqual(
      expect.objectContaining({ key: retryKey(target), attempts: 1, state: 'LEASED' }),
    );
  });

  it('validates retry, scope, and bounded scheduling inputs without inventing semantics', async () => {
    const environment = await control('validation');
    const store = graphStore();
    const target = scope('validation');
    expect(() => new DkgWalProjectionMaterializerV1({
      store,
      control: environment.control,
      retryDelayMs: 0,
    })).toThrowError(expect.objectContaining({ code: 'WAL_PROJECTION_RETRY_INVALID' }));
    expect(() => new DkgWalProjectionMaterializerV1({
      store,
      control: environment.control,
      maximumGuardRetries: -1,
    })).toThrowError(expect.objectContaining({ code: 'WAL_PROJECTION_RETRY_INVALID' }));

    const materializer = new DkgWalProjectionMaterializerV1({ store, control: environment.control });
    const invalidEntry = {
      key: 'invalid',
      kind: 'OTHER',
      payload: new Uint8Array(64),
      priority: 0,
      attempts: 0,
      maximumAttempts: 1,
      availableAtMs: 0,
      leaseUntilMs: null,
      state: 'READY',
      lastError: null,
    } satisfies RetryQueueEntry;
    const source: LocalWalProjectionRebuildSourceV1 = {
      listLocalScopes: async () => [target],
      replayLocalScope: async value => projection(value, 'validation'),
    };
    await expect(materializer.handleLeasedRetry(invalidEntry, source)).rejects.toMatchObject({
      code: 'WAL_PROJECTION_RETRY_INVALID',
    });
    await expect(materializer.handleLeasedRetry({
      ...invalidEntry,
      kind: 'WAL_PROJECTION_LOGICAL_KEY',
      state: 'LEASED',
      payload: new Uint8Array(63),
    }, source)).rejects.toMatchObject({ code: 'WAL_PROJECTION_RETRY_INVALID' });

    const initial = projection(target, 'initial');
    const otherScope = scope('other');
    await materializer.apply(initial);
    await expect(materializer.apply(
      projection(target, 'stale', { expectedActiveHeadsDigest: bytes('not-current') }),
      async () => projection(otherScope, 'wrong-scope'),
    )).rejects.toBeInstanceOf(DkgWalProjectionMaterializerError);
    await expect(materializer.rebuildFromLocalWal({
      listLocalScopes: async () => [target],
      replayLocalScope: async () => projection(otherScope, 'wrong-rebuild-scope'),
    })).rejects.toMatchObject({ code: 'WAL_PROJECTION_SCOPE_MISMATCH' });
  });

  it('keeps equal logical keys in different namespaces independent', async () => {
    const environment = await control('namespace-isolation');
    const store = graphStore();
    const logicalKey = bytes('shared-logical-key');
    const firstScope = { namespaceId: bytes('namespace-a'), logicalKey };
    const secondScope = { namespaceId: bytes('namespace-b'), logicalKey };
    const materializer = new DkgWalProjectionMaterializerV1({ store, control: environment.control });

    await expect(Promise.all([
      materializer.apply(projection(firstScope, 'namespace-a')),
      materializer.apply(projection(secondScope, 'namespace-b')),
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'APPLIED' }),
      expect.objectContaining({ status: 'APPLIED' }),
    ]);
    expect(environment.control.getMaterialization(firstScope.namespaceId, logicalKey)?.status).toBe('APPLIED');
    expect(environment.control.getMaterialization(secondScope.namespaceId, logicalKey)?.status).toBe('APPLIED');
  });

  it('keeps replay scheduling and DKG semantics outside the persistence package', async () => {
    const source = await readFile(
      new URL('../src/wal/projection-materializer.ts', import.meta.url),
      'utf8',
    );
    const imports = source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];$/gm)?.join('\n') ?? '';
    expect(imports).not.toMatch(/dkg-core|\/replay|semantic-core|chain|publisher|sync/);
    expect(source).not.toMatch(/fetch\(|libp2p|PeerResolver/);
    expect(source).toContain("Omit<WalProjectionCommitInputV1, 'materializationStatus'>");
    expect(source).toContain("materializationStatus: 'APPLIED'");
  });
});
