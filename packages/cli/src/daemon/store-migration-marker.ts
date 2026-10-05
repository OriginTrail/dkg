// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const STORE_HARDEN_LOCK_FILENAME = '.store-harden.lock';
export const storeHardenLockPath = (dkgHome: string): string => join(dkgHome, STORE_HARDEN_LOCK_FILENAME);
/** Restart monitoring expires observed markers; startup admission never does. */
export const STORE_MIGRATION_RESTART_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export interface ActiveStoreMigrationMarker {
  readonly pid: number;
  readonly containerName?: string;
  readonly startedAt?: string;
  /** Captured options exist at claim; export evidence is checkpointed before swap. */
  readonly recovery?: StoreMigrationRecoveryProof;
}
export interface StoreMigrationRecoveryProof {
  readonly version: 1;
  readonly containerName: string;
  readonly namespace: string;
  readonly migrationDir: string;
  readonly hostPort: number;
  readonly volumeAttemptId: string;
  readonly exportBytes?: number;
}
export interface RecoveryStoreMigrationMarker {
  readonly version: 1;
  readonly recoveryRequired: true;
  readonly pid: number;
  readonly containerName: string;
  readonly namespace: string;
  readonly migrationDir: string;
  readonly hostPort: number;
  /** Unknown export size retains the barrier but cannot certify recovery. */
  readonly exportBytes?: number;
}
export interface StoreMigrationMarkerOwnership {
  readonly path: string;
  readonly rawText: string;
}
export type StoreMigrationMarker =
  | Readonly<{ kind: 'missing'; path: string }>
  | Readonly<{ kind: 'unreadable'; path: string; ageMs: number | null; rawText?: string }>
  | Readonly<StoreMigrationMarkerOwnership & { kind: 'active'; ageMs: number; value: ActiveStoreMigrationMarker }>
  | Readonly<StoreMigrationMarkerOwnership & { kind: 'recovery-required'; ageMs: number; value: RecoveryStoreMigrationMarker }>;

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function recoveryProof(value: unknown): value is StoreMigrationRecoveryProof {
  return object(value) && value.version === 1 && typeof value.containerName === 'string'
    && typeof value.namespace === 'string' && typeof value.migrationDir === 'string'
    && positive(value.hostPort) && value.hostPort <= 65535 && uuid(value.volumeAttemptId)
    && (value.exportBytes === undefined || positive(value.exportBytes));
}

/** Decode each historical form once; classification and restart freshness are distinct facts. */
export function readStoreMigrationMarker(path: string): StoreMigrationMarker {
  let ageMs: number;
  try { ageMs = Date.now() - statSync(path).mtimeMs; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing', path }
      : { kind: 'unreadable', path, ageMs: null };
  }
  let rawText: string;
  try { rawText = readFileSync(path, 'utf8'); }
  catch { return { kind: 'unreadable', path, ageMs }; }
  let value: unknown;
  try { value = JSON.parse(rawText); } catch { return { kind: 'unreadable', path, rawText, ageMs }; }
  if (!object(value) || !positive(value.pid)) return { kind: 'unreadable', path, rawText, ageMs };
  if (value.version === 1 && value.recoveryRequired === true
    && typeof value.containerName === 'string' && typeof value.namespace === 'string'
    && typeof value.migrationDir === 'string' && positive(value.hostPort) && value.hostPort <= 65535
    && (value.exportBytes === undefined || positive(value.exportBytes))) {
    return { kind: 'recovery-required', path, rawText, ageMs, value: value as unknown as RecoveryStoreMigrationMarker };
  }
  if (value.version === undefined && value.recoveryRequired === undefined
    && (value.containerName === undefined || typeof value.containerName === 'string')
    && (value.startedAt === undefined || typeof value.startedAt === 'string')
    && (value.recovery === undefined || recoveryProof(value.recovery))) {
    return { kind: 'active', path, rawText, ageMs, value: value as unknown as ActiveStoreMigrationMarker };
  }
  return { kind: 'unreadable', path, rawText, ageMs };
}

