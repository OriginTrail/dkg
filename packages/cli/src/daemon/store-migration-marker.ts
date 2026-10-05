// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export const STORE_HARDEN_LOCK_FILENAME = '.store-harden.lock';
export const storeHardenLockPath = (dkgHome: string): string => join(dkgHome, STORE_HARDEN_LOCK_FILENAME);
/** Restart monitoring expires observed markers; startup admission never does. */
export const STORE_MIGRATION_RESTART_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export interface ActiveStoreMigrationMarker {
  readonly pid: number;
  readonly containerName?: string;
  readonly startedAt?: string;
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
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  catch { return { kind: 'unreadable', path, ageMs: null }; }
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
    && (value.startedAt === undefined || typeof value.startedAt === 'string')) {
    return { kind: 'active', path, rawText, ageMs, value: value as unknown as ActiveStoreMigrationMarker };
  }
  return { kind: 'unreadable', path, rawText, ageMs };
}

export async function claimStoreMigrationMarker(path: string, containerName: string): Promise<StoreMigrationMarkerOwnership> {
  const rawText = `${JSON.stringify({ pid: process.pid, containerName, startedAt: new Date().toISOString() })}\n`;
  await writeFile(path, rawText, { encoding: 'utf8', flag: 'wx' });
  return { path, rawText };
}
export async function assertStoreMigrationMarkerUnchanged(owner: StoreMigrationMarkerOwnership): Promise<void> {
  if (await readFile(owner.path, 'utf8') !== owner.rawText) throw new Error('Migration marker changed during recovery.');
}
export async function retainStoreMigrationRecoveryMarker(owner: StoreMigrationMarkerOwnership,
  value: RecoveryStoreMigrationMarker): Promise<void> {
  await assertStoreMigrationMarkerUnchanged(owner);
  await writeFileAtomic(owner.path, JSON.stringify({ ...value, migrationDir: resolve(value.migrationDir) }));
}
export async function releaseStoreMigrationMarker(owner: StoreMigrationMarkerOwnership): Promise<void> {
  await assertStoreMigrationMarkerUnchanged(owner);
  await rm(owner.path);
}

/** Only explicit recovery may consume this certificate, with the exact original options. */
export function requireStoreMigrationRecoveryMarker(path: string,
  expected: Pick<RecoveryStoreMigrationMarker, 'containerName' | 'namespace' | 'migrationDir' | 'hostPort'>): StoreMigrationMarkerOwnership & { exportBytes: number } {
  const marker = readStoreMigrationMarker(path);
  if (marker.kind === 'unreadable') throw new Error('Invalid migration recovery marker; startup remains blocked.');
  if (marker.kind !== 'recovery-required' || marker.value.containerName !== expected.containerName
    || marker.value.namespace !== expected.namespace || marker.value.migrationDir !== resolve(expected.migrationDir)
    || marker.value.hostPort !== expected.hostPort || !positive(marker.value.exportBytes)) {
    throw new Error('Marker does not certify an incomplete migration for these recovery options; startup remains blocked.');
  }
  return { path, rawText: marker.rawText, exportBytes: marker.value.exportBytes };
}

/** Preserve the startup marker while one recovery claimant verifies it. */
export async function withStoreMigrationRecoveryLease<T>(owner: StoreMigrationMarkerOwnership,
  work: () => Promise<T>): Promise<T> {
  const lease = `${owner.path}.recovery`;
  await writeFile(lease, String(process.pid), { flag: 'wx' });
  try { await assertStoreMigrationMarkerUnchanged(owner); return await work(); }
  finally { await rm(lease, { force: true }); }
}
