import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  assertRfc64FilesystemOwnerSyncV1,
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
} from './rfc64/secure-filesystem-policy-v1.js';
import {
  assertOwnedSqliteHeaderIdentityV1,
  fsyncOwnedSqliteFileAndDirectoryV1,
  loadOwnedSqliteModuleV1,
  readOwnedSqlitePragmaIntegerV1,
  secureOwnedSqliteFileSetV1,
  type OwnedSqliteModuleV1,
} from './sqlite/owned-sqlite-v1.js';
import {
  VerifiedGraphScopedFinalizationEvidenceCodec,
  type VerifiedGraphScopedFinalizationEvidence,
} from './finalization-graph-envelope.js';
import {
  FINALIZATION_INBOX_DATABASE_FILENAME,
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryHealth,
  type FinalizationRecoveryReceiveInput,
  type FinalizationRecoveryReceiveResult,
  type FinalizationRecoveryState,
  type FinalizationRecoveryStore,
  type FinalizationRecoveryVerifyResult,
} from './finalization-recovery-store.js';

const APPLICATION_ID = 0x444b4649; // DKFI
const USER_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PER_PEER = 32;
const DEFAULT_MAX_PER_CONTEXT_GRAPH = 64;
const DEFAULT_RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_ENTRIES = 128;
const DEFAULT_MAX_TERMINAL_BYTES = 16 * 1024 * 1024;
const LIVE_STATES = new Set<FinalizationRecoveryState>(['RECEIVED', 'VERIFIED']);
const TERMINAL_STATES = new Set<FinalizationRecoveryState>([
  'SETTLED',
  'SUPERSEDED',
  'REJECTED',
  'UNSUPPORTED',
]);

const DDL = `
CREATE TABLE finalization_inbox_v1 (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('RECEIVED','VERIFIED','SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
  ),
  chain_id TEXT NOT NULL,
  context_graph_id TEXT NOT NULL,
  source_peer_id TEXT,
  ual TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  assertion_version TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  ka_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  target_context_graph_id TEXT,
  block_number INTEGER,
  block_hash TEXT,
  tx_index INTEGER,
  publisher_address TEXT,
  author_address TEXT,
  envelope_sha256 TEXT NOT NULL,
  raw_envelope BLOB NOT NULL,
  verified_evidence_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    state NOT IN ('VERIFIED','SETTLED')
    OR (
      block_number IS NOT NULL
      AND block_hash IS NOT NULL
      AND tx_index IS NOT NULL
      AND publisher_address IS NOT NULL
      AND verified_evidence_json IS NOT NULL
    )
  )
) STRICT;
CREATE INDEX finalization_inbox_live_ka_v1
  ON finalization_inbox_v1(chain_id, context_graph_id, ual, ka_id, state, updated_at);
CREATE INDEX finalization_inbox_state_time_v1
  ON finalization_inbox_v1(state, updated_at);
`;

export interface SqliteFinalizationRecoveryStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEnvelopeBytes?: number;
  maxPerPeer?: number;
  maxPerContextGraph?: number;
  rawTtlMs?: number;
  terminalTtlMs?: number;
  maxTerminalEntries?: number;
  maxTerminalBytes?: number;
  now?: () => number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  return readOwnedSqlitePragmaIntegerV1(database, pragma, 'Finalization inbox');
}

function preparePath(dataDir: string): string {
  const root = resolve(dataDir);
  const path = resolve(root, FINALIZATION_INBOX_DATABASE_FILENAME);
  const relativePath = relative(root, path);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error('Finalization inbox path escapes the DKG data directory');
  }
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Finalization inbox data directory must be a real directory');
  }
  assertRfc64FilesystemOwnerSyncV1(root);
  if (process.platform !== 'win32') {
    applyRfc64OwnerOnlyPermissionsSyncV1(
      root,
      RFC64_SECURE_DIRECTORY_MODE_V1,
      { entryKind: 'directory' },
    );
  }
  secureOwnedSqliteFileSetV1(path, 'Finalization inbox');
  return path;
}

