import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DDL,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
  InventoryV1OpenError,
  normalizeInventoryV1SchemaSql,
  openInventoryV1 as openProductionInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';
import {
  type InventoryV1QuarantineBoundary,
} from '../src/rfc64/inventory-v1/lifecycle-adapter.js';
import { createInventoryV1TestOpener } from '../src/rfc64/inventory-v1/open.js';

const temporaryDirectories: string[] = [];
const CHILD_FIXTURE = resolve(
  import.meta.dirname,
  'fixtures/rfc64-inventory-v1-child.ts',
);
const HOSTILE_SIDECAR_BYTES = Object.freeze({
  journal: Buffer.from('hostile-rfc64-journal-evidence\0\u0000\u0001', 'utf8'),
  wal: Buffer.from('hostile-rfc64-wal-evidence\0\u0001\u0002', 'utf8'),
  shm: Buffer.from('hostile-rfc64-shm-evidence\0\u0003\u0004', 'utf8'),
});

const openInventoryV1 = (dataDirectory: string) => openProductionInventoryV1(
  dataDirectory,
  { quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY },
);

type RecoveryMember = 'journal' | 'wal' | 'shm' | 'main';
type RecoveryManifest =
  | readonly ['main']
  | readonly ['journal', 'main']
  | readonly ['wal', 'main']
  | readonly ['shm', 'main']
  | readonly ['wal', 'shm', 'main'];
type EvidenceHashes = Readonly<Partial<Record<RecoveryMember, string>>>;
type SeededRecoveryTopology = Readonly<{
  generation: string;
  hashes: EvidenceHashes;
}>;

const FULL_RECOVERY_MANIFEST = ['wal', 'shm', 'main'] as const;
type FullRecoveryMember = (typeof FULL_RECOVERY_MANIFEST)[number];
const JOURNAL_RECOVERY_MANIFEST = ['journal', 'main'] as const;
const FULL_MANIFEST_FAULT_BOUNDARIES = [
  'begin.source.wal.file-fsync',
  'begin.source.shm.file-fsync',
  'begin.source.main.file-fsync',
  'begin.inventory-directory.fsync-after-quarantine-root',
  'begin.quarantine-root.fsync-after-generation',
  'begin.marker.write',
  'begin.marker.file-fsync',
  'begin.inventory-directory.fsync-after-marker',
  'resume.source.wal.file-fsync-after-quiescence',
  'resume.source.shm.file-fsync-after-quiescence',
  'resume.source.main.file-fsync-after-quiescence',
  'resume.member.wal.rename',
  'resume.member.wal.file-fsync',
  'resume.member.wal.generation-directory-fsync',
  'resume.member.wal.inventory-directory-fsync',
  'resume.member.shm.rename',
  'resume.member.shm.file-fsync',
  'resume.member.shm.generation-directory-fsync',
  'resume.member.shm.inventory-directory-fsync',
  'resume.member.main.rename',
  'resume.member.main.file-fsync',
  'resume.member.main.generation-directory-fsync',
  'resume.member.main.inventory-directory-fsync',
  'resume.marker.unlink',
  'resume.inventory-directory.fsync-after-marker-unlink',
] as const satisfies readonly InventoryV1QuarantineBoundary[];

const MOVED_PREFIX_FAULT_BOUNDARIES = FULL_RECOVERY_MANIFEST.flatMap((member) => [
  `resume.prefix.${member}.file-fsync`,
  `resume.prefix.${member}.generation-directory-fsync`,
  `resume.prefix.${member}.inventory-directory-fsync`,
] as const) satisfies readonly InventoryV1QuarantineBoundary[];

const JOURNAL_PREFIX_FAULT_BOUNDARIES = [
  'resume.prefix.journal.file-fsync',
  'resume.prefix.journal.generation-directory-fsync',
  'resume.prefix.journal.inventory-directory-fsync',
] as const satisfies readonly InventoryV1QuarantineBoundary[];

const JOURNAL_AUTOMATIC_FAULT_BOUNDARIES = [
  'begin.source.journal.file-fsync',
  'begin.source.main.file-fsync',
  'begin.inventory-directory.fsync-after-quarantine-root',
  'begin.quarantine-root.fsync-after-generation',
  'begin.marker.write',
  'begin.marker.file-fsync',
  'begin.inventory-directory.fsync-after-marker',
  'resume.source.journal.file-fsync-after-quiescence',
  'resume.source.main.file-fsync-after-quiescence',
  'resume.member.journal.rename',
  'resume.member.journal.file-fsync',
  'resume.member.journal.generation-directory-fsync',
  'resume.member.journal.inventory-directory-fsync',
  'resume.member.main.rename',
  'resume.member.main.file-fsync',
  'resume.member.main.generation-directory-fsync',
  'resume.member.main.inventory-directory-fsync',
  'resume.marker.unlink',
  'resume.inventory-directory.fsync-after-marker-unlink',
] as const satisfies readonly InventoryV1QuarantineBoundary[];

function expectedFullManifestTrace(
  boundary: (typeof FULL_MANIFEST_FAULT_BOUNDARIES)[number],
): InventoryV1QuarantineBoundary[] {
  const prefix = FULL_MANIFEST_FAULT_BOUNDARIES.slice(
    0,
    FULL_MANIFEST_FAULT_BOUNDARIES.indexOf(boundary) + 1,
  );
  const resumeStart = FULL_MANIFEST_FAULT_BOUNDARIES.indexOf(
    'resume.source.wal.file-fsync-after-quiescence',
  );
  if (FULL_MANIFEST_FAULT_BOUNDARIES.indexOf(boundary) < resumeStart) {
    return ['target-exclusivity-proven', ...prefix];
  }
  return [
    'target-exclusivity-proven',
    ...prefix.slice(0, resumeStart),
    'target-exclusivity-proven',
    ...prefix.slice(resumeStart),
  ];
}

function temporaryDataDirectory(): string {
  // macOS exposes /var as a symlink to /private/var. Use the canonical test
  // root so the production component-wise no-symlink rule is exercised only
  // by symlinks intentionally created by each test.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-sql1-')));
  temporaryDirectories.push(directory);
  return directory;
}

function databasePath(dataDirectory: string): string {
  return join(dataDirectory, INVENTORY_V1_RELATIVE_PATH);
}

function leasePath(dataDirectory: string): string {
  return join(dirname(databasePath(dataDirectory)), 'inventory-v1.lease.sqlite3');
}

function pragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (row === undefined) throw new Error(`missing PRAGMA ${pragma}`);
  const value = Object.values(row)[0];
  if (typeof value !== 'number') throw new Error(`invalid PRAGMA ${pragma}`);
  return value;
}

function u64be(value: bigint): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(value);
  return encoded;
}

function expectOpenErrorCode(error: unknown, code: InventoryV1OpenError['code']): boolean {
  expect(error).toBeInstanceOf(InventoryV1OpenError);
  expect((error as InventoryV1OpenError).code).toBe(code);
  return true;
}

function expectNoQuarantine(path: string): void {
  expect(existsSync(`${path}.rebuild-required`)).toBe(false);
  expect(existsSync(join(dirname(path), 'quarantine'))).toBe(false);
}

function quarantineGenerations(path: string): string[] {
  const root = join(dirname(path), 'quarantine');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => join(root, name));
}

function recoverySourcePath(path: string, member: RecoveryMember): string {
  return member === 'main' ? path : `${path}-${member}`;
}

function recoveryDestinationPath(generation: string, member: RecoveryMember): string {
  return join(
    generation,
    member === 'main' ? 'inventory-v1.sqlite3' : `inventory-v1.sqlite3-${member}`,
  );
}

function createIncompatibleOwnedInventory(path: string, label: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE wrong_v1 (value TEXT NOT NULL);
      INSERT INTO wrong_v1 VALUES ('${label}');
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
  } finally {
    database.close();
  }
}

async function createCrashedWalIncompatibleOwnedInventory(
  path: string,
  label: string,
): Promise<void> {
  createIncompatibleOwnedInventory(path, label);
  const script = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.DKG_RFC64_CRASHED_WAL_PATH);
database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN; INSERT INTO wrong_v1 VALUES (\'wal-row\'); COMMIT');
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: { ...process.env, DKG_RFC64_CRASHED_WAL_PATH: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      rejectReady(new Error(`crashed-WAL child did not become ready: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `crashed-WAL child exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    });
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  child.kill('SIGKILL');
  expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(existsSync(`${path}-shm`)).toBe(true);
}

async function leaveHotRollbackJournal(
  path: string,
  transactionSql: string,
): Promise<void> {
  const script = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.DKG_RFC64_HOT_JOURNAL_PATH);
