import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  FileWalGenesisBarrierJournalV1,
  WalGenesisMaintenanceBarrierV1,
  buildWalGenesisPlanV1,
  createWalGenesisBarrierBundleV1,
  createWalGenesisDryRunReportV1,
  createWalGenesisSnapshotArtifactV1,
  createWalGenesisVectorV1,
  createWalLegacyGenesisArtifactV1,
  materializeWalGenesisBarrierBundleV1,
  protocolTupleId,
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  type ProtocolTuple,
  type WalEip191Signer,
  type WalGenesisBarrierArtifactV1,
  type WalGenesisBarrierBundleV1,
  type WalGenesisBarrierJournalStateV1,
  type WalGenesisBarrierJournalV1,
  type WalGenesisBarrierOperationsV1,
  type WalGenesisGraphFamilyV1,
  type WalGenesisSourceRowV1,
} from '../../src/index.js';

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-barrier-test-v1\0${label}`).digest().subarray(0, length));
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  return {
    address: recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey)),
    signMessage: value => signEip191DigestWithPrivateKey(value, privateKey),
  };
}

const author = signer(1);
const migration = signer(2);
const curator = signer(3);
const collectionId = bytes('collection');
const authorNamespace = bytes('author-namespace');
const legacyNamespace = bytes('legacy-namespace');
const barrierVectorId = bytes('barrier-vector');
const frontier: ProtocolTuple<'ChainFrontierV1'> = [2043n, 77n, bytes('block')];

function source(): { readFamily(family: WalGenesisGraphFamilyV1): AsyncIterable<WalGenesisSourceRowV1> } {
  const rows: WalGenesisSourceRowV1[] = [
    {
      family: 'SWM_CONTENT', collectionId, namespaceId: authorNamespace,
      logicalKey: bytes('author-key'), visibility: 'public', stateKind: 'LIVE',
      graphBytes: '<urn:a> <urn:p> "value" <urn:g> .\n',
      provenance: { kind: 'AUTHOR', writerId: author.address },
      policyObjectId: bytes('rdf-policy'), adapterVersion: 1n, chainFrontier: frontier,
    },
    {
      family: 'VM_CONTENT', collectionId, namespaceId: legacyNamespace,
      logicalKey: bytes('legacy-key'), visibility: 'public', stateKind: 'LIVE',
      graphBytes: '<urn:l> <urn:p> "legacy" <urn:g> .\n',
      provenance: { kind: 'UNCLAIMABLE' },
      policyObjectId: bytes('rdf-policy'), adapterVersion: 1n, chainFrontier: frontier,
    },
  ];
  return {
    readFamily(family) {
      return (async function* () {
        for (const row of rows) if (row.family === family) yield row;
      })();
    },
  };
}

async function fixture() {
  const plan = await buildWalGenesisPlanV1({
    collectionId,
    barrierVectorId,
    migrationPolicyObjectId: bytes('migration-policy'),
    createdAtMs: 1_000,
    source: source(),
  });
  const snapshot = await createWalGenesisSnapshotArtifactV1({ lane: plan.authorLanes[0]!, signer: author });
  const legacy = await createWalLegacyGenesisArtifactV1({
    lane: plan.legacyLanes[0]!, barrierVectorId, createdAtMs: 1_000,
    migrationWriterId: migration.address, signer: migration,
  });
  const vector = await createWalGenesisVectorV1({
    plan,
    membershipCheckpointId: bytes('membership'),
    activeNamespaceIds: [authorNamespace, legacyNamespace],
    heads: [
      {
        namespaceId: authorNamespace,
        writerId: author.address,
        checkpointId: protocolTupleId('AuthorCheckpointV1', snapshot.headCheckpoint),
      },
      {
        namespaceId: legacyNamespace,
        writerId: migration.address,
        checkpointId: protocolTupleId('AuthorCheckpointV1', legacy.checkpoint),
      },
    ],
    vectorEpoch: 0n, vectorNumber: 1n, issuedAtMs: 1_000, expiresAtMs: 2_000,
    finalizedChainFrontier: frontier, authoritySetId: bytes('authority'), signers: [curator],
  });
  return {
    plan,
    snapshot,
    legacy,
    vector,
    bundle: createWalGenesisBarrierBundleV1({
      plan, authorSnapshots: [snapshot], legacyGenesis: [legacy], headVector: vector,
    }),
  };
}

function operations(options: {
  failArtifactKey?: string;
  authority?: 'legacy' | 'wal';
  proofs?: Awaited<ReturnType<WalGenesisBarrierOperationsV1['auditPostBarrierShadow']>>;
} = {}) {
  const events: string[] = [];
  let failed = false;
  const value: WalGenesisBarrierOperationsV1 = {
    currentSyncAuthority: vi.fn(async () => options.authority ?? 'legacy'),
    pauseWrites: vi.fn(async () => { events.push('pause'); }),
    persistArtifact: vi.fn(async (artifact: WalGenesisBarrierArtifactV1) => {
      events.push(`persist:${artifact.key}`);
      if (!failed && artifact.key === options.failArtifactKey) {
        failed = true;
        throw new Error(`crash:${artifact.key}`);
      }
    }),
    armShadowCapture: vi.fn(async () => { events.push('arm'); return 'production-cursor-1'; }),
    resumeWrites: vi.fn(async () => { events.push('resume'); }),
    auditPostBarrierShadow: vi.fn(async () => options.proofs ?? [{
      mutationId: 'mutation-1', walObjectId: bytes('wal-object'), durable: true,
    }]),
    abortPausedBarrier: vi.fn(async () => { events.push('abort'); }),
  };
  return { value, events };
}

async function journal(label: string) {
  const root = await mkdtemp(join(tmpdir(), `wal-genesis-barrier-${label}-`));
  return new FileWalGenesisBarrierJournalV1({ path: join(root, 'journal.json') });
}

describe('WAL-018 maintenance barrier', () => {
  it('produces deterministic dry-run evidence without an operational mutation surface', async () => {
    const first = await fixture();
    const second = await fixture();
    const report = createWalGenesisDryRunReportV1(first.plan);
    const repeated = createWalGenesisDryRunReportV1(second.plan);
    expect(report).toMatchObject({ rowCount: 2, authorLaneCount: 1, legacyLaneCount: 1, liveCount: 2, tombstoneCount: 0 });
    expect(report.canonicalBytes).toEqual(repeated.canonicalBytes);
    expect(report.reportDigest).toEqual(repeated.reportDigest);
    expect(first.bundle.artifacts.at(-1)?.kind).toBe('HEAD_VECTOR');
  });

  it('resolves each author signer and materializes the complete signed bundle in one tool call', async () => {
    const { plan, bundle } = await fixture();
    const resolveAuthorSigner = vi.fn(async () => author);
    const materialized = await materializeWalGenesisBarrierBundleV1({
      plan,
      authorSigners: { resolveAuthorSigner },
      migrationWriterId: migration.address,
      migrationSigner: migration,
      membershipCheckpointId: bytes('membership'),
      vectorEpoch: 0n,
      vectorNumber: 1n,
      issuedAtMs: 1_000,
      expiresAtMs: 2_000,
      finalizedChainFrontier: frontier,
      authoritySetId: bytes('authority'),
      curatorSigners: [curator],
    });
    expect(resolveAuthorSigner).toHaveBeenCalledOnce();
    expect(resolveAuthorSigner).toHaveBeenCalledWith(author.address);
    expect(materialized.barrierId).toEqual(bundle.barrierId);
    expect(materialized.artifacts.map(value => value.kind)).toEqual(bundle.artifacts.map(value => value.kind));
  });

  it('persists the vector last, arms shadow capture before resume, audits every production mutation, and is resumable', async () => {
    const { bundle } = await fixture();
    const active = operations();
    const file = await journal('success');
    const barrier = new WalGenesisMaintenanceBarrierV1(active.value, file);
    await expect(barrier.run(bundle)).resolves.toMatchObject({
      shadowCursor: 'production-cursor-1', persistedArtifacts: bundle.artifacts.length, auditedMutations: 1,
    });
    expect(active.events.at(-3)).toBe(`persist:${bundle.artifacts.at(-1)!.key}`);
    expect(active.events.slice(-2)).toEqual(['arm', 'resume']);

    await barrier.run(bundle);
    expect(active.value.pauseWrites).toHaveBeenCalledOnce();
    expect(active.value.persistArtifact).toHaveBeenCalledTimes(bundle.artifacts.length);
    expect(active.value.armShadowCapture).toHaveBeenCalledOnce();
    expect(active.value.resumeWrites).toHaveBeenCalledOnce();
    expect(active.value.auditPostBarrierShadow).toHaveBeenCalledTimes(2);
  });

  it('recovers from a crash at every manifest/snapshot/checkpoint/object/vector persistence boundary before resuming writes', async () => {
    const { bundle } = await fixture();
    for (const artifact of bundle.artifacts) {
      const active = operations({ failArtifactKey: artifact.key });
      const barrier = new WalGenesisMaintenanceBarrierV1(active.value, await journal(artifact.kind));
      await expect(barrier.run(bundle)).rejects.toThrow(`crash:${artifact.key}`);
      expect(active.events).not.toContain('resume');
      await expect(barrier.run(bundle)).resolves.toMatchObject({ persistedArtifacts: bundle.artifacts.length });
      expect(active.events.indexOf('arm')).toBeGreaterThan(active.events.lastIndexOf(`persist:${bundle.artifacts.at(-1)!.key}`));
      expect(active.events.indexOf('resume')).toBeGreaterThan(active.events.indexOf('arm'));
    }
  });

  it('fails closed on authority changes or a missing shadow object and permits abort only while paused', async () => {
    const { bundle } = await fixture();
    const wrongAuthority = operations({ authority: 'wal' });
    await expect(new WalGenesisMaintenanceBarrierV1(wrongAuthority.value, await journal('authority')).run(bundle))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_AUTHORITY_CHANGED' });
    expect(wrongAuthority.events).toEqual([]);

    const gap = operations({ proofs: [{ mutationId: 'missing', walObjectId: null, durable: false }] });
    const gapBarrier = new WalGenesisMaintenanceBarrierV1(gap.value, await journal('gap'));
    await expect(gapBarrier.run(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_SHADOW_GAP' });
    expect(gap.events).toContain('resume');

    const crashed = operations({ failArtifactKey: bundle.artifacts[1]!.key });
    const abortable = new WalGenesisMaintenanceBarrierV1(crashed.value, await journal('abort'));
    await expect(abortable.run(bundle)).rejects.toThrow('crash:');
    await expect(abortable.abort(bundle)).resolves.toBeUndefined();
    expect(crashed.events).toContain('abort');
    await expect(abortable.run(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_BARRIER_CONFLICT' });
  });

  it('rejects incomplete, duplicate, substituted, and malformed barrier artifacts', async () => {
    const { plan, snapshot, legacy, vector } = await fixture();
    const create = (overrides: Record<string, unknown>) => createWalGenesisBarrierBundleV1({
      plan, authorSnapshots: [snapshot], legacyGenesis: [legacy], headVector: vector, ...overrides,
    } as never);
    const reject = (overrides: Record<string, unknown>, code: string) => expect(() => create(overrides))
      .toThrow(expect.objectContaining({ code }));

    reject({ authorSnapshots: [snapshot, snapshot] }, 'WAL_MIGRATION_DUPLICATE_STATE');
    reject({ legacyGenesis: [legacy, legacy] }, 'WAL_MIGRATION_DUPLICATE_STATE');
    reject({ authorSnapshots: [] }, 'WAL_MIGRATION_INCOMPLETE_TARGET');
    reject({ legacyGenesis: [] }, 'WAL_MIGRATION_INCOMPLETE_TARGET');
    reject({ authorSnapshots: [{ ...snapshot, lane: { ...snapshot.lane, namespaceId: bytes('other-author') } }] },
      'WAL_MIGRATION_INCOMPLETE_TARGET');
    reject({ legacyGenesis: [{ ...legacy, lane: { ...legacy.lane, namespaceId: bytes('other-legacy') } }] },
      'WAL_MIGRATION_INCOMPLETE_TARGET');

    reject({ plan: { ...plan, manifestBytes: new Uint8Array() } }, 'WAL_MIGRATION_INVALID');
    reject({ plan: { ...plan, manifestDigest: new Uint8Array(31) } }, 'WAL_MIGRATION_INVALID');
    reject({ plan: { ...plan, manifestDigest: 'not-bytes' } }, 'WAL_MIGRATION_INVALID');
    reject({ headVector: { ...vector, vectorId: bytes('wrong-vector-id') } }, 'WAL_MIGRATION_BARRIER_CONFLICT');
    const noPrevious = [...vector.vector] as unknown[];
    noPrevious[6] = null;
    reject({ headVector: { ...vector, vector: noPrevious } }, 'WAL_MIGRATION_BARRIER_CONFLICT');
    const wrongPrevious = [...vector.vector] as unknown[];
    wrongPrevious[6] = bytes('wrong-previous-vector');
    reject({ headVector: { ...vector, vector: wrongPrevious } }, 'WAL_MIGRATION_BARRIER_CONFLICT');
  });

  it('fails closed for invalid construction, audit receipts, cursors, and abort states', async () => {
    const { bundle } = await fixture();
    expect(() => new WalGenesisMaintenanceBarrierV1(null as never, {} as never))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new WalGenesisMaintenanceBarrierV1(operations().value, null as never))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));

    const invalidRuns: Array<{ label: string; proofs: never[] }> = [
      { label: 'duplicate', proofs: [
        { mutationId: 'same', walObjectId: bytes('first'), durable: true },
        { mutationId: 'same', walObjectId: bytes('second'), durable: true },
      ] as never[] },
      { label: 'not-durable', proofs: [{ mutationId: 'mutation', walObjectId: bytes('object'), durable: false }] as never[] },
      { label: 'null-object', proofs: [{ mutationId: 'mutation', walObjectId: null, durable: true }] as never[] },
      { label: 'short-object', proofs: [{ mutationId: 'mutation', walObjectId: new Uint8Array(31), durable: true }] as never[] },
      { label: 'nonbytes-object', proofs: [{ mutationId: 'mutation', walObjectId: 'not-bytes', durable: true }] as never[] },
      { label: 'empty-mutation', proofs: [{ mutationId: '', walObjectId: bytes('object'), durable: true }] as never[] },
      { label: 'long-mutation', proofs: [{ mutationId: 'x'.repeat(513), walObjectId: bytes('object'), durable: true }] as never[] },
      { label: 'non-nfc-mutation', proofs: [{ mutationId: 'e\u0301', walObjectId: bytes('object'), durable: true }] as never[] },
      { label: 'nontext-mutation', proofs: [{ mutationId: 1, walObjectId: bytes('object'), durable: true }] as never[] },
    ];
    for (const invalid of invalidRuns) {
      const active = operations({ proofs: invalid.proofs });
      await expect(new WalGenesisMaintenanceBarrierV1(active.value, await journal(invalid.label)).run(bundle))
        .rejects.toMatchObject({
          code: invalid.label === 'duplicate' || invalid.label === 'not-durable' || invalid.label === 'null-object'
            ? 'WAL_MIGRATION_SHADOW_GAP'
            : 'WAL_MIGRATION_INVALID',
        });
    }

    const cursor = operations();
    vi.mocked(cursor.value.armShadowCapture).mockResolvedValue('');
    await expect(new WalGenesisMaintenanceBarrierV1(cursor.value, await journal('empty-cursor')).run(bundle))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });

    const successful = operations();
    const completedJournal = await journal('completed-abort');
    const completed = new WalGenesisMaintenanceBarrierV1(successful.value, completedJournal);
    await completed.run(bundle);
    await expect(completed.abort(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_BARRIER_CONFLICT' });

    const saved = (await completedJournal.load(bundle.barrierId))!;
    const memory = (state: WalGenesisBarrierJournalStateV1): WalGenesisBarrierJournalV1 => ({
      load: async () => state,
      save: async () => undefined,
    });
    await expect(new WalGenesisMaintenanceBarrierV1(operations().value, memory({
      ...saved, writesResumed: false, completed: false, aborted: true,
    })).abort(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_BARRIER_CONFLICT' });
    await expect(new WalGenesisMaintenanceBarrierV1(operations().value, memory({
      ...saved, bundleDigest: bytes('wrong-bundle'), writesResumed: false, completed: false,
    })).abort(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });
    await expect(new WalGenesisMaintenanceBarrierV1(operations().value, memory({
      ...saved, writesResumed: false, completed: true,
    })).abort(bundle)).rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });

    const rejectState = (state: unknown) => expect(
      new WalGenesisMaintenanceBarrierV1(
        operations().value,
        memory(state as WalGenesisBarrierJournalStateV1),
      ).run(bundle),
    ).rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });
    await rejectState({ ...saved, barrierId: 'not-bytes' });
    await rejectState({ ...saved, barrierId: new Uint8Array(31) });
    await rejectState({ ...saved, barrierId: bytes('other-barrier') });
    await rejectState({ ...saved, bundleDigest: 'not-bytes' });
    await rejectState({ ...saved, bundleDigest: new Uint8Array(31) });
    for (const field of ['writesPaused', 'writesResumed', 'completed', 'aborted'] as const) {
      await rejectState({ ...saved, [field]: 'not-boolean' });
    }
    await rejectState({ ...saved, shadowCursor: 1 });
    await rejectState({ ...saved, persistedArtifactKeys: 'not-an-array' });
    await rejectState({ ...saved, persistedArtifactKeys: [...saved.persistedArtifactKeys, 'extra'] });
    await rejectState({ ...saved, persistedArtifactKeys: saved.persistedArtifactKeys.map((key, index) => (
      index === 0 ? 'wrong-key' : key
    )) });
    await rejectState({ ...saved, persistedArtifactKeys: [1, ...saved.persistedArtifactKeys.slice(1)] });

    const initial = {
      ...saved,
      writesPaused: false,
      persistedArtifactKeys: [],
      shadowCursor: null,
      writesResumed: false,
      completed: false,
    };
    await rejectState({ ...initial, persistedArtifactKeys: [bundle.artifacts[0]!.key] });
    await rejectState({ ...initial, shadowCursor: 'cursor' });
    await rejectState({ ...initial, writesResumed: true });
    await rejectState({ ...initial, completed: true });
    await rejectState({ ...saved, shadowCursor: '' });
    await rejectState({ ...saved, shadowCursor: 'x'.repeat(513) });
    await rejectState({ ...saved, shadowCursor: 'e\u0301' });
    await rejectState({ ...saved, persistedArtifactKeys: saved.persistedArtifactKeys.slice(0, -1) });
    await rejectState({ ...saved, shadowCursor: null });
    await rejectState({ ...saved, writesResumed: false, completed: true });
    await rejectState({ ...saved, aborted: true });
    await rejectState({ ...saved, writesResumed: false, completed: true, aborted: true });
  });

  it('can abort after pause succeeds but its first journal write crashes', async () => {
    const { bundle } = await fixture();
    const active = operations();
    let fail = true;
    const state: { value: WalGenesisBarrierJournalStateV1 | null } = { value: null };
    const unstable: WalGenesisBarrierJournalV1 = {
      load: async () => state.value,
      save: async value => {
        if (fail) {
          fail = false;
          throw new Error('journal-crash-after-pause');
        }
        state.value = value;
      },
    };
    const barrier = new WalGenesisMaintenanceBarrierV1(active.value, unstable);
    await expect(barrier.run(bundle)).rejects.toThrow('journal-crash-after-pause');
    await expect(barrier.abort(bundle)).resolves.toBeUndefined();
    expect(active.events).toEqual(['pause', 'abort']);
    expect(state.value?.aborted).toBe(true);
  });

  it('validates and transactionally recovers the file barrier journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wal-genesis-journal-boundary-'));
    expect(() => new FileWalGenesisBarrierJournalV1({ path: 'relative.json' }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new FileWalGenesisBarrierJournalV1({ path: 1 as never }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    const directory = join(root, 'directory');
    await mkdir(directory);
    expect(() => new FileWalGenesisBarrierJournalV1({ path: directory }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    const target = join(root, 'target.json');
    await writeFile(target, '{"version":1,"states":{}}\n');
    const link = join(root, 'link.json');
    await symlink(target, link);
    expect(() => new FileWalGenesisBarrierJournalV1({ path: link }))
      .toThrow(expect.objectContaining({ code: 'WAL_MIGRATION_INVALID' }));
    expect(() => new FileWalGenesisBarrierJournalV1({ path: target })).not.toThrow();

    const file = new FileWalGenesisBarrierJournalV1({ path: join(root, 'fresh.json') });
    await expect(file.load(bytes('unknown'))).resolves.toBeNull();
    await expect(file.load(new Uint8Array(31))).rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.load('not-bytes' as never)).rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    const { bundle } = await fixture();
    await new WalGenesisMaintenanceBarrierV1(operations().value, file).run(bundle);
    const loaded = (await file.load(bundle.barrierId))!;
    await expect(file.save({ ...loaded, barrierId: new Uint8Array(31) }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.save({ ...loaded, bundleDigest: new Uint8Array(31) }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.save({ ...loaded, persistedArtifactKeys: [''] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.save({ ...loaded, persistedArtifactKeys: ['e\u0301'] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.save({ ...loaded, persistedArtifactKeys: ['x'.repeat(513)] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });
    await expect(file.save({ ...loaded, persistedArtifactKeys: [1 as never] }))
      .rejects.toMatchObject({ code: 'WAL_MIGRATION_INVALID' });

    const stateId = '0'.repeat(64);
    const digest = '1'.repeat(64);
    const rawState = {
      bundleDigest: digest,
      writesPaused: true,
      persistedArtifactKeys: ['artifact'],
      shadowCursor: 'cursor',
      writesResumed: true,
      completed: true,
      aborted: false,
    };
    const malformed = [
      'not-json',
      'null',
      '{"version":2,"states":{}}',
      '{"version":1,"states":[]}',
      '{"version":1,"states":{"bad":{"bundleDigest":"' + '0'.repeat(64) + '","persistedArtifactKeys":[]}}}',
      '{"version":1,"states":{"' + '0'.repeat(64) + '":{"bundleDigest":"bad","persistedArtifactKeys":[]}}}',
      '{"version":1,"states":{"' + '0'.repeat(64) + '":{"bundleDigest":"' + '0'.repeat(64) + '","persistedArtifactKeys":1}}}',
      JSON.stringify({ version: 1, states: { [stateId]: null } }),
      JSON.stringify({ version: 1, states: { [stateId]: [] } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, writesPaused: 1 } } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, persistedArtifactKeys: [1] } } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, shadowCursor: 1 } } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, writesResumed: 1 } } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, completed: 1 } } }),
      JSON.stringify({ version: 1, states: { [stateId]: { ...rawState, aborted: 1 } } }),
    ];
    for (const [index, json] of malformed.entries()) {
      const path = join(root, `malformed-${index}.json`);
      await writeFile(path, json);
      await expect(new FileWalGenesisBarrierJournalV1({ path }).load(bytes(`id-${index}`)))
        .rejects.toMatchObject({ code: 'WAL_MIGRATION_JOURNAL_CONFLICT' });
    }

    let crash = true;
    const crashPath = join(root, 'crash.json');
    const crashing = new FileWalGenesisBarrierJournalV1({
      path: crashPath,
      transactionHook: phase => {
        if (crash && phase === 'before-rename') {
          crash = false;
          throw new Error('transaction-crash');
        }
      },
    });
    await expect(crashing.save(loaded)).rejects.toThrow('transaction-crash');
    await expect(crashing.save(loaded)).resolves.toBeUndefined();
    await expect(crashing.load(loaded.barrierId)).resolves.toMatchObject({ completed: true });
  });
});
