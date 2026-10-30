// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { CHECKPOINT_PROFILE } from './snapshot-checkpoint-profile.js';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface SnapshotCheckpointEntry {
  readonly index: number; readonly ual: string;
  readonly encodedBytes: number; readonly plainBytes: number;
  readonly bodySha256: string; readonly metadataSha256: string;
}
export const checkpointSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function checkpointAssetPath(directory: string, index: number, suffix: 'body' | 'meta' | 'verified.nq.gz' | 'verified.meta.nq'): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= CHECKPOINT_PROFILE.maxAssets) throw new RangeError('Invalid checkpoint index');
  return join(directory, `${String(index).padStart(6, '0')}.${suffix}`);
}

/** Every attempt gets a new private directory. Failed/partial attempts are never reused. */
export async function reserveSnapshotCheckpoint(dataDir: string): Promise<string> {
  const parent = resolve(dataDir, 'public-snapshot-checkpoints');
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

/** Read one pinned regular file without following links or allocating beyond its bounded size. */
export async function readPinnedCheckpointFile(path: string, expected: string, maxBytes: number,
  kind: 'input' | 'load input' = 'input'): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Unsafe checkpoint ${kind}`);
    const buffer = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new Error(`Unsafe checkpoint ${kind}`);
    const bytes = buffer.subarray(0, used);
    if (checkpointSha256(bytes) !== expected) throw new Error(`Checkpoint ${kind} changed`);
    return bytes;
  } finally { await file.close(); }
}

export async function nativeCheckpointShaFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await input.close(); }
  return hash.digest('hex');
}
