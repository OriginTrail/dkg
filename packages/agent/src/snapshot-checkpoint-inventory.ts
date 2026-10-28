// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizePublicGraphSnapshot, PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES } from '@origintrail-official/dkg-chain';
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';
import { assertPublicSnapshotProgress } from './public-snapshot-catch-up.js';
import { writeCheckpointFile, syncCheckpointDirectory } from './snapshot-checkpoint-files.js';

const guards = new WeakMap<object, CheckpointInventory>();
const RECORD = 'AUTHENTICATED-INVENTORY.json';

function historicalObservation(input: PublicSnapshotObservation): PublicSnapshotObservation {
  if (!input || (input.mode !== 'rpc-only' && input.mode !== 'core-cache')
    || (input.mode === 'rpc-only' ? input.sourceCore !== null
      : typeof input.sourceCore !== 'string' || !input.sourceCore.length || input.sourceCore.length > 256))
    throw new Error('Invalid checkpoint inventory observation');
  const s = input.snapshot;
  // Expired history is only a comparison floor. A fresh reader still establishes authority.
  const snapshot = normalizePublicGraphSnapshot(s, { ...s, now: s.observedAt });
  return { ...input, snapshot };
}

/** Durable write-ahead pins: partial recovery must never forget assets it may have imported. */
export class CheckpointInventory {
  private constructor(private readonly folder: string, private previous: PublicSnapshotObservation) {}
  static async create(folder: string, initial: PublicSnapshotObservation): Promise<CheckpointInventory> {
    const observation = historicalObservation(initial);
    await writeCheckpointFile(join(folder, RECORD), JSON.stringify(observation));
    await syncCheckpointDirectory(folder);
    return new CheckpointInventory(folder, observation);
  }
  static async load(folder: string): Promise<CheckpointInventory> {
    const file = await open(join(folder, RECORD), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > PUBLIC_GRAPH_SNAPSHOT_MAX_BYTES + 1024)
        throw new Error('Invalid checkpoint inventory record');
      return new CheckpointInventory(folder, historicalObservation(JSON.parse(await file.readFile('utf8'))));
    } finally { await file.close(); }
  }
  async advance(fresh: PublicSnapshotObservation): Promise<void> {
    assertPublicSnapshotProgress(this.previous, fresh);
    if (fresh.snapshot.snapshotDigest === this.previous.snapshot.snapshotDigest) return;
    const observation = historicalObservation(fresh);
    const staged = join(this.folder, `.inventory-${crypto.randomUUID()}.json`);
    await writeCheckpointFile(staged, JSON.stringify(observation));
    await rename(staged, join(this.folder, RECORD));
    await syncCheckpointDirectory(this.folder);
    this.previous = observation;
  }
}

/** Installed only on explicit checkpoint Edges, before startup and all foreground jobs. */
export function attachCheckpointInventory(agent: object, inventory: CheckpointInventory): void {
  if (guards.has(agent)) throw new Error('Checkpoint inventory already attached');
  guards.set(agent, inventory);
}
export async function advanceCheckpointInventory(agent: object, fresh: PublicSnapshotObservation): Promise<void> {
  await guards.get(agent)?.advance(fresh);
}
