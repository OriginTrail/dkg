import { blake3 } from '@noble/hashes/blake3.js';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { protocolTupleId } from '../protocol/hashes.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import type { WalEip191Signer } from '../protocol/signatures.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import {
  createWalGenesisSnapshotArtifactV1,
  createWalGenesisVectorV1,
  createWalLegacyGenesisArtifactV1,
} from './genesis.js';
import { migrationError, WalMigrationError } from './errors.js';
import type {
  WalGenesisBarrierArtifactV1,
  WalGenesisBarrierBundleV1,
  WalGenesisBarrierJournalStateV1,
  WalGenesisBarrierJournalV1,
  WalGenesisBarrierOperationsV1,
  WalGenesisBarrierRunResultV1,
  WalGenesisDryRunReportV1,
  WalGenesisPlanV1,
  WalGenesisPayloadEncoderV1,
  WalGenesisSignerResolverV1,
  WalGenesisSnapshotArtifactV1,
  WalGenesisVectorArtifactV1,
  WalLegacyGenesisArtifactV1,
} from './types.js';

const BARRIER_DOMAIN = new TextEncoder().encode('dkg-wal-genesis-barrier-v1\0');
const DRY_RUN_DOMAIN = new TextEncoder().encode('dkg-wal-genesis-dry-run-v1\0');
const MAX_TEXT = 512;

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function fixed(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function text(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT || value.normalize('NFC') !== value) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be non-empty NFC text of at most ${MAX_TEXT} characters`);
  }
  return value;
}

function artifact(
  key: string,
  kind: WalGenesisBarrierArtifactV1['kind'],
  id: Uint8Array,
  canonicalBytes: Uint8Array,
): WalGenesisBarrierArtifactV1 {
  text(key, 'artifact key');
  if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
    migrationError('WAL_MIGRATION_INVALID', 'barrier artifact bytes cannot be empty');
  }
  return { key, kind, id: fixed(id, 32, 'artifact id'), canonicalBytes: copy(canonicalBytes) };
}

function laneKey(namespaceId: Uint8Array, writerId: Uint8Array): string {
  return `${hex(namespaceId)}:${hex(writerId)}`;
}

function bundleDigest(bundle: WalGenesisBarrierBundleV1): Uint8Array {
  return blake3(concat(BARRIER_DOMAIN, encodeCanonicalCbor([
    bundle.barrierId,
    bundle.collectionId,
    bundle.barrierVectorId,
    bundle.planManifestDigest,
    bundle.headVectorId,
    bundle.artifacts.map(value => [value.key, value.kind, value.id]),
  ])));
}

/**
 * Assemble the exact durable barrier outputs. This does not write production
 * state and does not create any synchronization atom besides the included
 * complete WalObjectV1 artifacts.
 */
export function createWalGenesisBarrierBundleV1(input: {
  readonly plan: WalGenesisPlanV1;
  readonly authorSnapshots: readonly WalGenesisSnapshotArtifactV1[];
  readonly legacyGenesis: readonly WalLegacyGenesisArtifactV1[];
  readonly headVector: WalGenesisVectorArtifactV1;
}): WalGenesisBarrierBundleV1 {
  const plan = input.plan;
  const authors = new Map(input.authorSnapshots.map(value => [
    laneKey(value.lane.namespaceId, value.lane.writerId), value,
  ]));
  const legacy = new Map(input.legacyGenesis.map(value => [hex(value.lane.namespaceId), value]));
  if (authors.size !== input.authorSnapshots.length || legacy.size !== input.legacyGenesis.length) {
    migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'genesis barrier repeats an author or legacy lane');
  }
  if (authors.size !== plan.authorLanes.length || legacy.size !== plan.legacyLanes.length) {
    migrationError('WAL_MIGRATION_INCOMPLETE_TARGET', 'genesis barrier does not cover every planned lane');
  }
  const artifacts: WalGenesisBarrierArtifactV1[] = [
    artifact('plan-manifest', 'PLAN_MANIFEST', plan.manifestDigest, plan.manifestBytes),
  ];
  for (const lane of plan.authorLanes) {
    const key = laneKey(lane.namespaceId, lane.writerId);
    const value = authors.get(key);
    if (value === undefined) migrationError('WAL_MIGRATION_INCOMPLETE_TARGET', `missing author lane ${key}`);
    artifacts.push(
      artifact(`${key}:covered-checkpoint`, 'COVERED_CHECKPOINT',
        protocolTupleId('AuthorCheckpointV1', value.coveredCheckpoint), value.coveredCheckpointBytes),
      artifact(`${key}:snapshot-object`, 'SNAPSHOT_OBJECT',
        value.snapshotObject.walObjectId, value.snapshotObject.canonicalBytes),
      artifact(`${key}:head-checkpoint`, 'HEAD_CHECKPOINT',
        protocolTupleId('AuthorCheckpointV1', value.headCheckpoint), value.headCheckpointBytes),
    );
  }
  for (const lane of plan.legacyLanes) {
    const key = hex(lane.namespaceId);
    const value = legacy.get(key);
    if (value === undefined) migrationError('WAL_MIGRATION_INCOMPLETE_TARGET', `missing legacy lane ${key}`);
    artifacts.push(
      artifact(`${key}:legacy-object`, 'LEGACY_OBJECT', value.object.walObjectId, value.object.canonicalBytes),
      artifact(`${key}:legacy-checkpoint`, 'LEGACY_CHECKPOINT',
        protocolTupleId('AuthorCheckpointV1', value.checkpoint), value.checkpointBytes),
    );
  }
  if (
    !bytesEqualV1(input.headVector.vectorId, protocolTupleId('CollectionHeadVectorV1', input.headVector.vector))
    || input.headVector.vector[6] === null
    || !bytesEqualV1(input.headVector.vector[6], plan.barrierVectorId)
  ) {
    migrationError('WAL_MIGRATION_BARRIER_CONFLICT', 'genesis head vector is invalid or does not extend the barrier vector');
  }
  artifacts.push(artifact('head-vector', 'HEAD_VECTOR', input.headVector.vectorId, input.headVector.canonicalBytes));
  const barrierId = blake3(concat(BARRIER_DOMAIN, plan.manifestDigest, input.headVector.vectorId));
  return {
    barrierId,
    collectionId: copy(plan.collectionId),
    barrierVectorId: copy(plan.barrierVectorId),
    planManifestDigest: copy(plan.manifestDigest),
    headVectorId: copy(input.headVector.vectorId),
    artifacts,
  };
}

/** Resolve the existing signers once and produce every signed barrier artifact. */
export async function materializeWalGenesisBarrierBundleV1(input: {
  readonly plan: WalGenesisPlanV1;
  readonly authorSigners: WalGenesisSignerResolverV1;
  readonly migrationWriterId: Uint8Array;
  readonly migrationSigner: WalEip191Signer;
  readonly encodePayload?: WalGenesisPayloadEncoderV1;
  readonly membershipCheckpointId: Uint8Array;
  readonly vectorEpoch: bigint;
  readonly vectorNumber: bigint;
  readonly issuedAtMs: number | bigint;
  readonly expiresAtMs: number | bigint;
  readonly finalizedChainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
  readonly authoritySetId: Uint8Array;
  readonly curatorSigners: readonly WalEip191Signer[];
}): Promise<WalGenesisBarrierBundleV1> {
  const authorSnapshots: WalGenesisSnapshotArtifactV1[] = [];
  for (const lane of input.plan.authorLanes) {
    authorSnapshots.push(await createWalGenesisSnapshotArtifactV1({
      lane,
      signer: await input.authorSigners.resolveAuthorSigner(lane.writerId),
      encodePayload: input.encodePayload,
    }));
  }
  const legacyGenesis: WalLegacyGenesisArtifactV1[] = [];
  for (const lane of input.plan.legacyLanes) {
    legacyGenesis.push(await createWalLegacyGenesisArtifactV1({
      lane,
      barrierVectorId: input.plan.barrierVectorId,
      createdAtMs: input.plan.createdAtMs,
      migrationWriterId: input.migrationWriterId,
      signer: input.migrationSigner,
      encodePayload: input.encodePayload,
    }));
  }
  const activeById = new Map<string, Uint8Array>();
  for (const lane of [...input.plan.authorLanes, ...input.plan.legacyLanes]) {
    activeById.set(hex(lane.namespaceId), lane.namespaceId);
  }
  const headVector = await createWalGenesisVectorV1({
    plan: input.plan,
    membershipCheckpointId: input.membershipCheckpointId,
    activeNamespaceIds: [...activeById.values()],
    heads: [
      ...authorSnapshots.map(value => ({
        namespaceId: value.lane.namespaceId,
        writerId: value.lane.writerId,
        checkpointId: protocolTupleId('AuthorCheckpointV1', value.headCheckpoint),
      })),
      ...legacyGenesis.map(value => ({
        namespaceId: value.lane.namespaceId,
        writerId: input.migrationWriterId,
        checkpointId: protocolTupleId('AuthorCheckpointV1', value.checkpoint),
      })),
    ],
    vectorEpoch: input.vectorEpoch,
    vectorNumber: input.vectorNumber,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    finalizedChainFrontier: input.finalizedChainFrontier,
    authoritySetId: input.authoritySetId,
    signers: input.curatorSigners,
  });
  return createWalGenesisBarrierBundleV1({
    plan: input.plan,
    authorSnapshots,
    legacyGenesis,
    headVector,
  });
}

export function createWalGenesisDryRunReportV1(plan: WalGenesisPlanV1): WalGenesisDryRunReportV1 {
  const canonicalBytes = encodeCanonicalCbor([
    1n,
    plan.collectionId,
    plan.barrierVectorId,
    plan.manifestDigest,
    BigInt(plan.rows.length),
    BigInt(plan.authorLanes.length),
    BigInt(plan.legacyLanes.length),
    BigInt(plan.rows.filter(row => row.stateKind === 'LIVE').length),
    BigInt(plan.rows.filter(row => row.stateKind === 'TOMBSTONE').length),
  ]);
  return {
    collectionId: copy(plan.collectionId),
    barrierVectorId: copy(plan.barrierVectorId),
    manifestDigest: copy(plan.manifestDigest),
    rowCount: plan.rows.length,
    authorLaneCount: plan.authorLanes.length,
    legacyLaneCount: plan.legacyLanes.length,
    liveCount: plan.rows.filter(row => row.stateKind === 'LIVE').length,
    tombstoneCount: plan.rows.filter(row => row.stateKind === 'TOMBSTONE').length,
    canonicalBytes,
    reportDigest: blake3(concat(DRY_RUN_DOMAIN, canonicalBytes)),
  };
}

function initialState(bundle: WalGenesisBarrierBundleV1): WalGenesisBarrierJournalStateV1 {
  return {
    barrierId: copy(bundle.barrierId),
    bundleDigest: bundleDigest(bundle),
    writesPaused: false,
    persistedArtifactKeys: [],
    shadowCursor: null,
    writesResumed: false,
    completed: false,
    aborted: false,
  };
}

function nextState(
  state: WalGenesisBarrierJournalStateV1,
  patch: Partial<Omit<WalGenesisBarrierJournalStateV1, 'barrierId' | 'bundleDigest'>>,
): WalGenesisBarrierJournalStateV1 {
  return { ...state, ...patch };
}

function validateJournalState(
  bundle: WalGenesisBarrierBundleV1,
  state: WalGenesisBarrierJournalStateV1,
): WalGenesisBarrierJournalStateV1 {
  if (
    !state
    || !(state.barrierId instanceof Uint8Array)
    || state.barrierId.length !== 32
    || !bytesEqualV1(state.barrierId, bundle.barrierId)
    || !(state.bundleDigest instanceof Uint8Array)
    || state.bundleDigest.length !== 32
    || !bytesEqualV1(state.bundleDigest, bundleDigest(bundle))
  ) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal identity or bundle digest is invalid');
  }
  if (
    typeof state.writesPaused !== 'boolean'
    || typeof state.writesResumed !== 'boolean'
    || typeof state.completed !== 'boolean'
    || typeof state.aborted !== 'boolean'
    || (state.shadowCursor !== null && typeof state.shadowCursor !== 'string')
    || !Array.isArray(state.persistedArtifactKeys)
  ) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal lifecycle state is invalid');
  }
  if (
    state.persistedArtifactKeys.length > bundle.artifacts.length
    || state.persistedArtifactKeys.some((key, index) => (
      typeof key !== 'string' || key !== bundle.artifacts[index]?.key
    ))
  ) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal artifact prefix is invalid');
  }
  if (
    (!state.writesPaused && (
      state.persistedArtifactKeys.length !== 0
      || state.shadowCursor !== null
      || state.writesResumed
      || state.completed
    ))
    || (state.shadowCursor !== null && (
      state.shadowCursor.length === 0
      || state.shadowCursor.length > MAX_TEXT
      || state.shadowCursor.normalize('NFC') !== state.shadowCursor
      || state.persistedArtifactKeys.length !== bundle.artifacts.length
    ))
    || (state.writesResumed && state.shadowCursor === null)
    || (state.completed && !state.writesResumed)
    || (state.aborted && (state.writesResumed || state.completed))
  ) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal lifecycle ordering is invalid');
  }
  return state;
}

async function requireLegacy(operations: WalGenesisBarrierOperationsV1): Promise<void> {
  if (await operations.currentSyncAuthority() !== 'legacy') {
    migrationError(
      'WAL_MIGRATION_AUTHORITY_CHANGED',
      'genesis barrier requires current-sync authority to remain legacy',
    );
  }
}

export class WalGenesisMaintenanceBarrierV1 {
  constructor(
    private readonly operations: WalGenesisBarrierOperationsV1,
    private readonly journal: WalGenesisBarrierJournalV1,
  ) {
    if (!operations || !journal) migrationError('WAL_MIGRATION_INVALID', 'barrier operations and journal are required');
  }

  async run(bundle: WalGenesisBarrierBundleV1): Promise<WalGenesisBarrierRunResultV1> {
    let state = validateJournalState(
      bundle,
      await this.journal.load(bundle.barrierId) ?? initialState(bundle),
    );
    if (state.aborted) {
      migrationError('WAL_MIGRATION_BARRIER_CONFLICT', 'barrier journal belongs to another or aborted bundle');
    }
    await requireLegacy(this.operations);
    if (!state.writesPaused) {
      await this.operations.pauseWrites({ barrierId: bundle.barrierId, collectionId: bundle.collectionId });
      state = nextState(state, { writesPaused: true });
      await this.journal.save(state);
    }
    const persisted = new Set(state.persistedArtifactKeys);
    for (const value of bundle.artifacts) {
      if (persisted.has(value.key)) continue;
      await requireLegacy(this.operations);
      await this.operations.persistArtifact(value);
      persisted.add(value.key);
      state = nextState(state, { persistedArtifactKeys: [...persisted] });
      await this.journal.save(state);
    }
    let shadowCursor = state.shadowCursor;
    if (shadowCursor === null) {
      await requireLegacy(this.operations);
      shadowCursor = text(await this.operations.armShadowCapture({
        barrierId: bundle.barrierId,
        collectionId: bundle.collectionId,
        headVectorId: bundle.headVectorId,
      }), 'shadow cursor');
      state = nextState(state, { shadowCursor });
      await this.journal.save(state);
    }
    if (!state.writesResumed) {
      await requireLegacy(this.operations);
      await this.operations.resumeWrites({ barrierId: bundle.barrierId, shadowCursor });
      state = nextState(state, { writesResumed: true });
      await this.journal.save(state);
    }
    const proofs = await this.operations.auditPostBarrierShadow({
      barrierId: bundle.barrierId,
      shadowCursor,
    });
    const seen = new Set<string>();
    for (const proof of proofs) {
      const mutationId = text(proof.mutationId, 'post-barrier mutation ID');
      if (seen.has(mutationId)) migrationError('WAL_MIGRATION_SHADOW_GAP', 'post-barrier audit repeats a mutation ID');
      seen.add(mutationId);
      if (!proof.durable || proof.walObjectId === null) {
        migrationError('WAL_MIGRATION_SHADOW_GAP', `post-barrier mutation ${mutationId} has no durable WAL object`);
      }
      fixed(proof.walObjectId, 32, 'post-barrier WalObjectId');
    }
    state = nextState(state, { completed: true });
    await this.journal.save(state);
    return {
      barrierId: copy(bundle.barrierId),
      headVectorId: copy(bundle.headVectorId),
      shadowCursor,
      persistedArtifacts: persisted.size,
      auditedMutations: proofs.length,
    };
  }

  async abort(bundle: WalGenesisBarrierBundleV1): Promise<void> {
    let state = validateJournalState(
      bundle,
      await this.journal.load(bundle.barrierId) ?? initialState(bundle),
    );
    if (state.aborted) {
      migrationError('WAL_MIGRATION_BARRIER_CONFLICT', 'barrier journal belongs to another or aborted bundle');
    }
    if (state.writesResumed || state.completed) {
      migrationError('WAL_MIGRATION_BARRIER_CONFLICT', 'a resumed or completed barrier cannot be aborted');
    }
    await requireLegacy(this.operations);
    await this.operations.abortPausedBarrier({ barrierId: bundle.barrierId, collectionId: bundle.collectionId });
    state = nextState(state, { aborted: true });
    await this.journal.save(state);
  }
}

interface JsonBarrierStateV1 {
  version: 1;
  states: Record<string, {
    bundleDigest: string;
    writesPaused: boolean;
    persistedArtifactKeys: string[];
    shadowCursor: string | null;
    writesResumed: boolean;
    completed: boolean;
    aborted: boolean;
  }>;
}

export interface FileWalGenesisBarrierJournalOptionsV1 {
  readonly path: string;
  readonly transactionHook?: (phase: 'before-rename' | 'after-rename') => void | Promise<void>;
}

export class FileWalGenesisBarrierJournalV1 implements WalGenesisBarrierJournalV1 {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileWalGenesisBarrierJournalOptionsV1) {
    if (typeof options?.path !== 'string' || !isAbsolute(options.path)) {
      migrationError('WAL_MIGRATION_INVALID', 'barrier journal path must be absolute');
    }
    this.path = resolve(options.path);
    if (existsSync(this.path)) {
      const status = lstatSync(this.path);
      if (status.isSymbolicLink() || !status.isFile()) {
        migrationError('WAL_MIGRATION_INVALID', 'barrier journal must be a regular non-symlink file');
      }
    }
  }

  async load(barrierId: Uint8Array): Promise<WalGenesisBarrierJournalStateV1 | null> {
    const id = fixed(barrierId, 32, 'barrierId');
    await this.queue;
    const file = await this.read();
    const raw = file.states[hex(id)];
    if (raw === undefined) return null;
    return {
      barrierId: id,
      bundleDigest: Uint8Array.from(Buffer.from(raw.bundleDigest, 'hex')),
      writesPaused: raw.writesPaused,
      persistedArtifactKeys: [...raw.persistedArtifactKeys],
      shadowCursor: raw.shadowCursor,
      writesResumed: raw.writesResumed,
      completed: raw.completed,
      aborted: raw.aborted,
    };
  }

  save(state: WalGenesisBarrierJournalStateV1): Promise<void> {
    const operation = this.queue.then(async () => {
      const file = await this.read();
      file.states[hex(fixed(state.barrierId, 32, 'state.barrierId'))] = {
        bundleDigest: hex(fixed(state.bundleDigest, 32, 'state.bundleDigest')),
        writesPaused: state.writesPaused === true,
        persistedArtifactKeys: [...new Set(state.persistedArtifactKeys.map(value => text(value, 'artifact key')))],
        shadowCursor: state.shadowCursor === null ? null : text(state.shadowCursor, 'shadow cursor'),
        writesResumed: state.writesResumed === true,
        completed: state.completed === true,
        aborted: state.aborted === true,
      };
      await this.write(file);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<JsonBarrierStateV1> {
    if (!existsSync(this.path)) return { version: 1, states: {} };
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as JsonBarrierStateV1;
      if (value?.version !== 1 || !value.states || typeof value.states !== 'object' || Array.isArray(value.states)) {
        migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal root is invalid');
      }
      for (const [id, raw] of Object.entries(value.states)) {
        if (
          !raw
          || typeof raw !== 'object'
          || Array.isArray(raw)
          || !/^[0-9a-f]{64}$/.test(id)
          || !/^[0-9a-f]{64}$/.test(raw.bundleDigest)
        ) {
          migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal has an invalid digest');
        }
        if (
          typeof raw.writesPaused !== 'boolean'
          || !Array.isArray(raw.persistedArtifactKeys)
          || raw.persistedArtifactKeys.some(key => typeof key !== 'string')
          || (raw.shadowCursor !== null && typeof raw.shadowCursor !== 'string')
          || typeof raw.writesResumed !== 'boolean'
          || typeof raw.completed !== 'boolean'
          || typeof raw.aborted !== 'boolean'
        ) {
          migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'barrier journal has invalid artifact state');
        }
      }
      return value;
    } catch (error) {
      if (error instanceof WalMigrationError) throw error;
      migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'failed to read barrier journal', error);
    }
  }

  private async write(state: JsonBarrierStateV1): Promise<void> {
    const parent = dirname(this.path);
    const temporary = `${this.path}.tmp`;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.options.transactionHook?.('before-rename');
    await rename(temporary, this.path);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await this.options.transactionHook?.('after-rename');
  }
}
