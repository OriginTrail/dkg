import { existsSync, lstatSync } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { bytesEqualV1 } from '../rdf/keys.js';
import { migrationError, WalMigrationError } from './errors.js';
import type {
  WalBackfillCompleteObjectV1,
  WalBackfillJournalV1,
  WalBackfillLocalLaneV1,
  WalBackfillOperationsV1,
  WalBackfillPathV1,
  WalBackfillPlanV1,
  WalBackfillPlanLaneV1,
  WalBackfillRunResultV1,
  WalBackfillStageV1,
  WalBackfillTargetLaneV1,
  WalBackfillTargetParityV1,
} from './types.js';

const STAGES = Object.freeze(['BASELINE', 'DELTA', 'REPLAY', 'VERIFY'] as const);
const STAGE_SET = new Set<string>(STAGES);
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function fixed(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function u64(value: bigint, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be an unsigned 64-bit integer`);
  }
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function text(value: string, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.normalize('NFC') !== value) {
    migrationError('WAL_MIGRATION_INVALID', `${label} must be non-empty NFC text of at most ${maximum} characters`);
  }
  return value;
}

function normalizeTarget(target: WalBackfillTargetLaneV1): WalBackfillTargetLaneV1 {
  const objectCount = u64(target.objectCount, 'target.objectCount');
  const compactionFloor = u64(target.compactionFloor, 'target.compactionFloor');
  if (compactionFloor > objectCount) {
    migrationError('WAL_MIGRATION_INVALID', 'target compaction floor exceeds its object count');
  }
  return {
    namespaceId: fixed(target.namespaceId, 32, 'target.namespaceId'),
    writerId: fixed(target.writerId, 20, 'target.writerId'),
    writerEpoch: u64(target.writerEpoch, 'target.writerEpoch'),
    checkpointId: fixed(target.checkpointId, 32, 'target.checkpointId'),
    objectSetRoot: fixed(target.objectSetRoot, 32, 'target.objectSetRoot'),
    objectCount,
    compactionFloor,
    baselineSnapshotObjectId: target.baselineSnapshotObjectId === null
      ? null
      : fixed(target.baselineSnapshotObjectId, 32, 'target.baselineSnapshotObjectId'),
    genesisBaseline: target.genesisBaseline === true,
  };
}

function normalizeLocal(local: WalBackfillLocalLaneV1): WalBackfillLocalLaneV1 {
  if (!local || typeof local.present !== 'boolean' || typeof local.completeWal !== 'boolean') {
    migrationError('WAL_MIGRATION_INVALID', 'local lane inspection is invalid');
  }
  if (!['complete', 'missing', 'corrupt'].includes(local.projection)) {
    migrationError('WAL_MIGRATION_INVALID', 'local projection status is invalid');
  }
  if (!local.present) {
    if (local.writerEpoch !== null || local.checkpointId !== null || local.objectCount !== 0n || local.completeWal) {
      migrationError('WAL_MIGRATION_INVALID', 'absent local lane carries contradictory WAL state');
    }
  }
  return {
    present: local.present,
    writerEpoch: local.writerEpoch === null ? null : u64(local.writerEpoch, 'local.writerEpoch'),
    objectCount: u64(local.objectCount, 'local.objectCount'),
    checkpointId: local.checkpointId === null ? null : fixed(local.checkpointId, 32, 'local.checkpointId'),
    completeWal: local.completeWal,
    projection: local.projection,
  };
}

function choosePath(
  target: WalBackfillTargetLaneV1,
  local: WalBackfillLocalLaneV1,
): WalBackfillPathV1 {
  if (local.completeWal && local.projection !== 'complete') return 'PROJECTION_REBUILD';
  if (!local.present && target.genesisBaseline) return 'GENESIS_BOOTSTRAP';
  const belowFloor = !local.present
    ? target.compactionFloor > 0n
    : local.writerEpoch! < target.writerEpoch || (
      local.writerEpoch === target.writerEpoch && local.objectCount < target.compactionFloor
    );
  if (belowFloor) {
    if (target.baselineSnapshotObjectId === null) {
      migrationError(
        'WAL_MIGRATION_INCOMPLETE_TARGET',
        'below-floor target lane has no authenticated snapshot baseline',
      );
    }
    return 'SNAPSHOT_PLUS_DELTA';
  }
  return 'INCREMENTAL';
}

export async function planWalBackfillV1(input: {
  readonly sessionId: string;
  readonly targetVectorId: Uint8Array;
  readonly targets: readonly WalBackfillTargetLaneV1[];
  readonly inspectLocal: (
    target: WalBackfillTargetLaneV1,
  ) => WalBackfillLocalLaneV1 | Promise<WalBackfillLocalLaneV1>;
}): Promise<WalBackfillPlanV1> {
  const sessionId = text(input.sessionId, 'sessionId', 256);
  const targetVectorId = fixed(input.targetVectorId, 32, 'targetVectorId');
  if (!Array.isArray(input.targets) || typeof input.inspectLocal !== 'function') {
    migrationError('WAL_MIGRATION_INVALID', 'backfill targets and local inspector are required');
  }
  const seen = new Set<string>();
  const lanes: WalBackfillPlanLaneV1[] = [];
  for (const value of input.targets) {
    const target = normalizeTarget(value);
    const laneKey = `${hex(target.namespaceId)}:${hex(target.writerId)}`;
    if (seen.has(laneKey)) {
      migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'backfill target repeats a namespace/writer lane');
    }
    seen.add(laneKey);
    const local = normalizeLocal(await input.inspectLocal(target));
    lanes.push({ laneKey, path: choosePath(target, local), target });
  }
  lanes.sort((left, right) => left.laneKey.localeCompare(right.laneKey));
  return { sessionId, targetVectorId, lanes };
}

function objectBytes(objects: readonly WalBackfillCompleteObjectV1[]): bigint {
  return objects.reduce((total, object) => total + BigInt(object.canonicalBytes.length), 0n);
}

function validateObjects(objects: readonly WalBackfillCompleteObjectV1[]): WalBackfillCompleteObjectV1[] {
  if (!Array.isArray(objects)) {
    migrationError('WAL_MIGRATION_INVALID', 'backfill object source did not return an array');
  }
  const seen = new Set<string>();
  return objects.map((object, index) => {
    const objectId = fixed(object.objectId, 32, `objects[${index}].objectId`);
    if (!(object.canonicalBytes instanceof Uint8Array) || object.canonicalBytes.length === 0) {
      migrationError('WAL_MIGRATION_INVALID', `objects[${index}].canonicalBytes cannot be empty`);
    }
    const key = hex(objectId);
    if (seen.has(key)) migrationError('WAL_MIGRATION_DUPLICATE_STATE', 'backfill batch repeats a WalObjectId');
    seen.add(key);
    return { objectId, canonicalBytes: copy(object.canonicalBytes) };
  });
}

function completeParity(value: WalBackfillTargetParityV1): boolean {
  return value.objectRoot
    && value.completeObjects
    && value.rdf
    && value.conflicts
    && value.tombstones
    && value.vm;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) migrationError('WAL_MIGRATION_ABORTED', 'backfill execution was aborted');
}

export class WalBackfillCoordinatorV1 {
  constructor(
    private readonly operations: WalBackfillOperationsV1,
    private readonly journal: WalBackfillJournalV1,
  ) {
    if (!operations || !journal) {
      migrationError('WAL_MIGRATION_INVALID', 'backfill operations and journal are required');
    }
  }

  async run(plan: WalBackfillPlanV1, options: { readonly signal?: AbortSignal } = {}): Promise<WalBackfillRunResultV1> {
    text(plan.sessionId, 'plan.sessionId', 256);
    fixed(plan.targetVectorId, 32, 'plan.targetVectorId');
    let networkPayloadBytes = 0n;
    let admittedObjects = 0;
    let completedLanes = 0;
    for (const lane of plan.lanes) {
      assertNotAborted(options.signal);
      let laneNetworkPayloadBytes = 0n;
      const completed = await this.journal.completedStages(plan.sessionId, lane.laneKey);
      if (!completed.has('BASELINE')) {
        let objects: WalBackfillCompleteObjectV1[] = [];
        if (lane.path === 'SNAPSHOT_PLUS_DELTA' || lane.path === 'GENESIS_BOOTSTRAP') {
          objects = validateObjects(await this.operations.fetchBaseline(lane.target));
          laneNetworkPayloadBytes += objectBytes(objects);
        } else if (lane.path === 'PROJECTION_REBUILD') {
          objects = validateObjects(await this.operations.loadLocalObjects(lane.target));
        }
        for (const object of objects) {
          assertNotAborted(options.signal);
          await this.operations.verifyAndAdmit(
            object,
            lane.path === 'PROJECTION_REBUILD' ? 'replay' : 'backfill',
          );
          admittedObjects += 1;
        }
        await this.journal.markCompleted(plan.sessionId, lane.laneKey, 'BASELINE');
      }
      if (!completed.has('DELTA')) {
        if (lane.path !== 'PROJECTION_REBUILD') {
          const objects = validateObjects(await this.operations.fetchDelta(lane.target));
          laneNetworkPayloadBytes += objectBytes(objects);
          for (const object of objects) {
            assertNotAborted(options.signal);
            await this.operations.verifyAndAdmit(object, 'backfill');
            admittedObjects += 1;
          }
        }
        await this.journal.markCompleted(plan.sessionId, lane.laneKey, 'DELTA');
      }
      if (!completed.has('REPLAY')) {
        assertNotAborted(options.signal);
        await this.operations.replayAndMaterialize(lane.target);
        await this.journal.markCompleted(plan.sessionId, lane.laneKey, 'REPLAY');
      }
      if (!completed.has('VERIFY')) {
        assertNotAborted(options.signal);
        const parity = await this.operations.verifyTarget(lane.target);
        if (!completeParity(parity)) {
          migrationError(
            'WAL_MIGRATION_INCOMPLETE_TARGET',
            `backfill lane ${lane.laneKey} did not reach exact WAL/RDF/conflict/tombstone/VM parity`,
          );
        }
        await this.journal.markCompleted(plan.sessionId, lane.laneKey, 'VERIFY');
      }
      networkPayloadBytes += laneNetworkPayloadBytes;
      completedLanes += 1;
    }
    return { sessionId: plan.sessionId, networkPayloadBytes, admittedObjects, completedLanes };
  }
}

interface JournalFileV1 {
  version: 1;
  sessions: Record<string, Record<string, WalBackfillStageV1[]>>;
}

function emptyJournal(): JournalFileV1 {
  return { version: 1, sessions: {} };
}

function parseJournal(value: unknown): JournalFileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'backfill journal root is invalid');
  }
  const raw = value as { version?: unknown; sessions?: unknown };
  if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) {
    migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'backfill journal version or sessions map is invalid');
  }
  const sessions: JournalFileV1['sessions'] = {};
  for (const [sessionId, lanesValue] of Object.entries(raw.sessions)) {
    text(sessionId, 'journal sessionId', 256);
    if (!lanesValue || typeof lanesValue !== 'object' || Array.isArray(lanesValue)) {
      migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'backfill journal lane map is invalid');
    }
    const lanes: Record<string, WalBackfillStageV1[]> = {};
    for (const [laneKey, stagesValue] of Object.entries(lanesValue)) {
      text(laneKey, 'journal laneKey', 256);
      if (!Array.isArray(stagesValue) || stagesValue.some(stage => !STAGE_SET.has(String(stage)))) {
        migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'backfill journal stage list is invalid');
      }
      const stages = [...new Set(stagesValue as WalBackfillStageV1[])];
      stages.sort((left, right) => STAGES.indexOf(left) - STAGES.indexOf(right));
      lanes[laneKey] = stages;
    }
    sessions[sessionId] = lanes;
  }
  return { version: 1, sessions };
}

export interface FileWalBackfillJournalOptionsV1 {
  readonly path: string;
  readonly transactionHook?: (phase: 'before-rename' | 'after-rename') => void | Promise<void>;
}

/** Atomic, fsync-backed resumability journal. It contains no RDF or WAL payload bytes. */
export class FileWalBackfillJournalV1 implements WalBackfillJournalV1 {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileWalBackfillJournalOptionsV1) {
    if (typeof options?.path !== 'string' || !isAbsolute(options.path)) {
      migrationError('WAL_MIGRATION_INVALID', 'backfill journal path must be absolute');
    }
    this.path = resolve(options.path);
    if (existsSync(this.path)) {
      const status = lstatSync(this.path);
      if (status.isSymbolicLink() || !status.isFile()) {
        migrationError('WAL_MIGRATION_INVALID', 'backfill journal must be a regular non-symlink file');
      }
    }
  }

  async completedStages(sessionId: string, laneKey: string): Promise<ReadonlySet<WalBackfillStageV1>> {
    text(sessionId, 'sessionId', 256);
    text(laneKey, 'laneKey', 256);
    await this.queue;
    const state = await this.read();
    return new Set(state.sessions[sessionId]?.[laneKey] ?? []);
  }

  markCompleted(sessionId: string, laneKey: string, stage: WalBackfillStageV1): Promise<void> {
    text(sessionId, 'sessionId', 256);
    text(laneKey, 'laneKey', 256);
    if (!STAGE_SET.has(stage)) migrationError('WAL_MIGRATION_INVALID', 'backfill stage is unsupported');
    const operation = this.queue.then(async () => {
      const state = await this.read();
      const lanes = state.sessions[sessionId] ?? {};
      const stages = new Set(lanes[laneKey] ?? []);
      stages.add(stage);
      lanes[laneKey] = STAGES.filter(value => stages.has(value));
      state.sessions[sessionId] = lanes;
      await this.write(state);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<JournalFileV1> {
    if (!existsSync(this.path)) return emptyJournal();
    try {
      return parseJournal(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof WalMigrationError) throw error;
      migrationError('WAL_MIGRATION_JOURNAL_CONFLICT', 'failed to read backfill journal', error);
    }
  }

  private async write(state: JournalFileV1): Promise<void> {
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