database.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
database.exec(process.env.DKG_RFC64_HOT_JOURNAL_SQL);
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: {
      ...process.env,
      DKG_RFC64_HOT_JOURNAL_PATH: path,
      DKG_RFC64_HOT_JOURNAL_SQL: transactionSql,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(() => {
      rejectReady(new Error(`hot-journal child did not become ready: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `hot-journal child exited before ready: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    });
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  child.kill('SIGKILL');
  expect(await exit).toEqual({ code: null, signal: 'SIGKILL' });
  expect(lstatSync(`${path}-journal`).isFile()).toBe(true);
  expect(lstatSync(`${path}-journal`).size).toBeGreaterThan(512);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sourceEvidenceHashes(
  path: string,
  members: RecoveryManifest,
): EvidenceHashes {
  return Object.fromEntries(members.map((member) => [
    member,
    sha256File(recoverySourcePath(path, member)),
  ])) as EvidenceHashes;
}

function seedPendingRecoveryTopology(
  dataDirectory: string,
  members: RecoveryManifest,
  movedPrefix: number,
  label: string,
  hostileSidecars = false,
): SeededRecoveryTopology {
  const path = databasePath(dataDirectory);
  const generation = join(
    dirname(path),
    'quarantine',
    `inventory-v1-1234567890-${String(movedPrefix).padStart(16, '0')}`,
  );
  mkdirSync(generation, { recursive: true });
  createIncompatibleOwnedInventory(path, label);
  for (const member of members) {
    if (member !== 'main') {
      writeFileSync(
        recoverySourcePath(path, member),
        hostileSidecars ? HOSTILE_SIDECAR_BYTES[member] : Buffer.alloc(0),
      );
    }
  }
  const hashes = sourceEvidenceHashes(path, members);
  for (const [index, member] of members.entries()) {
    if (index >= movedPrefix) continue;
    renameSync(recoverySourcePath(path, member), recoveryDestinationPath(generation, member));
  }
  writeFileSync(
    `${path}.rebuild-required`,
    JSON.stringify({ version: 1, quarantineDirectory: generation, members }),
  );
  return { generation, hashes };
}

function evidenceGeneration(path: string): string {
  const generations = quarantineGenerations(path).filter((generation) =>
    existsSync(join(generation, 'inventory-v1.sqlite3')));
  expect(generations).toHaveLength(1);
  return generations[0]!;
}

function assertRecoveredManifestEvidence(
  path: string,
  members: RecoveryManifest,
  label: string,
  expectedGeneration?: string,
  expectedHashes?: EvidenceHashes,
): void {
  expect(existsSync(`${path}.rebuild-required`)).toBe(false);
  const generation = evidenceGeneration(path);
  if (expectedGeneration !== undefined) expect(generation).toBe(expectedGeneration);
  for (const member of members) {
    const destination = recoveryDestinationPath(generation, member);
    expect(lstatSync(destination).isFile()).toBe(true);
    if (expectedHashes?.[member] !== undefined) {
      expect(sha256File(destination)).toBe(expectedHashes[member]);
    } else if (member !== 'main') {
      expect(readFileSync(destination)).toEqual(Buffer.alloc(0));
    }
  }
  if (expectedHashes === undefined) {
    const evidence = new DatabaseSync(
      recoveryDestinationPath(generation, 'main'),
      { readOnly: true },
    );
    try {
      expect(evidence.prepare('SELECT value FROM wrong_v1').get()?.value).toBe(label);
    } finally {
      evidence.close();
    }
  }
}

function assertInitializedInventory(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    expect(pragmaInteger(database, 'application_id')).toBe(INVENTORY_V1_APPLICATION_ID);
    expect(pragmaInteger(database, 'user_version')).toBe(1);
    const rows = database.prepare(
      `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all();
    expect(rows).toHaveLength(Object.keys(INVENTORY_V1_USER_OBJECTS).length);
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.sql).toBe('string');
      expect(normalizeInventoryV1SchemaSql(String(row.sql))).toBe(
        INVENTORY_V1_USER_OBJECTS[String(row.name)],
      );
    }
    expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  } finally {
    database.close();
  }
}

async function startLeaseHolder(path: string): Promise<ChildProcessWithoutNullStreams> {
  const script = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.DKG_RFC64_LEASE_PATH);
database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: { ...process.env, DKG_RFC64_LEASE_PATH: path },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      rejectReady(new Error(`lease holder did not become ready: ${stderr}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`lease holder exited before ready: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
  return child;
}

async function killLeaseHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnInventoryChild(
  mode: 'fault' | 'reopen' | 'contender',
  dataDirectory: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--experimental-sqlite', '--import', 'tsx', CHILD_FIXTURE],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DKG_RFC64_CHILD_MODE: mode,
        DKG_RFC64_CHILD_DATA_DIR: dataDirectory,
        ...extraEnvironment,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

async function collectChild(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return await new Promise<ChildResult>((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('exit', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function waitForChildBoundary(
  child: ChildProcessWithoutNullStreams,
  boundary: InventoryV1QuarantineBoundary,
): Promise<void> {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  await new Promise<void>((resolveBoundary, rejectBoundary) => {
    const timeout = setTimeout(() => {
      rejectBoundary(new Error(
        `child did not reach ${boundary}; stdout=${stdout} stderr=${stderr}`,
      ));
    }, 15_000);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes(`BOUNDARY:${boundary}\n`)) return;
      clearTimeout(timeout);
      resolveBoundary();
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectBoundary(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectBoundary(new Error(
        `child exited before ${boundary}: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    });
  });
}

async function killAtInventoryBoundary(
  dataDirectory: string,
  boundary: InventoryV1QuarantineBoundary,
  tracePath: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<Array<{ boundary: InventoryV1QuarantineBoundary; topology: unknown[] }>> {
  const child = spawnInventoryChild('fault', dataDirectory, {
    DKG_RFC64_CHILD_BOUNDARY: boundary,
    DKG_RFC64_CHILD_TRACE: tracePath,
    ...extraEnvironment,
  });
  await waitForChildBoundary(child, boundary);
  const exitResult = new Promise<ChildResult>((resolveResult, rejectResult) => {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.once('error', rejectResult);
    child.once('exit', (code, signal) => resolveResult({ code, signal, stdout: '', stderr }));
  });
  child.kill('SIGKILL');
  const result = await exitResult;
  expect(result.code).toBeNull();
  expect(result.signal).toBe('SIGKILL');
  if (extraEnvironment.DKG_RFC64_CHILD_PROTECT_EVIDENCE === '1') {
    chmodSync(dirname(databasePath(dataDirectory)), 0o700);
  }
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as {
      boundary: InventoryV1QuarantineBoundary;
      topology: unknown[];
    });
  expect(trace.at(-1)?.boundary).toBe(boundary);
  expect(trace.every((entry) => entry.topology.length > 0)).toBe(true);
  return trace;
}

async function reopenInventoryInFreshProcess(dataDirectory: string): Promise<void> {
  const result = await collectChild(spawnInventoryChild('reopen', dataDirectory));
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  expect(result.stdout).toContain('OPEN\n');
}

async function runContender(dataDirectory: string): Promise<{
  directLease: 'OPEN' | 'BUSY';
  targetTransaction: 'FREE' | 'BUSY';
  lease: 'OPEN' | 'BUSY';
}> {
  const result = await collectChild(spawnInventoryChild('contender', dataDirectory));
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  return JSON.parse(result.stdout.trim()) as {
    directLease: 'OPEN' | 'BUSY';
    targetTransaction: 'FREE' | 'BUSY';
    lease: 'OPEN' | 'BUSY';
  };
}

interface FileOracle {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly sha256: string;
}