function schemaObjects(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
     ORDER BY name`,
  ).all();
  return new Map(rows.map((row) => [String(row.name), normalizeSql(String(row.sql))]));
}

function expectedSchema(Database: OwnedSqliteModuleV1['DatabaseSync']): Map<string, string> {
  const memory = new Database(':memory:');
  try {
    memory.exec(DDL);
    return schemaObjects(memory);
  } finally {
    memory.close();
  }
}

function verifySchema(database: DatabaseSync, expected: Map<string, string>): void {
  if (
    readPragmaInteger(database, 'application_id') !== APPLICATION_ID
    || readPragmaInteger(database, 'user_version') !== USER_VERSION
  ) {
    throw new Error('Finalization inbox has a foreign or unsupported database identity');
  }
  const actual = schemaObjects(database);
  if (
    actual.size !== expected.size
    || [...expected].some(([name, sql]) => actual.get(name) !== sql)
  ) {
    throw new Error('Finalization inbox exact schema verification failed');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new Error('Finalization inbox foreign-key verification failed');
  }
  const quickCheck = database.prepare('PRAGMA quick_check').all();
  if (
    quickCheck.length !== 1
    || String(Object.values(quickCheck[0]!)[0]).toLowerCase() !== 'ok'
  ) {
    throw new Error('Finalization inbox SQLite integrity verification failed');
  }
  database.prepare('SELECT * FROM finalization_inbox_v1').all().forEach(rowToEntry);
}

function applyRuntimePragmas(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
  `);
  const mode = database.prepare('PRAGMA journal_mode = WAL').get();
  if (String(mode?.journal_mode).toLowerCase() !== 'wal') {
    throw new Error('Finalization inbox refused journal_mode=WAL');
  }
  const expected = new Map([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
  ]);
  for (const [pragma, value] of expected) {
    if (readPragmaInteger(database, pragma) !== value) {
      throw new Error(`Finalization inbox refused PRAGMA ${pragma}=${value}`);
    }
  }
}