async function syncDirectory(path: string): Promise<void> {
  // Refuse unsupported directory barriers rather than claim host-restart durability.
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writeOwnedMarker(owner: StoreMigrationMarkerOwnership, rawText: string): Promise<StoreMigrationMarkerOwnership> {
  await assertStoreMigrationMarkerUnchanged(owner);
  const temporary = `${owner.path}.tmp.${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx');
    try { await file.writeFile(rawText); await file.sync(); } finally { await file.close(); }
    await assertStoreMigrationMarkerUnchanged(owner);
    await rename(temporary, owner.path);
    await syncDirectory(owner.path);
    return { path: owner.path, rawText };
  } finally { await rm(temporary, { force: true }); }
}
export async function claimStoreMigrationMarker(path: string, containerName: string,
  recovery?: StoreMigrationRecoveryProof): Promise<StoreMigrationMarkerOwnership> {
  const rawText = `${JSON.stringify({ pid: process.pid, containerName, startedAt: new Date().toISOString(),
    ...(recovery === undefined ? {} : { recovery }) })}\n`;
  const file = await open(path, 'wx');
  try { await file.writeFile(rawText); await file.sync(); } finally { await file.close(); }
  await syncDirectory(path);
  return { path, rawText };
}
/** Flush the retained export and its owned certificate before any ambiguous swap command. */
export async function checkpointStoreMigrationExport(owner: StoreMigrationMarkerOwnership,
  exportPath: string, exportBytes: number): Promise<StoreMigrationMarkerOwnership> {
  const active = readStoreMigrationMarker(owner.path);
  if (active.kind !== 'active' || active.rawText !== owner.rawText || active.value.recovery === undefined || !positive(exportBytes))
    throw new Error('Migration marker does not own the verified export checkpoint.');
  const file = await open(exportPath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  await syncDirectory(exportPath);
  return writeOwnedMarker(owner, JSON.stringify({ ...active.value,
    recovery: { ...active.value.recovery, exportBytes } }) + '\n');
}
export async function assertStoreMigrationMarkerUnchanged(owner: StoreMigrationMarkerOwnership): Promise<void> {
  if (await readFile(owner.path, 'utf8') !== owner.rawText) throw new Error('Migration marker changed during recovery.');
}
export async function retainStoreMigrationRecoveryMarker(owner: StoreMigrationMarkerOwnership,
  value: RecoveryStoreMigrationMarker): Promise<void> {
  await writeOwnedMarker(owner, JSON.stringify({ ...value, migrationDir: resolve(value.migrationDir) }));
}
export async function releaseStoreMigrationMarker(owner: StoreMigrationMarkerOwnership): Promise<void> {
  await assertStoreMigrationMarkerUnchanged(owner);
  await rm(owner.path);
}

/** Only explicit recovery may consume this certificate, with the exact original options. */
export function requireStoreMigrationRecoveryMarker(path: string,
  expected: Pick<RecoveryStoreMigrationMarker, 'containerName' | 'namespace' | 'migrationDir' | 'hostPort'>): StoreMigrationMarkerOwnership & { exportBytes: number; volumeAttemptId?: string } {
  const marker = readStoreMigrationMarker(path);
  if (marker.kind === 'unreadable') throw new Error('Invalid migration recovery marker; startup remains blocked.');
  const value = marker.kind === 'recovery-required' ? marker.value : marker.kind === 'active' ? marker.value.recovery : undefined;
  if (value === undefined || value.containerName !== expected.containerName
    || value.namespace !== expected.namespace || value.migrationDir !== resolve(expected.migrationDir)
    || value.hostPort !== expected.hostPort || !positive(value.exportBytes)) {
    throw new Error('Marker does not certify an incomplete migration for these recovery options; startup remains blocked.');
  }
  if (marker.kind === 'active') {
    // A permission failure or reused/live PID cannot certify that this owner is orphaned.
    let absent = false;
    try { process.kill(marker.value.pid, 0); }
    catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!absent) throw new Error('Migration owner is live or unverifiable; startup remains blocked.');
    return { path, rawText: marker.rawText, exportBytes: value.exportBytes,
      volumeAttemptId: marker.value.recovery!.volumeAttemptId };
  }
  if (marker.kind !== 'recovery-required') throw new Error('Missing migration recovery marker.');
  return { path, rawText: marker.rawText, exportBytes: value.exportBytes };
}

/** Preserve the startup marker while one recovery claimant verifies it. */
export async function withStoreMigrationRecoveryLease<T>(owner: StoreMigrationMarkerOwnership,
  work: () => Promise<T>): Promise<T> {
  const lease = `${owner.path}.recovery`;
  await writeFile(lease, String(process.pid), { flag: 'wx' });
  try { await assertStoreMigrationMarkerUnchanged(owner); return await work(); }
  finally { await rm(lease, { force: true }); }
}