function fileOracle(path: string): FileOracle {
  const stat = lstatSync(path);
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(process.platform !== 'win32')('RFC-64 inventory v1 SQLite lifecycle', () => {
  it('initializes the exact owned schema, identity, WAL mode, and private POSIX paths', async () => {
    const dataDirectory = temporaryDataDirectory();
    const foundation = await openInventoryV1(dataDirectory);
    const path = databasePath(dataDirectory);

    expect(foundation.databasePath).toBe(path);
    expect(foundation.closed).toBe(false);
    assertInitializedInventory(path);
    const committedHeader = readFileSync(path).subarray(0, 100);
    expect(committedHeader.subarray(0, 16).toString('binary')).toBe('SQLite format 3\u0000');
    expect(committedHeader.readUInt32BE(68)).toBe(INVENTORY_V1_APPLICATION_ID);
    expect(committedHeader.readUInt32BE(60)).toBe(1);
    if (process.platform !== 'win32') {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(leasePath(dataDirectory)).mode & 0o777).toBe(0o600);
    }

    foundation.close();
    foundation.close();
    expect(foundation.closed).toBe(true);
    if (process.platform !== 'win32') chmodSync(path, 0o666);

    const reopened = await openInventoryV1(dataDirectory);
    assertInitializedInventory(path);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    reopened.close();
    try {
      reopened.quarantineAndRebuild();
      expect.unreachable('closed foundation unexpectedly rebuilt');
    } catch (error) {
      expectOpenErrorCode(error, 'database-closed');
    }
  });

  it('initializes the exact DK6L lease identity and holds it for the foundation lifetime', async () => {
    const dataDirectory = temporaryDataDirectory();
    const foundation = await openInventoryV1(dataDirectory);
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-busy'));
    } finally {
      foundation.close();
    }

    const lease = new DatabaseSync(leasePath(dataDirectory));
    try {
      expect(pragmaInteger(lease, 'application_id')).toBe(0x444b364c);
      expect(pragmaInteger(lease, 'user_version')).toBe(1);
      expect(String(lease.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase()).toBe('delete');
      expect(lease.prepare(
        `SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`,
      ).get()?.count).toBe(0);
    } finally {
      lease.close();
    }

    const reopened = await openInventoryV1(dataDirectory);
    reopened.close();
  });

  it('retains DK6L in fail-stop when the owned target cannot close', async () => {
    const dataDirectory = temporaryDataDirectory();
    const openWithCloseFailure = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: (_close, reason) => {
        if (reason === 'foundation-close') throw new Error('injected target close failure');
        _close();
      },
    });
    const foundation = await openWithCloseFailure(dataDirectory);

    expect(() => foundation.close()).toThrowError(
      expect.objectContaining({ code: 'database-io' }),
    );
    expect(foundation.closed).toBe(false);
    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'database-busy'));
  });

  it('rejects corrupt quarantine before its exclusivity proof and closes as ordinary cleanup', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const initialized = await openInventoryV1(dataDirectory);
    initialized.close();
    const seed = new DatabaseSync(path);
    const zeroU64 = Buffer.alloc(8);
    const oneU64 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
    const sixteenU64 = Buffer.from([0, 0, 0, 0, 0, 0, 0, 16]);
    const chunkSizeU64 = Buffer.from([0, 0, 0, 0, 0, 4, 0, 0]);
    const session = Buffer.alloc(32, 1);
    const scope = Buffer.alloc(32, 2);
    const author = Buffer.alloc(20, 3);
    const head = Buffer.alloc(32, 4);
    seed.prepare('INSERT INTO rfc64_candidate_bucket_loads_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        session, scope, author, head, null, zeroU64, oneU64, zeroU64,
        Buffer.alloc(32), zeroU64, zeroU64,
      );
    seed.prepare('INSERT INTO rfc64_candidate_bucket_rows_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        session, scope, author, head, zeroU64, Buffer.alloc(32, 5),
        Buffer.alloc(32, 6), 'coordinate', zeroU64, 'cg-shared-v1',
        Buffer.alloc(32, 7), Buffer.alloc(32, 8), 'dkg-ka-bundle-v1',
        sixteenU64, chunkSizeU64, oneU64, Buffer.alloc(32, 9),
        Buffer.alloc(32, 10), Buffer.alloc(32, 11),
      );
    const pageSize = pragmaInteger(seed, 'page_size');
    const rowRootPage = seed.prepare(
      "SELECT rootpage FROM sqlite_schema WHERE name = 'rfc64_candidate_bucket_rows_v1'",
    ).get()?.rootpage;
    expect(typeof rowRootPage).toBe('number');
    seed.close();
    const corruptBytes = readFileSync(path);
    corruptBytes[(Number(rowRootPage) - 1) * pageSize] = 0xff;
    writeFileSync(path, corruptBytes);
    const closeReasons: string[] = [];
    const openWithoutDurability = createInventoryV1TestOpener({
      quarantineCapability: null,
      closeTarget: (close, reason) => {
        close();
        closeReasons.push(reason);
      },
    });

    await expect(openWithoutDurability(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );
    expect(closeReasons).toEqual(['failed-open-cleanup']);
    await expect(openWithoutDurability(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );
  });

  it('keeps the test seam and legacy durability override inert outside current test mode', async () => {
    const previousNodeEnvironment = process.env.NODE_ENV;
    const overrideName = 'DKG_RFC64_TEST_DISABLE_QUARANTINE_DURABILITY';
    const previousOverride = process.env[overrideName];
    const unopenedDataDirectory = temporaryDataDirectory();
    let closeHookCalls = 0;
    const guardedOpen = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: () => { closeHookCalls += 1; },
    });
    const openForClose = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: (_close) => {
        closeHookCalls += 1;
        throw new Error('test close hook must be inert');
      },
    });
    const closeFoundation = await openForClose(temporaryDataDirectory());
    try {
      process.env.NODE_ENV = 'production';
      process.env[overrideName] = '1';
      expect(() => createInventoryV1TestOpener()).toThrowError(
        expect.objectContaining({ code: 'database-io' }),
      );
      await expect(guardedOpen(unopenedDataDirectory)).rejects.toSatisfy(
        (error: unknown) => expectOpenErrorCode(error, 'database-io'),
      );
      expect(existsSync(dirname(databasePath(unopenedDataDirectory)))).toBe(false);

      closeFoundation.close();
      expect(closeHookCalls).toBe(0);

      const productionDataDirectory = temporaryDataDirectory();
      const productionPath = databasePath(productionDataDirectory);
      createIncompatibleOwnedInventory(productionPath, 'production-override-inert');
      const productionFoundation = await openProductionInventoryV1(
        productionDataDirectory,
        { quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY },
      );
      productionFoundation.close();
      assertInitializedInventory(productionPath);
    } finally {
      if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnvironment;
      if (previousOverride === undefined) delete process.env[overrideName];
      else process.env[overrideName] = previousOverride;
    }
  });

  it('releases the OS-backed lease when a holder process is killed', async () => {
    const dataDirectory = temporaryDataDirectory();
    const initialized = await openInventoryV1(dataDirectory);
    initialized.close();
    const child = await startLeaseHolder(leasePath(dataDirectory));
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-busy'));
    } finally {
      await killLeaseHolder(child);
    }

    const reopened = await openInventoryV1(dataDirectory);
    reopened.close();
  });

  it('fails closed on foreign, newer, and corrupt lease identities without quarantine', async () => {
    for (const kind of ['foreign', 'newer', 'corrupt'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const leaseFile = leasePath(dataDirectory);
      mkdirSync(dirname(path), { recursive: true });
      const lease = new DatabaseSync(leaseFile);
      lease.exec(kind === 'foreign'
        ? 'PRAGMA application_id = 305419896; PRAGMA user_version = 1;'
        : `PRAGMA application_id = ${0x444b364c}; PRAGMA user_version = ${kind === 'newer' ? 2 : 1};`);
      lease.close();
      if (kind === 'corrupt') truncateSync(leaseFile, 100);
      const before = readFileSync(leaseFile);

      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(
          error,
          kind === 'foreign' ? 'foreign-database' : kind === 'newer' ? 'newer-schema' : 'ambiguous-database',
        ));
      expect(readFileSync(leaseFile)).toEqual(before);
      expect(existsSync(path)).toBe(false);
      expectNoQuarantine(path);
    }
  });

  it('never initializes a pre-existing headerless or zero-zero lease remnant', async () => {
    for (const kind of ['empty', 'zero-zero'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const leaseFile = leasePath(dataDirectory);
      mkdirSync(dirname(path), { recursive: true });
      if (kind === 'empty') {
        writeFileSync(leaseFile, Buffer.alloc(0));
      } else {
        const lease = new DatabaseSync(leaseFile);
        lease.exec('VACUUM');
        lease.close();
      }
      const before = readFileSync(leaseFile);
      const beforeMode = statSync(leaseFile).mode & 0o777;

      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'ambiguous-database'));

      expect(readFileSync(leaseFile)).toEqual(before);
      if (process.platform !== 'win32') expect(statSync(leaseFile).mode & 0o777).toBe(beforeMode);
      expect(existsSync(path)).toBe(false);
      expectNoQuarantine(path);
    }
  });

  it('initializes beneath a previously nonexistent declared dataDir suffix', async () => {
    const container = temporaryDataDirectory();
    const dataDirectory = join(container, 'new-data', 'nested');
    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(databasePath(dataDirectory));
    } finally {
      foundation.close();
    }
  });

  it('executes the frozen DDL as STRICT tables with the named bucket index', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(INVENTORY_V1_DDL);
      const objects = database.prepare(
        `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all();
      expect(objects).toHaveLength(3);
      for (const object of objects) {
        expect(normalizeInventoryV1SchemaSql(String(object.sql))).toBe(
          INVENTORY_V1_USER_OBJECTS[String(object.name)],
        );
      }
      expect(database.prepare(
        `SELECT strict FROM pragma_table_list WHERE name = 'rfc64_candidate_bucket_loads_v1'`,
      ).get()?.strict).toBe(1);
      expect(database.prepare(
        `SELECT strict FROM pragma_table_list WHERE name = 'rfc64_candidate_bucket_rows_v1'`,
      ).get()?.strict).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects hostile transfer geometry while accepting every exact chunk boundary', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(INVENTORY_V1_DDL);
      const session = Buffer.alloc(32, 1);
      const scope = Buffer.alloc(32, 2);
      const author = Buffer.alloc(20, 3);
      const head = Buffer.alloc(32, 4);
      database.prepare(
        'INSERT INTO rfc64_candidate_bucket_loads_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        session,
        scope,
        author,
        head,
        null,
        u64be(0n),
        u64be(1n),
        u64be(0n),
        Buffer.alloc(32, 5),
        u64be(4n),
        u64be(512n),
      );
      const insert = database.prepare(
        'INSERT INTO rfc64_candidate_bucket_rows_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      let nonce = 1;
      const insertGeometry = (byteLength: bigint, chunkCount: bigint): void => {
        const unique = nonce;
        nonce += 1;
        const kaId = Buffer.alloc(32);
        kaId.writeUInt32BE(unique, 28);
        insert.run(
          session,
          scope,
          author,
          head,
          u64be(0n),
          kaId,
          Buffer.from(kaId),
          `coordinate-${unique}`,
          u64be(1n),
          'cg-shared-v1',
          Buffer.alloc(32, 6),
          Buffer.alloc(32, 7),
          'dkg-ka-bundle-v1',
          u64be(byteLength),
          u64be(262_144n),
          u64be(chunkCount),
          Buffer.alloc(32, 8),
          Buffer.alloc(32, 9),
          Buffer.alloc(32, 10),
        );
      };

      for (let chunkCount = 1n; chunkCount <= 4_096n; chunkCount += 1n) {
        const lowerBoundary = chunkCount === 1n
          ? 16n
          : ((chunkCount - 1n) * 262_144n) + 1n;
        const upperBoundary = chunkCount * 262_144n;
        expect(() => insertGeometry(lowerBoundary, chunkCount)).not.toThrow();
        expect(() => insertGeometry(upperBoundary, chunkCount)).not.toThrow();
      }
      for (const [byteLength, chunkCount] of [
        [0n, 0n],
        [16n, 0n],
        [16n, 4_096n],
        [262_144n, 2n],
        [262_145n, 1n],
        [262_145n, 3n],
        [1_073_741_824n, 4_095n],
      ] as const) {
        expect(() => insertGeometry(byteLength, chunkCount)).toThrow(/constraint/i);
      }

      expect(database.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
      ).get()?.count).toBe(8_192);
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT ka_id_u256be
        FROM rfc64_candidate_bucket_rows_v1
        WHERE session_id = ?
          AND catalog_scope_digest = ?
          AND author_address = ?
          AND target_catalog_head_digest = ?
          AND bucket_id_u64be = ?
          AND ka_id_u256be > ?
        ORDER BY ka_id_u256be
        LIMIT 256
      `).all(
        session,
        scope,
        author,
        head,
        u64be(0n),
        Buffer.alloc(32),
      );
      expect(plan.map((row) => String(row.detail)).join('\n')).toMatch(
        /USING COVERING INDEX rfc64_candidate_bucket_rows_by_bucket_v1 \(session_id=\? AND catalog_scope_digest=\? AND author_address=\? AND target_catalog_head_digest=\? AND bucket_id_u64be=\? AND ka_id_u256be>\?\)/,
      );
    } finally {
      database.close();
    }
  });

  it('refuses a valid foreign application_id without modifying or quarantining it', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE foreign_data (value TEXT); PRAGMA application_id = 305419896;');
    foreign.close();
    if (process.platform !== 'win32') chmodSync(path, 0o640);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'foreign-database'));

    expect(readFileSync(path)).toEqual(before);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640);
    expectNoQuarantine(path);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare(
      `SELECT count(*) AS count FROM sqlite_schema WHERE name = 'foreign_data'`,
    ).get()?.count).toBe(1);
    check.close();
  });

  it('refuses an application_id=0 database with user objects as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const ambiguous = new DatabaseSync(path);
    ambiguous.exec('CREATE TABLE existing_data (value TEXT)');
    ambiguous.close();
    if (process.platform !== 'win32') chmodSync(path, 0o640);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640);
    expectNoQuarantine(path);
  });

  it('refuses an uncommitted DK64 user_version=0 database as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const partial = new DatabaseSync(path);
    partial.exec(`
      CREATE TABLE partial_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
    `);
    partial.close();
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a newer owned user_version without quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const newer = new DatabaseSync(path);
    newer.exec(`
      CREATE TABLE future_schema (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 2;
    `);
    newer.close();

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'newer-schema'));
    expectNoQuarantine(path);
  });

  it('quarantines an incompatible owned v1 schema and rebuilds exact v1', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const incompatible = new DatabaseSync(path);
    incompatible.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    incompatible.close();

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      const generations = quarantineGenerations(path);
      expect(generations).toHaveLength(1);
      const oldPath = join(generations[0]!, 'inventory-v1.sqlite3');
      const old = new DatabaseSync(oldPath, { readOnly: true });
      expect(old.prepare(
        `SELECT count(*) AS count FROM sqlite_schema WHERE name = 'wrong_v1'`,
      ).get()?.count).toBe(1);
      old.close();
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('classifies and safely recovers a main-plus-hot-journal unit before enabling WAL', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const initialized = await openInventoryV1(dataDirectory);
    initialized.close();
    await leaveHotRollbackJournal(
      path,
      "CREATE TABLE uncommitted_intruder (value TEXT); INSERT INTO uncommitted_intruder VALUES ('lost')",
    );
    const journalBefore = fileOracle(`${path}-journal`);

    const reopened = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        expect(database.prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'uncommitted_intruder'",
        ).get()?.count).toBe(0);
      } finally {
        database.close();
      }
      expect(journalBefore.size).toBeGreaterThan(512);
      expect(existsSync(`${path}-journal`)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it('recovers a hot journal before automatically quarantining its incompatible main', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'committed-before-hot-journal');
    await leaveHotRollbackJournal(
      path,
      "INSERT INTO wrong_v1 VALUES ('uncommitted-before-crash')",
    );

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      const generation = evidenceGeneration(path);
      expect(lstatSync(join(generation, 'inventory-v1.sqlite3-journal')).isFile()).toBe(true);
      const quarantined = new DatabaseSync(
        join(generation, 'inventory-v1.sqlite3'),
        { readOnly: true },
      );
      try {
        expect(quarantined.prepare('SELECT value FROM wrong_v1 ORDER BY rowid').all()).toEqual([
          { value: 'committed-before-hot-journal' },
        ]);
      } finally {
        quarantined.close();
      }
    } finally {
      foundation.close();
    }
  });

  it('moves residual rollback-journal evidence in the automatic quarantine manifest', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'residual-journal');
    const evidence = HOSTILE_SIDECAR_BYTES.journal;
    const openWithResidualJournal = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: (close, reason) => {
        close();
        if (reason === 'automatic-schema-quarantine') {
          writeFileSync(`${path}-journal`, evidence);
        }
      },
    });

    const foundation = await openWithResidualJournal(dataDirectory);
    try {
      assertInitializedInventory(path);
      const generation = evidenceGeneration(path);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-journal'))).toEqual(evidence);
      expect(existsSync(`${path}-journal`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('fails closed on rollback-journal evidence beside a WAL-mode main header', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'wal-header-journal');
    const wal = new DatabaseSync(path);
    wal.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);');
    wal.close();
    expect(readFileSync(path).subarray(18, 20)).toEqual(Buffer.from([2, 2]));

    const journalEvidence = HOSTILE_SIDECAR_BYTES.journal;
    const opener = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: (close, reason) => {
        close();
        if (reason === 'automatic-schema-quarantine') {
          writeFileSync(`${path}-journal`, journalEvidence);
        }
      },
    });
    await expect(opener(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'ambiguous-database'),
    );
    expect(readFileSync(`${path}-journal`)).toEqual(journalEvidence);
    expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    expect(quarantineGenerations(path)).toEqual([]);
  });

  it('rejects pre-existing mixed journal modes before SQLite can mutate either sidecar', async () => {
    for (const mixedMember of ['wal', 'shm'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const initialized = await openInventoryV1(dataDirectory);
      initialized.close();
      writeFileSync(`${path}-journal`, HOSTILE_SIDECAR_BYTES.journal);
      writeFileSync(`${path}-${mixedMember}`, HOSTILE_SIDECAR_BYTES[mixedMember]);
      const before = {
        main: fileOracle(path),
        journal: fileOracle(`${path}-journal`),
        mixed: fileOracle(`${path}-${mixedMember}`),
      };

      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
        (error: unknown) => expectOpenErrorCode(error, 'ambiguous-database'),
      );
      expect(fileOracle(path)).toEqual(before.main);
      expect(fileOracle(`${path}-journal`)).toEqual(before.journal);
      expect(fileOracle(`${path}-${mixedMember}`)).toEqual(before.mixed);
      expectNoQuarantine(path);
    }
  });

  it('fails closed on mixed rollback-journal and WAL evidence without starting quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'mixed-journal-mode-evidence');
    const journalEvidence = HOSTILE_SIDECAR_BYTES.journal;
    const walEvidence = HOSTILE_SIDECAR_BYTES.wal;
    const openWithMixedEvidence = createInventoryV1TestOpener({
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
      closeTarget: (close, reason) => {
        close();
        if (reason === 'automatic-schema-quarantine') {
          writeFileSync(`${path}-journal`, journalEvidence);
          writeFileSync(`${path}-wal`, walEvidence);
        }
      },
    });

    await expect(openWithMixedEvidence(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'database-io'),
    );
    expect(readFileSync(`${path}-journal`)).toEqual(journalEvidence);
    expect(readFileSync(`${path}-wal`)).toEqual(walEvidence);
    expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    expect(quarantineGenerations(path)).toEqual([]);
  });

  it('fails closed before automatic quarantine when namespace durability is unavailable', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const incompatible = new DatabaseSync(path);
    incompatible.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      INSERT INTO wrong_v1 VALUES ('must-survive');
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    incompatible.close();
    const before = readFileSync(path);

    await expect(openProductionInventoryV1(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );

    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('SELECT value FROM wrong_v1').get()?.value).toBe('must-survive');
    check.close();
  });

  it('does not enter the quarantine proof for an unsupported crashed-WAL candidate', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    await createCrashedWalIncompatibleOwnedInventory(path, 'main-row');
    const boundaries: InventoryV1QuarantineBoundary[] = [];
    const closeReasons: string[] = [];
    const openWithoutDurability = createInventoryV1TestOpener({
      quarantineCapability: null,
      boundary: (boundary) => { boundaries.push(boundary); },
      closeTarget: (close, reason) => {
        close();
        closeReasons.push(reason);
      },
    });

    await expect(openWithoutDurability(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );

    expect(boundaries).not.toContain('target-exclusivity-proven');
    expect(closeReasons).toEqual(['failed-open-cleanup']);
    expectNoQuarantine(path);
    const recovered = new DatabaseSync(path, { readOnly: true });
    try {
      expect(recovered.prepare('SELECT value FROM wrong_v1 ORDER BY rowid').all())
        .toEqual([{ value: 'main-row' }, { value: 'wal-row' }]);
    } finally {
      recovered.close();
    }
  });

  it('refuses NOTADB bytes without manufacturing DK64 ownership or quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const corruptBytes = Buffer.from('not-a-sqlite-database\n');
    writeFileSync(path, corruptBytes);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(corruptBytes);
    expectNoQuarantine(path);
  });

  it('never initializes a pre-existing empty or zero-zero target remnant', async () => {
    for (const kind of ['empty', 'zero-zero'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      mkdirSync(dirname(path), { recursive: true });
      if (kind === 'empty') {
        writeFileSync(path, Buffer.alloc(0));
      } else {
        const target = new DatabaseSync(path);
        target.exec('VACUUM');
        target.close();
      }
      const before = readFileSync(path);

      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'ambiguous-database'));

      expect(readFileSync(path)).toEqual(before);
      expectNoQuarantine(path);
    }
  });

  it('refuses a corrupt application_id=0 database with user data as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const ambiguous = new DatabaseSync(path);
    ambiguous.exec('CREATE TABLE existing_data (value TEXT)');
    ambiguous.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a corrupt owned database with a newer header user_version', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const newer = new DatabaseSync(path);
    newer.exec(`
      CREATE TABLE future_schema (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 2;
    `);
    newer.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'newer-schema'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a corrupt uncommitted DK64 user_version=0 database as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const partial = new DatabaseSync(path);
    partial.exec(`
      CREATE TABLE partial_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
    `);
    partial.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('does not quarantine a corrupt SQLite file whose readable header has a foreign app id', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE foreign_data (value TEXT); PRAGMA application_id = 305419896;');
    foreign.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'foreign-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses database, sidecar, recovery-marker, and parent symlinks without quarantine',
    async () => {
      const databaseLinkData = temporaryDataDirectory();
      const databaseLinkPath = databasePath(databaseLinkData);
      mkdirSync(dirname(databaseLinkPath), { recursive: true });
      const databaseTarget = join(databaseLinkData, 'target.sqlite3');
      writeFileSync(databaseTarget, 'target');
      symlinkSync(databaseTarget, databaseLinkPath);
      await expect(openInventoryV1(databaseLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readFileSync(databaseTarget, 'utf8')).toBe('target');
      expectNoQuarantine(databaseLinkPath);

      const danglingData = temporaryDataDirectory();
      const danglingPath = databasePath(danglingData);
      mkdirSync(dirname(danglingPath), { recursive: true });
      symlinkSync(join(danglingData, 'missing-target'), danglingPath);
      await expect(openInventoryV1(danglingData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));

      const sidecarData = temporaryDataDirectory();
      const sidecarPath = databasePath(sidecarData);
      mkdirSync(dirname(sidecarPath), { recursive: true });
      const database = new DatabaseSync(sidecarPath);
      database.close();
      const sidecarTarget = join(sidecarData, 'sidecar-target');
      writeFileSync(sidecarTarget, 'sidecar');
      symlinkSync(sidecarTarget, `${sidecarPath}-journal`);
      await expect(openInventoryV1(sidecarData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expectNoQuarantine(sidecarPath);

      const directoryLinkData = temporaryDataDirectory();
      const directoryTarget = join(directoryLinkData, 'target-directory');
      mkdirSync(directoryTarget);
      symlinkSync(directoryTarget, join(directoryLinkData, 'rfc64-sync'));
      await expect(openInventoryV1(directoryLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readdirSync(directoryTarget)).toEqual([]);

      const markerLinkData = temporaryDataDirectory();
      const markerLinkPath = databasePath(markerLinkData);
      mkdirSync(dirname(markerLinkPath), { recursive: true });
      symlinkSync(join(markerLinkData, 'missing-marker'), `${markerLinkPath}.rebuild-required`);
      await expect(openInventoryV1(markerLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a symlinked dataDir before creating anything through it',
    async () => {
      const realDataDirectory = temporaryDataDirectory();
      const linkContainer = temporaryDataDirectory();
      const linkedDataDirectory = join(linkContainer, 'data-dir-link');
      symlinkSync(realDataDirectory, linkedDataDirectory);

      await expect(openInventoryV1(linkedDataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readdirSync(realDataDirectory)).toEqual([]);
      expect(existsSync(databasePath(realDataDirectory))).toBe(false);
      expectNoQuarantine(databasePath(linkedDataDirectory));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a foreign-owned dataDir before creating its inventory child',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const originalMode = statSync(dataDirectory).mode & 0o777;
      const actualUid = process.getuid!();
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
      try {
        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
          expectOpenErrorCode(error, 'database-io'));
      } finally {
        uid.mockRestore();
      }
      expect(existsSync(dirname(path))).toBe(false);
      expect(statSync(dataDirectory).mode & 0o777).toBe(originalMode);
      expectNoQuarantine(path);
    },
  );

  it('refuses every orphan target and lease sidecar without mutating the unit', async () => {
    for (const unit of ['target', 'lease'] as const) {
      for (const suffix of ['-journal', '-wal', '-shm'] as const) {
        const dataDirectory = temporaryDataDirectory();
        const path = databasePath(dataDirectory);
        const mainPath = unit === 'target' ? path : leasePath(dataDirectory);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') chmodSync(dirname(path), 0o700);
        const sidecarPath = `${mainPath}${suffix}`;
        const evidence = Buffer.from(`orphan-${unit}${suffix}-evidence`);
        writeFileSync(sidecarPath, evidence);
        const beforeMode = statSync(sidecarPath).mode & 0o777;
        const beforeEntries = readdirSync(dirname(path)).sort();

        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
          expectOpenErrorCode(error, 'ambiguous-database'));

        expect(existsSync(mainPath)).toBe(false);
        expect(readFileSync(sidecarPath)).toEqual(evidence);
        expect(statSync(sidecarPath).mode & 0o777).toBe(beforeMode);
        expect(readdirSync(dirname(path)).sort()).toEqual(beforeEntries);
        expect(existsSync(path)).toBe(false);
        expect(existsSync(leasePath(dataDirectory))).toBe(false);
        expectNoQuarantine(path);
      }
    }
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'fails closed on file-permission errors without quarantine',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      mkdirSync(dirname(path), { recursive: true });
      const database = new DatabaseSync(path);
      database.exec(`PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}; PRAGMA user_version = 1;`);
      database.close();
      chmodSync(path, 0o000);
      try {
        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
          expectOpenErrorCode(error, 'database-io'));
        expectNoQuarantine(path);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it('refuses a busy incompatible owned database without quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    seed.close();
    const holder = new DatabaseSync(path);
    holder.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
    `);
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-busy'));
      expectNoQuarantine(path);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('does not split a corrupt owned database from a live WAL writer', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const seed = new DatabaseSync(path);
    seed.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE owned_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    seed.close();
    const holder = new DatabaseSync(path);
    holder.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      INSERT INTO owned_data VALUES ('live-writer');
    `);
    truncateSync(path, 100);
    const before = readFileSync(path);
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-io'));
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expectNoQuarantine(path);
    } finally {
      try { holder.exec('ROLLBACK'); } catch { /* the main file is intentionally corrupt */ }
      try { holder.close(); } catch { /* the main file is intentionally corrupt */ }
    }
  });

  it('rejects recovery markers with unknown keys or a non-frozen members manifest', async () => {
    const invalidMarkers: unknown[] = [
      { version: 1, quarantineDirectory: 'placeholder' },
      { version: 1, quarantineDirectory: 'placeholder', members: ['main'], extra: true },
      { version: 1, quarantineDirectory: 'placeholder', members: ['main', 'wal'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['main', 'journal'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['journal', 'journal', 'main'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['journal', 'wal', 'main'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['journal', 'shm', 'main'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['journal', 'wal', 'shm', 'main'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['wal', 'wal', 'main'] },
      { version: 1, quarantineDirectory: 'placeholder', members: ['unknown', 'main'] },
    ];

    for (let index = 0; index < invalidMarkers.length; index += 1) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      createIncompatibleOwnedInventory(path, `invalid-shape-${index}`);
      const sourceBefore = fileOracle(path);
      const generation = join(
        dirname(path),
        'quarantine',
        `inventory-v1-1234567890-${String(index).padStart(16, 'a')}`,
      );
      mkdirSync(generation, { recursive: true });
      const markerObject = invalidMarkers[index] as Record<string, unknown>;
      markerObject.quarantineDirectory = generation;
      const marker = JSON.stringify(markerObject);
      writeFileSync(`${path}.rebuild-required`, marker);
      const inventoryDirectory = dirname(path);
      const directoryModeBefore = statSync(inventoryDirectory).mode;
      const entriesBefore = readdirSync(inventoryDirectory).sort();
      const reached: InventoryV1QuarantineBoundary[] = [];
      const openMalformedMarker = createInventoryV1TestOpener({
        quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
        boundary: (boundary) => reached.push(boundary),
      });

      await expect(openMalformedMarker(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-io'));

      expect(reached).toEqual([]);
      expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
      expect(fileOracle(path)).toEqual(sourceBefore);
      expect(readdirSync(generation)).toEqual([]);
      expect(statSync(inventoryDirectory).mode).toBe(directoryModeBefore);
      expect(readdirSync(inventoryDirectory).sort()).toEqual(entriesBefore);
      expect(existsSync(leasePath(dataDirectory))).toBe(false);
    }
  });

  it('rejects duplicate-key and non-canonical recovery marker encodings without mutation', async () => {
    for (const kind of ['duplicate-version', 'duplicate-directory', 'duplicate-members', 'whitespace', 'reordered'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      createIncompatibleOwnedInventory(path, `invalid-encoding-${kind}`);
      const sourceBefore = fileOracle(path);
      const generation = join(
        dirname(path),
        'quarantine',
        'inventory-v1-1234567890-cacacacacacacaca',
      );
      mkdirSync(generation, { recursive: true });
      const encodedGeneration = JSON.stringify(generation);
      const marker = kind === 'duplicate-version'
        ? `{"version":1,"version":1,"quarantineDirectory":${encodedGeneration},"members":["main"]}`
        : kind === 'duplicate-directory'
          ? `{"version":1,"quarantineDirectory":${encodedGeneration},"quarantineDirectory":${encodedGeneration},"members":["main"]}`
          : kind === 'duplicate-members'
            ? `{"version":1,"quarantineDirectory":${encodedGeneration},"members":["main"],"members":["main"]}`
            : kind === 'whitespace'
              ? `{"version":1, "quarantineDirectory":${encodedGeneration},"members":["main"]}`
              : `{"members":["main"],"quarantineDirectory":${encodedGeneration},"version":1}`;
      writeFileSync(`${path}.rebuild-required`, marker);
      const inventoryDirectory = dirname(path);
      const directoryModeBefore = statSync(inventoryDirectory).mode;
      const entriesBefore = readdirSync(inventoryDirectory).sort();
      const reached: InventoryV1QuarantineBoundary[] = [];
      const openMalformedMarker = createInventoryV1TestOpener({
        quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
        boundary: (boundary) => reached.push(boundary),
      });

      await expect(openMalformedMarker(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-io'));

      expect(reached).toEqual([]);
      expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
      expect(fileOracle(path)).toEqual(sourceBefore);
      expect(readdirSync(generation)).toEqual([]);
      expect(statSync(inventoryDirectory).mode).toBe(directoryModeBefore);
      expect(readdirSync(inventoryDirectory).sort()).toEqual(entriesBefore);
      expect(existsSync(leasePath(dataDirectory))).toBe(false);
    }
  });

  it('bounds and strictly decodes recovery markers and rejects every path alias before exclusivity or movement', async () => {
    const variants = [
      'cap-plus-one',
      'invalid-utf8',
      'utf8-bom',
      'relative',
      'normalized-alias',
      'trailing-separator',
      'escape',
      'lone-surrogate',
    ] as const;
    for (const [index, variant] of variants.entries()) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      createIncompatibleOwnedInventory(path, `marker-${variant}`);
      const sourceBefore = fileOracle(path);
      const generationName = `inventory-v1-1234567890-${String(index).padStart(16, 'a')}`;
      const quarantineRoot = join(dirname(path), 'quarantine');
      const generation = join(quarantineRoot, generationName);
      mkdirSync(generation, { recursive: true });
      const canonical = JSON.stringify({
        version: 1,
        quarantineDirectory: generation,
        members: ['main'],
      });
      const markerBytes = variant === 'cap-plus-one'
        ? Buffer.alloc(4_097, 0x20)
        : variant === 'invalid-utf8'
          ? Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])
          : variant === 'utf8-bom'
            ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)])
            : Buffer.from(variant === 'lone-surrogate'
              ? `{"version":1,"quarantineDirectory":"\\ud800","members":["main"]}`
              : JSON.stringify({
                version: 1,
                quarantineDirectory: variant === 'relative'
                  ? join('quarantine', generationName)
                  : variant === 'normalized-alias'
                    ? `${quarantineRoot}/nested/../${generationName}`
                    : variant === 'trailing-separator'
                      ? `${generation}/`
                      : join(quarantineRoot, '..', generationName),
                members: ['main'],
              }));
      writeFileSync(`${path}.rebuild-required`, markerBytes);
      const inventoryDirectory = dirname(path);
      const directoryModeBefore = statSync(inventoryDirectory).mode;
      const entriesBefore = readdirSync(inventoryDirectory).sort();
      let exclusivityBoundaries = 0;
      const openForMarkerTest = createInventoryV1TestOpener({
        quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
        boundary: (boundary) => {
          if (boundary === 'target-exclusivity-proven') exclusivityBoundaries += 1;
        },
      });

      await expect(
        openForMarkerTest(dataDirectory),
      ).rejects.toBeInstanceOf(InventoryV1OpenError);
      expect(exclusivityBoundaries).toBe(0);
      expect(fileOracle(path)).toEqual(sourceBefore);
      expect(readFileSync(`${path}.rebuild-required`)).toEqual(markerBytes);
      expect(readdirSync(generation)).toEqual([]);
      expect(statSync(inventoryDirectory).mode).toBe(directoryModeBefore);
      expect(readdirSync(inventoryDirectory).sort()).toEqual(entriesBefore);
      expect(existsSync(leasePath(dataDirectory))).toBe(false);
    }
  });

  it('round-trips a canonical marker beneath a hostile but valid data-directory name', async () => {
    const container = temporaryDataDirectory();
    const dataDirectory = join(container, 'hostile [] ž\n☃');
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'hostile-data-directory');
    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      assertRecoveredManifestEvidence(path, ['main'], 'hostile-data-directory');
    } finally {
      foundation.close();
    }
  });

  it('resumes a prefix-moved manifest without reopening the partial SQLite source', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-eeeeeeeeeeeeeeee',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'wal-moved-before-crash');
    writeFileSync(`${path}-shm`, 'shm-still-at-source');
    // This is intentionally not SQLite. Because WAL already moved, reopening
    // or checkpointing the partial source would fail; manifest resume must
    // treat the remaining bytes as evidence and continue under the lease.
    writeFileSync(path, 'not-a-sqlite-main-but-marker-owned');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({
        version: 1,
        quarantineDirectory: generation,
        members: ['wal', 'shm', 'main'],
      }),
    );

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'utf8')).toBe(
        'wal-moved-before-crash',
      );
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'utf8')).toBe(
        'shm-still-at-source',
      );
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe(
        'not-a-sqlite-main-but-marker-owned',
      );
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('finishes an all-destination crash topology without recreating or reopening the source', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-abababababababab',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(join(generation, 'inventory-v1.sqlite3'), 'main-moved-before-crash');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({ version: 1, quarantineDirectory: generation, members: ['main'] }),
    );

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe(
        'main-moved-before-crash',
      );
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('fails closed on a reordered partial recovery topology without moving evidence', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-ffffffffffffffff',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(`${path}-wal`, 'wal-source');
    writeFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'shm-destination');
    writeFileSync(path, 'main-source');
    const marker = JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['wal', 'shm', 'main'],
    });
    writeFileSync(`${path}.rebuild-required`, marker);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'database-io'));

    expect(readFileSync(`${path}-wal`, 'utf8')).toBe('wal-source');
    expect(readFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'utf8')).toBe(
      'shm-destination',
    );
    expect(readFileSync(path, 'utf8')).toBe('main-source');
    expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
  });

  it('fails closed on duplicate, missing, unlisted, or unknown recovery evidence', async () => {
    for (const kind of ['duplicate', 'missing', 'unlisted', 'unknown-entry'] as const) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const generation = join(
        dirname(path),
        'quarantine',
        `inventory-v1-1234567890-${kind === 'duplicate' ? '1111111111111111'
          : kind === 'missing' ? '2222222222222222'
            : kind === 'unlisted' ? '3333333333333333' : '4444444444444444'}`,
      );
      mkdirSync(generation, { recursive: true });
      if (kind !== 'missing') writeFileSync(path, 'source-main-evidence');
      if (kind === 'duplicate') {
        writeFileSync(join(generation, 'inventory-v1.sqlite3'), 'destination-main-evidence');
      }
      if (kind === 'unlisted') writeFileSync(`${path}-wal`, 'unlisted-wal-evidence');
      if (kind === 'unknown-entry') writeFileSync(join(generation, 'unexpected-file'), 'unknown');
      const marker = JSON.stringify({
        version: 1,
        quarantineDirectory: generation,
        members: ['main'],
      });
      writeFileSync(`${path}.rebuild-required`, marker);

      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-io'));

      expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
      if (kind !== 'missing') expect(readFileSync(path, 'utf8')).toBe('source-main-evidence');
      if (kind === 'duplicate') {
        expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe(
          'destination-main-evidence',
        );
      }
      if (kind === 'unlisted') {
        expect(readFileSync(`${path}-wal`, 'utf8')).toBe('unlisted-wal-evidence');
      }
      if (kind === 'unknown-entry') {
        expect(readFileSync(join(generation, 'unexpected-file'), 'utf8')).toBe('unknown');
      }
    }
  });

  it('exhaustively rejects every non-prefix source/destination/missing/duplicate manifest topology without mutation', async () => {
    const manifests = [
      ['main'],
      ['journal', 'main'],
      ['wal', 'main'],
      ['shm', 'main'],
      ['wal', 'shm', 'main'],
    ] as const satisfies readonly RecoveryManifest[];
    const locations = ['source', 'destination', 'missing', 'both'] as const;
    for (const members of manifests) {
      let combinations: Array<Array<typeof locations[number]>> = [[]];
      for (let index = 0; index < members.length; index += 1) {
        combinations = combinations.flatMap((row) =>
          locations.map((location) => [...row, location]));
      }
      for (const [caseIndex, topology] of combinations.entries()) {
        const isValidPrefix = topology.every((location) =>
          location === 'source' || location === 'destination')
          && !topology.some((location, index) =>
            location === 'destination' && topology.slice(0, index).includes('source'));
        if (isValidPrefix) continue;

        const dataDirectory = temporaryDataDirectory();
        const path = databasePath(dataDirectory);
        const generation = join(
          dirname(path),
          'quarantine',
          `inventory-v1-1234567890-${caseIndex.toString(16).padStart(16, '0')}`,
        );
        mkdirSync(generation, { recursive: true });
        const evidencePaths: string[] = [];
        for (const [index, member] of members.entries()) {
          const location = topology[index]!;
          const source = recoverySourcePath(path, member);
          const destination = recoveryDestinationPath(generation, member);
          if (location === 'source' || location === 'both') {
            writeFileSync(source, `source-${member}-${caseIndex}`);
            evidencePaths.push(source);
          }
          if (location === 'destination' || location === 'both') {
            writeFileSync(destination, `destination-${member}-${caseIndex}`);
            evidencePaths.push(destination);
          }
        }
        const marker = Buffer.from(JSON.stringify({
          version: 1,
          quarantineDirectory: generation,
          members,
        }));
        writeFileSync(`${path}.rebuild-required`, marker);
        const before = new Map(evidencePaths.map((evidence) => [evidence, fileOracle(evidence)]));

        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
          (error: unknown) => expectOpenErrorCode(error, 'database-io'),
        );

        expect(readFileSync(`${path}.rebuild-required`)).toEqual(marker);
        for (const evidence of evidencePaths) {
          expect(fileOracle(evidence)).toEqual(before.get(evidence));
        }
      }
    }
  }, 60_000);

  it('re-probes a zero-move marker and refuses an active raw SQLite holder', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-9999999999999999',
    );
    mkdirSync(generation, { recursive: true });
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    seed.close();
    const marker = JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['main'],
    });
    writeFileSync(`${path}.rebuild-required`, marker);
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-busy'));
      expect(existsSync(path)).toBe(true);
      expect(readdirSync(generation)).toEqual([]);
      expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
      expect(existsSync(join(generation, 'inventory-v1.sqlite3'))).toBe(true);
    } finally {
      foundation.close();
    }
  });

  it('fails closed without opening or moving a restarted zero-prefix journal manifest', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-9898989898989898',
    );
    mkdirSync(generation, { recursive: true });
    createIncompatibleOwnedInventory(path, 'journal-zero-prefix-holder');
    const holder = new DatabaseSync(path);
    holder.exec(`
      PRAGMA journal_mode = DELETE;
      BEGIN IMMEDIATE;
      INSERT INTO wrong_v1 VALUES ('uncommitted-live-holder');
    `);
    expect(lstatSync(`${path}-journal`).size).toBeGreaterThan(512);
    const marker = Buffer.from(JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['journal', 'main'],
    }));
    writeFileSync(`${path}.rebuild-required`, marker);
    const before = {
      main: fileOracle(path),
      journal: fileOracle(`${path}-journal`),
      marker: fileOracle(`${path}.rebuild-required`),
      sourceNames: readdirSync(dirname(path))
        .filter((name) => name.startsWith('inventory-v1.sqlite3'))
        .sort(),
      destinationNames: readdirSync(generation).sort(),
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
          (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
        );
        expect(fileOracle(path)).toEqual(before.main);
        expect(fileOracle(`${path}-journal`)).toEqual(before.journal);
        expect(fileOracle(`${path}.rebuild-required`)).toEqual(before.marker);
        expect(readdirSync(dirname(path))
          .filter((name) => name.startsWith('inventory-v1.sqlite3'))
          .sort()).toEqual(before.sourceNames);
        expect(readdirSync(generation).sort()).toEqual(before.destinationNames);
        expect(readFileSync(`${path}.rebuild-required`)).toEqual(marker);
      }
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('leaves a zero-prefix journal marker with a WAL-mode main untouched', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-9797979797979797',
    );
    mkdirSync(generation, { recursive: true });
    createIncompatibleOwnedInventory(path, 'wal-marker-journal');
    const wal = new DatabaseSync(path);
    wal.exec('PRAGMA journal_mode = WAL; PRAGMA wal_checkpoint(TRUNCATE);');
    wal.close();
    writeFileSync(`${path}-journal`, HOSTILE_SIDECAR_BYTES.journal);
    const marker = Buffer.from(JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['journal', 'main'],
    }));
    writeFileSync(`${path}.rebuild-required`, marker);
    const before = {
      main: fileOracle(path),
      journal: fileOracle(`${path}-journal`),
      marker: fileOracle(`${path}.rebuild-required`),
      destinationNames: readdirSync(generation).sort(),
    };

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'ambiguous-database'),
    );
    expect(fileOracle(path)).toEqual(before.main);
    expect(fileOracle(`${path}-journal`)).toEqual(before.journal);
    expect(fileOracle(`${path}.rebuild-required`)).toEqual(before.marker);
    expect(readdirSync(generation).sort()).toEqual(before.destinationNames);
  });

  it('resumes a partial recovery-marker move before rebuilding', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const inventoryDirectory = dirname(path);
    const generation = join(
      inventoryDirectory,
      'quarantine',
      'inventory-v1-1234567890-aaaaaaaaaaaaaaaa',
    );
    mkdirSync(generation, { recursive: true });
    const incompatible = new DatabaseSync(path);
    incompatible.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      INSERT INTO wrong_v1 VALUES ('main-before-crash');
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    incompatible.close();
    // A supported crash after both sidecars moved leaves the valid source
    // main in place. Resume must prove that main quiescent, move it last, and
    // then rebuild a fresh inventory at the source pathname.
    writeFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'wal-before-crash');
    writeFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'shm-before-crash');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({
        version: 1,
        quarantineDirectory: generation,
        members: ['wal', 'shm', 'main'],
      }),
    );

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'utf8')).toBe('wal-before-crash');
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'utf8')).toBe('shm-before-crash');
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
      // Remove the synthetic sidecar evidence only after verifying it, so the
      // quarantined main can be inspected independently.
      rmSync(join(generation, 'inventory-v1.sqlite3-wal'));
      rmSync(join(generation, 'inventory-v1.sqlite3-shm'));
      const old = new DatabaseSync(join(generation, 'inventory-v1.sqlite3'), { readOnly: true });
      expect(old.prepare('SELECT value FROM wrong_v1').get()?.value).toBe('main-before-crash');
      old.close();
    } finally {
      foundation.close();
    }
  });

  it('refuses a pending recovery unit with sidecars but no main without creating a source database', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-dddddddddddddddd',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(`${path}-wal`, 'orphaned-wal-evidence');
    const marker = JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['wal', 'main'],
    });
    writeFileSync(`${path}.rebuild-required`, marker);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'database-io'));

    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}-wal`, 'utf8')).toBe('orphaned-wal-evidence');
    expect(readFileSync(`${path}.rebuild-required`, 'utf8')).toBe(marker);
    expect(readdirSync(generation)).toEqual([]);
  });

  it('leaves a pending marker and every evidence byte untouched when durability is unavailable', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const inventoryDirectory = dirname(path);
    const generation = join(
      inventoryDirectory,
      'quarantine',
      'inventory-v1-1234567890-cccccccccccccccc',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(path, 'main-before-resume');
    writeFileSync(`${path}-wal`, 'wal-before-resume');
    writeFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'destination-before-resume');
    const marker = JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['wal', 'shm', 'main'],
    });
    writeFileSync(`${path}.rebuild-required`, marker);
    const before = {
      main: readFileSync(path),
      wal: readFileSync(`${path}-wal`),
      destination: readFileSync(join(generation, 'inventory-v1.sqlite3-shm')),
      marker: readFileSync(`${path}.rebuild-required`),
    };

    await expect(openProductionInventoryV1(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );

    expect(readFileSync(path)).toEqual(before.main);
    expect(readFileSync(`${path}-wal`)).toEqual(before.wal);
    expect(readFileSync(join(generation, 'inventory-v1.sqlite3-shm'))).toEqual(before.destination);
    expect(readFileSync(`${path}.rebuild-required`)).toEqual(before.marker);
  });

  it('retains the recovery marker across an interrupted evidence move and resumes', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const inventoryDirectory = dirname(path);
    const generation = join(
      inventoryDirectory,
      'quarantine',
      'inventory-v1-1234567890-bbbbbbbbbbbbbbbb',
    );
    mkdirSync(generation, { recursive: true });
    const incompatible = new DatabaseSync(path);
    incompatible.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      INSERT INTO wrong_v1 VALUES ('main-before-crash');
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    incompatible.close();
    writeFileSync(join(generation, 'inventory-v1.sqlite3'), 'conflicting-target');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({ version: 1, quarantineDirectory: generation, members: ['main'] }),
    );

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'database-io'));
    expect(existsSync(`${path}.rebuild-required`)).toBe(true);
    expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe('conflicting-target');
    const source = new DatabaseSync(path, { readOnly: true });
    expect(source.prepare('SELECT value FROM wrong_v1').get()?.value).toBe('main-before-crash');
    source.close();

    rmSync(join(generation, 'inventory-v1.sqlite3'));
    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
      const old = new DatabaseSync(join(generation, 'inventory-v1.sqlite3'), { readOnly: true });
      expect(old.prepare('SELECT value FROM wrong_v1').get()?.value).toBe('main-before-crash');
      old.close();
    } finally {
      foundation.close();
    }
  });

  it('converges every frozen recovery manifest and valid moved-prefix topology', async () => {
    const manifests = [
      ['main'],
      ['journal', 'main'],
      ['wal', 'main'],
      ['shm', 'main'],
      ['wal', 'shm', 'main'],
    ] as const satisfies readonly RecoveryManifest[];

    for (const members of manifests) {
      for (let movedPrefix = 0; movedPrefix <= members.length; movedPrefix += 1) {
        const dataDirectory = temporaryDataDirectory();
        const label = `topology-${members.join('-')}-${movedPrefix}`;
        const seeded = seedPendingRecoveryTopology(
          dataDirectory,
          members,
          movedPrefix,
          label,
        );
        const path = databasePath(dataDirectory);

        if (members[0] === 'journal' && movedPrefix === 0) {
          const before = new Map(members.map((member) => {
            const evidence = recoverySourcePath(path, member);
            return [evidence, fileOracle(evidence)] as const;
          }));
          const markerBefore = fileOracle(`${path}.rebuild-required`);
          await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
            (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
          );
          expect(fileOracle(`${path}.rebuild-required`)).toEqual(markerBefore);
          for (const [evidence, oracle] of before) {
            expect(fileOracle(evidence)).toEqual(oracle);
          }
          continue;
        }

        const foundation = await openInventoryV1(dataDirectory);
        try {
          assertInitializedInventory(path);
          assertRecoveredManifestEvidence(
            path,
            members,
            label,
            seeded.generation,
            seeded.hashes,
          );
        } finally {
          foundation.close();
        }
      }
    }
  });

  it('recovers in a fresh process after SIGKILL at every full-manifest durability boundary', async () => {
    for (const boundary of FULL_MANIFEST_FAULT_BOUNDARIES) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const label = `fault-${boundary}`;
      createIncompatibleOwnedInventory(path, label);
      // Before marker creation the source member set is not committed crash
      // state. A fresh adapter may normalize empty SQLite auxiliaries and then
      // start a main-only generation; once the marker exists, every listed
      // member must retain its exact inode/device/size/digest through recovery.
      const markerExistsAtBoundary = FULL_MANIFEST_FAULT_BOUNDARIES.indexOf(boundary)
        >= FULL_MANIFEST_FAULT_BOUNDARIES.indexOf('begin.marker.write');
      const walEvidence = Buffer.alloc(0);
      const shmEvidence = Buffer.alloc(0);
      const expectedHashes: EvidenceHashes = {
        main: sha256File(path),
        wal: createHash('sha256').update(walEvidence).digest('hex'),
        shm: createHash('sha256').update(shmEvidence).digest('hex'),
      };
      const tracePath = join(dataDirectory, `trace-${boundary}.jsonl`);
      const trace = await killAtInventoryBoundary(dataDirectory, boundary, tracePath, {
        DKG_RFC64_CHILD_SYNTHETIC_FULL_MANIFEST: 'empty',
        DKG_RFC64_CHILD_PROTECT_EVIDENCE: '1',
      });
      expect(trace.map((entry) => entry.boundary)).toEqual(
        expectedFullManifestTrace(boundary),
      );
      const killedTopology = trace.at(-1)!.topology as Array<{
        path: string;
        kind: string;
        dev: number;
        ino: number;
        size: number;
        sha256?: string;
      }>;
      const killedEvidence = new Map<RecoveryMember, FileOracle>();
      for (const member of FULL_RECOVERY_MANIFEST) {
        const sourceName = member === 'main'
          ? 'inventory-v1.sqlite3'
          : `inventory-v1.sqlite3-${member}`;
        const destinationSuffix = `/inventory-v1.sqlite3${member === 'main' ? '' : `-${member}`}`;
        const entry = killedTopology.find((candidate) =>
          candidate.path === sourceName || candidate.path.endsWith(destinationSuffix));
        expect(entry, `missing ${member} oracle at ${boundary}`).toBeDefined();
        expect(entry!.kind).toBe('file');
        expect(entry!.sha256).toBe(expectedHashes[member]);
        killedEvidence.set(member, {
          dev: entry!.dev,
          ino: entry!.ino,
          size: entry!.size,
          sha256: entry!.sha256!,
        });
      }
      expect(killedEvidence.get('wal')!.ino).not.toBe(killedEvidence.get('shm')!.ino);

      try {
        await reopenInventoryInFreshProcess(dataDirectory);
      } catch (cause) {
        throw new Error(`fresh-process recovery failed after ${boundary}`, { cause });
      }
      assertInitializedInventory(path);
      try {
        assertRecoveredManifestEvidence(
          path,
          markerExistsAtBoundary ? FULL_RECOVERY_MANIFEST : ['main'],
          label,
          undefined,
          markerExistsAtBoundary ? expectedHashes : { main: expectedHashes.main },
        );
      } catch (cause) {
        throw new Error(`evidence verification failed after ${boundary}`, { cause });
      }
      const generation = evidenceGeneration(path);
      for (const member of markerExistsAtBoundary ? FULL_RECOVERY_MANIFEST : ['main'] as const) {
        expect(fileOracle(recoveryDestinationPath(generation, member))).toEqual(
          killedEvidence.get(member),
        );
      }
    }
  }, 180_000);

  it('recovers a journal moved-prefix in a fresh process after SIGKILL at every prefix durability boundary', async () => {
    for (const boundary of JOURNAL_PREFIX_FAULT_BOUNDARIES) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const label = `journal-prefix-fault-${boundary}`;
      const seeded = seedPendingRecoveryTopology(
        dataDirectory,
        JOURNAL_RECOVERY_MANIFEST,
        1,
        label,
        true,
      );
      const journalBefore = fileOracle(
        recoveryDestinationPath(seeded.generation, 'journal'),
      );
      const mainBefore = fileOracle(path);
      const tracePath = join(dataDirectory, `trace-${boundary}.jsonl`);
      const trace = await killAtInventoryBoundary(dataDirectory, boundary, tracePath, {
        DKG_RFC64_CHILD_PROTECT_EVIDENCE: '1',
      });
      expect(trace.map((entry) => entry.boundary)).toEqual(
        JOURNAL_PREFIX_FAULT_BOUNDARIES.slice(
          0,
          JOURNAL_PREFIX_FAULT_BOUNDARIES.indexOf(boundary) + 1,
        ),
      );

      await reopenInventoryInFreshProcess(dataDirectory);
      assertInitializedInventory(path);
      assertRecoveredManifestEvidence(
        path,
        JOURNAL_RECOVERY_MANIFEST,
        label,
        seeded.generation,
        seeded.hashes,
      );
      expect(fileOracle(recoveryDestinationPath(seeded.generation, 'journal'))).toEqual(
        journalBefore,
      );
      expect(fileOracle(recoveryDestinationPath(seeded.generation, 'main'))).toEqual(
        mainBefore,
      );
    }
  }, 60_000);

  it('preserves or resumes automatic journal quarantine at every crash boundary', async () => {
    for (const boundary of JOURNAL_AUTOMATIC_FAULT_BOUNDARIES) {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const label = `automatic-journal-fault-${boundary}`;
      createIncompatibleOwnedInventory(path, label);
      const tracePath = join(dataDirectory, `trace-${boundary}.jsonl`);
      const trace = await killAtInventoryBoundary(dataDirectory, boundary, tracePath, {
        DKG_RFC64_CHILD_SYNTHETIC_JOURNAL: '1',
      });
      expect(trace.map((entry) => entry.boundary)).toEqual([
        'target-exclusivity-proven',
        ...JOURNAL_AUTOMATIC_FAULT_BOUNDARIES.slice(
          0,
          JOURNAL_AUTOMATIC_FAULT_BOUNDARIES.indexOf(boundary) + 1,
        ),
      ]);

      const markerPath = `${path}.rebuild-required`;
      const generation = quarantineGenerations(path).find((candidate) =>
        existsSync(recoveryDestinationPath(candidate, 'journal'))
        || existsSync(recoveryDestinationPath(candidate, 'main'))
        || existsSync(markerPath));
      const journalAtDestination = generation !== undefined
        && existsSync(recoveryDestinationPath(generation, 'journal'));

      if (existsSync(markerPath) && !journalAtDestination) {
        const before = {
          main: fileOracle(path),
          journal: fileOracle(`${path}-journal`),
          marker: fileOracle(markerPath),
          destinationNames: generation === undefined ? [] : readdirSync(generation).sort(),
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
            (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
          );
          expect(fileOracle(path)).toEqual(before.main);
          expect(fileOracle(`${path}-journal`)).toEqual(before.journal);
          expect(fileOracle(markerPath)).toEqual(before.marker);
          if (generation !== undefined) {
            expect(readdirSync(generation).sort()).toEqual(before.destinationNames);
          }
        }
        continue;
      }

      const killedEvidence = new Map<RecoveryMember, FileOracle>();
      const committedMembers = journalAtDestination
        ? JOURNAL_RECOVERY_MANIFEST
        : (['main'] as const);
      for (const member of committedMembers) {
        const source = recoverySourcePath(path, member);
        const destination = generation === undefined
          ? undefined
          : recoveryDestinationPath(generation, member);
        const evidence = existsSync(source) ? source : destination;
        if (evidence !== undefined && existsSync(evidence)) {
          killedEvidence.set(member, fileOracle(evidence));
        }
      }

      await reopenInventoryInFreshProcess(dataDirectory);
      assertInitializedInventory(path);
      const recoveredGeneration = evidenceGeneration(path);
      for (const [member, oracle] of killedEvidence) {
        expect(fileOracle(recoveryDestinationPath(recoveredGeneration, member))).toEqual(oracle);
      }
    }
  }, 120_000);

  it('recovers in a fresh process after SIGKILL at every moved-prefix re-fsync boundary', async () => {
    for (const boundary of MOVED_PREFIX_FAULT_BOUNDARIES) {
      const member = boundary.split('.')[2] as FullRecoveryMember;
      const movedPrefix = FULL_RECOVERY_MANIFEST.indexOf(member) + 1;
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const label = `prefix-fault-${boundary}`;
      const seeded = seedPendingRecoveryTopology(
        dataDirectory,
        FULL_RECOVERY_MANIFEST,
        movedPrefix,
        label,
        true,
      );
      expect(Object.values(seeded.hashes)).toHaveLength(FULL_RECOVERY_MANIFEST.length);
      expect(new Set(Object.values(seeded.hashes)).size).toBe(FULL_RECOVERY_MANIFEST.length);
      for (const evidenceMember of FULL_RECOVERY_MANIFEST) {
        const evidencePath = FULL_RECOVERY_MANIFEST.indexOf(evidenceMember) < movedPrefix
          ? recoveryDestinationPath(seeded.generation, evidenceMember)
          : recoverySourcePath(path, evidenceMember);
        expect(lstatSync(evidencePath).size).toBeGreaterThan(0);
      }
      const { generation } = seeded;
      expect(seeded.hashes.wal).not.toBe(seeded.hashes.shm);
      expect(fileOracle(recoveryDestinationPath(generation, member)).size).toBeGreaterThan(0);
      const tracePath = join(dataDirectory, `trace-${boundary}.jsonl`);
      const trace = await killAtInventoryBoundary(dataDirectory, boundary, tracePath);
      expect(trace.map((entry) => entry.boundary)).toEqual(
        MOVED_PREFIX_FAULT_BOUNDARIES.slice(
          0,
          MOVED_PREFIX_FAULT_BOUNDARIES.indexOf(boundary) + 1,
        ),
      );
      const before = new Map(
        FULL_RECOVERY_MANIFEST.map((evidenceMember) => [
          evidenceMember,
          fileOracle(
            FULL_RECOVERY_MANIFEST.indexOf(evidenceMember) < movedPrefix
              ? recoveryDestinationPath(generation, evidenceMember)
              : recoverySourcePath(path, evidenceMember),
          ),
        ]),
      );

      await reopenInventoryInFreshProcess(dataDirectory);
      assertInitializedInventory(path);
      assertRecoveredManifestEvidence(
        path,
        FULL_RECOVERY_MANIFEST,
        label,
        generation,
        seeded.hashes,
      );
      for (const evidenceMember of FULL_RECOVERY_MANIFEST) {
        expect(fileOracle(recoveryDestinationPath(generation, evidenceMember))).toEqual(
          before.get(evidenceMember),
        );
      }
    }
  }, 120_000);

  it('fences a separate-process conforming contender after target exclusivity until holder SIGKILL', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'separate-process-contender');
    const tracePath = join(dataDirectory, 'contender-holder-trace.jsonl');
    const holder = spawnInventoryChild('fault', dataDirectory, {
      DKG_RFC64_CHILD_BOUNDARY: 'target-exclusivity-proven',
      DKG_RFC64_CHILD_TRACE: tracePath,
    });
    await waitForChildBoundary(holder, 'target-exclusivity-proven');
    const targetBefore = fileOracle(path);
    const namespaceBefore = readdirSync(dirname(path)).sort();
    expect(await runContender(dataDirectory)).toEqual({
      directLease: 'BUSY',
      targetTransaction: 'FREE',
      lease: 'BUSY',
    });
    expect(fileOracle(path)).toEqual(targetBefore);
    expect(readdirSync(dirname(path)).sort()).toEqual(namespaceBefore);

    const holderExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => holder.once('exit', (code, signal) => resolveExit({ code, signal })),
    );
    holder.kill('SIGKILL');
    const holderExit = await holderExitPromise;
    expect(holderExit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await runContender(dataDirectory)).toEqual({
      directLease: 'OPEN',
      targetTransaction: 'FREE',
      lease: 'OPEN',
    });
    assertInitializedInventory(path);
  }, 30_000);

  it('explicitly quarantines and rebuilds an open owned database', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const foundation = await openInventoryV1(dataDirectory);
    foundation.quarantineAndRebuild();
    try {
      expect(foundation.closed).toBe(false);
      assertInitializedInventory(path);
      expect(quarantineGenerations(path)).toHaveLength(1);
      expect(lstatSync(join(quarantineGenerations(path)[0]!, 'inventory-v1.sqlite3')).isFile()).toBe(true);
    } finally {
      foundation.close();
    }
  });

  it('rejects explicit quarantine before closing a valid foundation when durability is unavailable', async () => {
    const dataDirectory = temporaryDataDirectory();
    const foundation = await openProductionInventoryV1(dataDirectory);
    try {
      expect(() => foundation.quarantineAndRebuild()).toThrowError(
        expect.objectContaining({ code: 'durability-unavailable' }),
      );
      expect(foundation.closed).toBe(false);
      expectNoQuarantine(databasePath(dataDirectory));
    } finally {
      foundation.close();
    }

    const reopened = await openInventoryV1(dataDirectory);
    reopened.close();
  });
});

describe.runIf(process.platform === 'win32')('RFC-64 inventory v1 native Windows gate', () => {
  it('opens a fresh inventory and reopens the exact valid database without quarantine capability', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const foundation = await openProductionInventoryV1(dataDirectory);
    foundation.close();
    const before = fileOracle(path);
    const reopened = await openProductionInventoryV1(dataDirectory);
    reopened.close();
    expect(fileOracle(path)).toEqual(before);
    assertInitializedInventory(path);
  });

  it('leaves an automatic-quarantine candidate byte-for-byte untouched', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'windows-automatic');
    const before = fileOracle(path);
    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );
    expect(fileOracle(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('leaves an explicitly quarantined valid target open and mutation-free', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const foundation = await openProductionInventoryV1(dataDirectory);
    const before = fileOracle(path);
    try {
      expect(() => foundation.quarantineAndRebuild()).toThrowError(
        expect.objectContaining({ code: 'durability-unavailable' }),
      );
      expect(foundation.closed).toBe(false);
      expect(fileOracle(path)).toEqual(before);
      expectNoQuarantine(path);
    } finally {
      foundation.close();
    }
  });

  it('leaves pending marker-resume evidence and namespace byte-for-byte untouched', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    createIncompatibleOwnedInventory(path, 'windows-resume');
    const generation = join(
      dirname(path),
      'quarantine',
      'inventory-v1-1234567890-9999999999999999',
    );
    mkdirSync(generation, { recursive: true });
    const marker = Buffer.from(JSON.stringify({
      version: 1,
      quarantineDirectory: generation,
      members: ['main'],
    }));
    writeFileSync(`${path}.rebuild-required`, marker);
    const before = fileOracle(path);
    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy(
      (error: unknown) => expectOpenErrorCode(error, 'durability-unavailable'),
    );
    expect(fileOracle(path)).toEqual(before);
    expect(readFileSync(`${path}.rebuild-required`)).toEqual(marker);
    expect(readdirSync(generation)).toEqual([]);
  });
});