function initializeFresh(database: DatabaseSync, path: string): void {
  const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
  database.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
  if (String(mode?.journal_mode).toLowerCase() !== 'delete') {
    throw new Error('Finalization inbox refused durable bootstrap journal mode');
  }
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (
      readPragmaInteger(database, 'application_id') !== 0
      || readPragmaInteger(database, 'user_version') !== 0
      || schemaObjects(database).size !== 0
    ) {
      throw new Error('Finalization inbox lost its pristine identity before initialization');
    }
    database.exec(DDL);
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${USER_VERSION}`);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain initialization failure */ }
    }
    throw error;
  }
  applyRfc64OwnerOnlyPermissionsSyncV1(
    path,
    RFC64_SECURE_FILE_MODE_V1,
    { entryKind: 'file' },
  );
  fsyncOwnedSqliteFileAndDirectoryV1(path);
}

function asSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Finalization inbox row has invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rowToEntry(row: Record<string, unknown>): FinalizationRecoveryEntry {
  const state = String(row.state) as FinalizationRecoveryState;
  if (!LIVE_STATES.has(state) && !TERMINAL_STATES.has(state)) {
    throw new Error('Finalization inbox row has invalid state');
  }
  const raw = row.raw_envelope;
  if (!(raw instanceof Uint8Array)) throw new Error('Finalization inbox row has invalid envelope');
  const envelopeSha256 = String(row.envelope_sha256);
  if (!/^[0-9a-f]{64}$/.test(envelopeSha256) || sha256(raw) !== envelopeSha256) {
    throw new Error('Finalization inbox row has invalid envelope integrity');
  }
  const verifiedEvidence = row.verified_evidence_json === null
    ? undefined
    : VerifiedGraphScopedFinalizationEvidenceCodec.parse(
      JSON.parse(String(row.verified_evidence_json)),
    );
  const evidenceColumns = [
    row.block_number,
    row.block_hash,
    row.tx_index,
    row.publisher_address,
    row.author_address,
  ];
  if (!verifiedEvidence && evidenceColumns.some((value) => value !== null)) {
    throw new Error('Finalization inbox row has provenance without verified evidence');
  }
  if (verifiedEvidence) {
    const storedAuthor = optionalString(row.author_address)?.toLowerCase();
    if (
      asSafeInteger(row.block_number, 'block_number') !== verifiedEvidence.blockNumber
      || String(row.block_hash).toLowerCase() !== verifiedEvidence.blockHash.toLowerCase()
      || asSafeInteger(row.tx_index, 'tx_index') !== verifiedEvidence.txIndex
      || String(row.publisher_address).toLowerCase()
        !== verifiedEvidence.publisherAddress.toLowerCase()
      || storedAuthor !== verifiedEvidence.authorAddress?.toLowerCase()
    ) {
      throw new Error('Finalization inbox row has inconsistent verified provenance');
    }
  }
  return {
    key: String(row.key),
    state,
    chainId: String(row.chain_id),
    contextGraphId: String(row.context_graph_id),
    ...(optionalString(row.source_peer_id) ? { sourcePeerId: String(row.source_peer_id) } : {}),
    ual: String(row.ual),
    txHash: String(row.tx_hash),
    assertionVersion: String(row.assertion_version),
    merkleRoot: String(row.merkle_root),
    kaId: String(row.ka_id),
    batchId: String(row.batch_id),
    ...(optionalString(row.target_context_graph_id)
      ? { targetContextGraphId: String(row.target_context_graph_id) }
      : {}),
    envelopeSha256,
    rawMessage: new Uint8Array(raw),
    ...(verifiedEvidence ? { verifiedEvidence } : {}),
    attemptCount: asSafeInteger(row.attempt_count, 'attempt_count'),
    ...(row.next_attempt_at === null
      ? {}
      : { nextAttemptAt: asSafeInteger(row.next_attempt_at, 'next_attempt_at') }),
    ...(optionalString(row.last_error) ? { lastError: String(row.last_error) } : {}),
    createdAt: asSafeInteger(row.created_at, 'created_at'),
    updatedAt: asSafeInteger(row.updated_at, 'updated_at'),
  };
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameEvidence(
  left: VerifiedGraphScopedFinalizationEvidence,
  right: VerifiedGraphScopedFinalizationEvidence,
): boolean {
  return VerifiedGraphScopedFinalizationEvidenceCodec.same(left, right);
}

export class SqliteFinalizationRecoveryStore implements FinalizationRecoveryStore {
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #maxEntries: number;
  readonly #maxTotalBytes: number;
  readonly #maxEnvelopeBytes: number;
  readonly #maxPerPeer: number;
  readonly #maxPerContextGraph: number;
  readonly #rawTtlMs: number;
  readonly #terminalTtlMs: number;
  readonly #maxTerminalEntries: number;
  readonly #maxTerminalBytes: number;
  readonly #now: () => number;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    options: SqliteFinalizationRecoveryStoreOptions,
  ) {
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.#maxEnvelopeBytes = positiveInteger(options.maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES);
    this.#maxPerPeer = positiveInteger(options.maxPerPeer, DEFAULT_MAX_PER_PEER);
    this.#maxPerContextGraph = positiveInteger(
      options.maxPerContextGraph,
      DEFAULT_MAX_PER_CONTEXT_GRAPH,
    );
    this.#rawTtlMs = positiveInteger(options.rawTtlMs, DEFAULT_RAW_TTL_MS);
    this.#terminalTtlMs = positiveInteger(options.terminalTtlMs, DEFAULT_TERMINAL_TTL_MS);
    this.#maxTerminalEntries = positiveInteger(
      options.maxTerminalEntries,
      DEFAULT_MAX_TERMINAL_ENTRIES,
    );
    this.#maxTerminalBytes = positiveInteger(
      options.maxTerminalBytes,
      DEFAULT_MAX_TERMINAL_BYTES,
    );
    this.#now = options.now ?? Date.now;
  }

  static async open(
    dataDir: string,
    options: SqliteFinalizationRecoveryStoreOptions = {},
  ): Promise<SqliteFinalizationRecoveryStore> {
    const path = preparePath(dataDir);
    const fresh = !existsSync(path);
    const sqlite = await loadOwnedSqliteModuleV1('Durable finalization recovery');
    if (!fresh) {
      assertOwnedSqliteHeaderIdentityV1(
        path,
        APPLICATION_ID,
        USER_VERSION,
        'Finalization inbox',
      );
    }
    const database = new sqlite.DatabaseSync(path);
    try {
      const expected = expectedSchema(sqlite.DatabaseSync);
      if (fresh) initializeFresh(database, path);
      verifySchema(database, expected);
      applyRuntimePragmas(database);
      secureOwnedSqliteFileSetV1(path, 'Finalization inbox');
      return new SqliteFinalizationRecoveryStore(path, database, options);
    } catch (error) {
      try { database.close(); } catch { /* retain open failure */ }
      throw error;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  receive(input: FinalizationRecoveryReceiveInput): Promise<FinalizationRecoveryReceiveResult> {
    if (this.#closed || this.#closing) return Promise.resolve({ status: 'closed' });
    return this.mutate(() => {
      if (this.#closed) return { status: 'closed' };
      if (input.rawMessage.byteLength > this.#maxEnvelopeBytes) return { status: 'capacity' };
      this.prune();
      const existingRow = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(input.key);
      const digest = sha256(input.rawMessage);
      if (existingRow) {
        const existing = rowToEntry(existingRow);
        if (
          existing.envelopeSha256 !== digest
          || !Buffer.from(existing.rawMessage).equals(Buffer.from(input.rawMessage))
          || existing.sourcePeerId !== input.sourcePeerId
          || existing.chainId !== input.chainId
          || existing.contextGraphId !== input.contextGraphId
          || existing.ual !== input.ual
          || existing.txHash.toLowerCase() !== input.txHash.toLowerCase()
        ) return { status: 'conflict' };
        return { status: 'existing', entry: existing };
      }
      if (!this.hasCapacity(input)) return { status: 'capacity' };
      const now = this.#now();
      this.transaction(() => {
        this.database.prepare(`
          INSERT INTO finalization_inbox_v1 (
            key, state, chain_id, context_graph_id, source_peer_id, ual, tx_hash,
            assertion_version, merkle_root, ka_id, batch_id, target_context_graph_id,
            envelope_sha256, raw_envelope, created_at, updated_at
          ) VALUES (?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.key,
          input.chainId,
          input.contextGraphId,
          input.sourcePeerId ?? null,
          input.ual,
          input.txHash.toLowerCase(),
          input.assertionVersion,
          input.merkleRoot.toLowerCase(),
          input.kaId,
          input.batchId,
          input.targetContextGraphId ?? null,
          digest,
          Buffer.from(input.rawMessage),
          now,
          now,
        );
      });
      const row = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(input.key);
      if (!row) throw new Error('Finalization inbox insert returned no row');
      return { status: 'inserted', entry: rowToEntry(row) };
    });
  }

  markVerified(
    key: string,
    evidence: VerifiedGraphScopedFinalizationEvidence,
  ): Promise<FinalizationRecoveryVerifyResult> {
    if (this.#closed || this.#closing) return Promise.resolve({ status: 'closed' });
    return this.mutate(() => {
      if (this.#closed) return { status: 'closed' };
      const row = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!row) return { status: 'missing' };
      const current = rowToEntry(row);
      if (current.verifiedEvidence) {
        return sameEvidence(current.verifiedEvidence, evidence)
          ? { status: 'existing', entry: current }
          : { status: 'conflict' };
      }
      if (current.state !== 'RECEIVED') return { status: 'conflict' };
      if (
        current.txHash.toLowerCase() !== evidence.transactionHash.toLowerCase()
        || current.assertionVersion !== evidence.assertionVersion
      ) return { status: 'conflict' };
      this.transaction(() => {
        this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = 'VERIFIED',
              block_number = ?,
              block_hash = ?,
              tx_index = ?,
              publisher_address = ?,
              author_address = ?,
              verified_evidence_json = ?,
              updated_at = ?
          WHERE key = ? AND state = 'RECEIVED' AND verified_evidence_json IS NULL
        `).run(
          evidence.blockNumber,
          evidence.blockHash,
          evidence.txIndex,
          evidence.publisherAddress,
          evidence.authorAddress ?? null,
          JSON.stringify(evidence),
          this.#now(),
          key,
        );
      });
      const updated = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!updated) return { status: 'missing' };
      const entry = rowToEntry(updated);
      return entry.verifiedEvidence && sameEvidence(entry.verifiedEvidence, evidence)
        ? { status: 'verified', entry }
        : { status: 'conflict' };
    });
  }

  async listForKnowledgeAsset(input: {
    chainId: string;
    contextGraphId: string;
    ual: string;
    kaId: string;
  }): Promise<FinalizationRecoveryEntry[]> {
    if (this.#closed || this.#closing) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    return this.database.prepare(`
      SELECT * FROM finalization_inbox_v1
      WHERE chain_id = ? AND context_graph_id = ? AND ual = ? AND ka_id = ?
        AND state IN ('RECEIVED','VERIFIED')
      ORDER BY created_at, key
    `).all(input.chainId, input.contextGraphId, input.ual, input.kaId).map(rowToEntry);
  }

  /** Bounded diagnostic/test snapshot; raw bytes never cross the HTTP status surface. */
  async list(): Promise<FinalizationRecoveryEntry[]> {
    if (this.#closed || this.#closing) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    return this.database.prepare(
      'SELECT * FROM finalization_inbox_v1 ORDER BY created_at, key',
    ).all().map(rowToEntry);
  }

  transition(
    key: string,
    state: 'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED',
    lastError?: string,
  ): Promise<boolean> {
    if (this.#closed || this.#closing) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => {
        const now = this.#now();
        const result = this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = ?, last_error = ?, next_attempt_at = NULL, updated_at = ?
          WHERE key = ? AND state IN ('RECEIVED','VERIFIED')
        `).run(state, lastError ?? null, now, key);
        changed = result.changes > 0;
        this.pruneWithinTransaction(now);
      });
      return changed;
    });
  }

  recordAttempt(key: string, lastError?: string, nextAttemptAt?: number): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve();
    return this.mutate(() => {
      if (this.#closed) return;
      this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET attempt_count = attempt_count + 1,
            last_error = ?,
            next_attempt_at = ?,
            updated_at = ?
        WHERE key = ? AND state IN ('RECEIVED','VERIFIED')
      `).run(lastError ?? null, nextAttemptAt ?? null, this.#now(), key);
    });
  }

  async health(): Promise<FinalizationRecoveryHealth> {
    if (this.#closing) {
      return {
        available: false,
        closed: false,
        degradedReason: 'closing',
        stateCounts: {},
        livePayloadBytes: 0,
      };
    }
    await this.#mutationTail;
    if (this.#closed) {
      return { available: false, closed: true, degradedReason: 'closed', stateCounts: {}, livePayloadBytes: 0 };
    }
    const counts = this.database.prepare(
      'SELECT state, COUNT(*) AS count FROM finalization_inbox_v1 GROUP BY state',
    ).all();
    const stateCounts: Partial<Record<FinalizationRecoveryState, number>> = {};
    for (const row of counts) stateCounts[String(row.state) as FinalizationRecoveryState] = Number(row.count);
    const live = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes,
             MIN(created_at) AS oldest
      FROM finalization_inbox_v1 WHERE state IN ('RECEIVED','VERIFIED')
    `).get();
    const liveEntries = Number(live?.count ?? 0);
    const livePayloadBytes = Number(live?.bytes ?? 0);
    const oldest = typeof live?.oldest === 'number' ? live.oldest : undefined;
    const graphCapacity = this.database.prepare(`
      SELECT COALESCE(MAX(count), 0) AS count FROM (
        SELECT COUNT(*) AS count FROM finalization_inbox_v1
        WHERE state IN ('RECEIVED','VERIFIED')
        GROUP BY context_graph_id
      )
    `).get();
    const peerCapacity = this.database.prepare(`
      SELECT COALESCE(MAX(count), 0) AS count FROM (
        SELECT COUNT(*) AS count FROM finalization_inbox_v1
        WHERE state IN ('RECEIVED','VERIFIED') AND source_peer_id IS NOT NULL
        GROUP BY source_peer_id
      )
    `).get();
    const capacityExhausted = liveEntries >= this.#maxEntries
      || livePayloadBytes >= this.#maxTotalBytes
      || Number(graphCapacity?.count ?? 0) >= this.#maxPerContextGraph
      || Number(peerCapacity?.count ?? 0) >= this.#maxPerPeer;
    return {
      available: true,
      closed: false,
      ready: !capacityExhausted,
      ...(capacityExhausted ? { degradedReason: 'capacity-exhausted' } : {}),
      stateCounts,
      livePayloadBytes,
      ...(oldest === undefined ? {} : { oldestPendingAgeMs: Math.max(0, this.#now() - oldest) }),
    };
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#mutationTail;
      try {
        this.database.exec('PRAGMA busy_timeout = 0');
        // Compaction is not a durability boundary: FULL commits make the WAL
        // recoverable. A live prepared statement can make checkpointing return
        // SQLITE_LOCKED, so connection close remains the mandatory boundary.
        try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retain WAL */ }
        this.database.close();
        this.#closed = true;
        fsyncOwnedSqliteFileAndDirectoryV1(this.databasePath);
      } finally {
        this.#closing = false;
      }
    })();
    return this.#closePromise;
  }

  private mutate<T>(operation: () => T): Promise<T> {
    const run = this.#mutationTail.catch(() => undefined).then(operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private transaction(operation: () => void): void {
    let open = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      open = true;
      operation();
      this.database.exec('COMMIT');
      open = false;
    } catch (error) {
      if (open) {
        try { this.database.exec('ROLLBACK'); } catch { /* retain transaction failure */ }
      }
      throw error;
    }
  }

  private prune(): void {
    const now = this.#now();
    this.transaction(() => {
      this.pruneWithinTransaction(now);
    });
  }

  private pruneWithinTransaction(now: number): void {
    this.database.prepare(
      `DELETE FROM finalization_inbox_v1
       WHERE state = 'RECEIVED' AND updated_at < ?`,
    ).run(now - this.#rawTtlMs);
    this.database.prepare(
      `DELETE FROM finalization_inbox_v1
       WHERE state IN ('SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED') AND updated_at < ?`,
    ).run(now - this.#terminalTtlMs);
    this.database.prepare(`
      DELETE FROM finalization_inbox_v1
      WHERE key IN (
        SELECT key FROM (
          SELECT key,
                 ROW_NUMBER() OVER (ORDER BY updated_at DESC, key DESC) AS row_number,
                 SUM(length(raw_envelope)) OVER (
                   ORDER BY updated_at DESC, key DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumulative_bytes
          FROM finalization_inbox_v1
          WHERE state IN ('SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
        )
        WHERE row_number > ? OR cumulative_bytes > ?
      )
    `).run(this.#maxTerminalEntries, this.#maxTerminalBytes);
  }

  private hasCapacity(input: FinalizationRecoveryReceiveInput): boolean {
    const live = this.database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes
      FROM finalization_inbox_v1 WHERE state IN ('RECEIVED','VERIFIED')
    `).get();
    if (
      Number(live?.count ?? 0) >= this.#maxEntries
      || Number(live?.bytes ?? 0) + input.rawMessage.byteLength > this.#maxTotalBytes
    ) return false;
    const graphCount = this.database.prepare(`
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE state IN ('RECEIVED','VERIFIED') AND context_graph_id = ?
    `).get(input.contextGraphId);
    if (Number(graphCount?.count ?? 0) >= this.#maxPerContextGraph) return false;
    if (input.sourcePeerId) {
      const peerCount = this.database.prepare(`
        SELECT COUNT(*) AS count FROM finalization_inbox_v1
        WHERE state IN ('RECEIVED','VERIFIED') AND source_peer_id = ?
      `).get(input.sourcePeerId);
      if (Number(peerCount?.count ?? 0) >= this.#maxPerPeer) return false;
    }
    return true;
  }
}

export async function openSqliteFinalizationRecoveryStore(
  dataDir: string,
  options: SqliteFinalizationRecoveryStoreOptions = {},
): Promise<SqliteFinalizationRecoveryStore> {
  return SqliteFinalizationRecoveryStore.open(dataDir, options);
}
