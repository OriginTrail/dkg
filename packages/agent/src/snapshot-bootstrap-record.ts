// SPDX-License-Identifier: Apache-2.0
import { isPublicSnapshotMode, type PublicSnapshotMode } from './public-snapshot-mode.js';

/** Versioned durable handoff; runtime reports may grow without changing this boundary. */
export interface SnapshotBootstrapRecord {
  version: 1;
  chainId: string; deploymentId: string; contextGraphId: string; onChainId: string;
  mode: PublicSnapshotMode; initialJournalSha256: string; runtimeSha256: string;
  result: { current: true; completeAsOfSnapshot: true; assets: number; committed: number; inventoryDigest: string };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Decode untrusted JSON before any runtime or deployment binding comparison. */
export function decodeSnapshotBootstrapRecord(value: unknown): SnapshotBootstrapRecord {
  if (!object(value) || value.version !== 1 || !text(value.chainId) || !text(value.deploymentId)
    || !text(value.contextGraphId) || !text(value.onChainId) || !isPublicSnapshotMode(value.mode)
    || !sha(value.initialJournalSha256) || !sha(value.runtimeSha256) || !object(value.result))
    throw new Error('Checkpoint Edge restart binding mismatch: invalid bootstrap completion record');
  const r = value.result;
  if (r.current !== true || r.completeAsOfSnapshot !== true || !count(r.assets) || !count(r.committed)
    || r.committed > r.assets || !sha(r.inventoryDigest))
    throw new Error('Checkpoint Edge restart binding mismatch: incomplete bootstrap coverage');
  return { version: 1, chainId: value.chainId, deploymentId: value.deploymentId,
    contextGraphId: value.contextGraphId, onChainId: value.onChainId, mode: value.mode,
    initialJournalSha256: value.initialJournalSha256, runtimeSha256: value.runtimeSha256,
    result: { current: true, completeAsOfSnapshot: true, assets: r.assets, committed: r.committed, inventoryDigest: r.inventoryDigest } };
}

export function encodeSnapshotBootstrapRecord(value: SnapshotBootstrapRecord): string {
  return JSON.stringify(decodeSnapshotBootstrapRecord(value));
}
