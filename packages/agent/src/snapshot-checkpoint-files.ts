// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface SnapshotCheckpointEntry {
  readonly index: number; readonly ual: string;
  readonly encodedBytes: number; readonly plainBytes: number;
  readonly bodySha256: string; readonly metadataSha256: string;
}
export const checkpointSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function checkpointAssetPath(directory: string, index: number, suffix: 'body' | 'meta' | 'verified.nq.gz' | 'verified.meta.nq'): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 100_000) throw new RangeError('Invalid checkpoint index');
  return join(directory, `${String(index).padStart(6, '0')}.${suffix}`);
}

/** Every attempt gets a new private directory. Failed/partial attempts are never reused. */
export async function reserveSnapshotCheckpoint(dataDir: string): Promise<string> {
  const parent = join(dataDir, 'public-snapshot-checkpoints');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const state = await lstat(parent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Unsafe checkpoint directory');
  return mkdtemp(join(parent, 'checkpoint-'));
}

export async function syncCheckpointDirectory(directory: string): Promise<void> {
  const file = await open(directory, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

/** No overwrite, including after an uncertain previous write. */
export async function writeCheckpointFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
