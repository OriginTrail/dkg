import { join } from 'node:path';
import type { SnapshotPageIndexRecord, SnapshotPageIndexStore } from '../../src/workspace-snapshot-store.js';

export const DIGEST = `sha256:${'b'.repeat(64)}`;

export class MemoryPageIndexStore implements SnapshotPageIndexStore {
  readonly records = new Map<string, SnapshotPageIndexRecord>();
  reads = 0;
  writes = 0;

  async get(snapshotDigest: string): Promise<SnapshotPageIndexRecord | null> {
    this.reads += 1;
    return this.records.get(snapshotDigest) ?? null;
  }

  async upsert(record: SnapshotPageIndexRecord): Promise<void> {
    this.writes += 1;
    this.records.set(record.snapshotDigest, record);
  }
}

export function makeQuads(count: number, label = 'entity') {
  return Array.from({ length: count }, (_, index) => ({
    subject: `urn:snapshot:${label}:${index.toString().padStart(3, '0')}`,
    predicate: 'http://schema.org/value',
    object: `"${index}"`,
    graph: '',
  }));
}

export function digestFor(index: number): string {
  return `sha256:${index.toString(16).padStart(64, '0')}`;
}

export function snapshotDirectory(directory: string, digest = DIGEST): string {
  const hash = digest.slice('sha256:'.length);
  return join(directory, hash.slice(0, 2), hash.slice(2, 4));
}

export function snapshotPath(directory: string, digest = DIGEST): string {
  const hash = digest.slice('sha256:'.length);
  return join(snapshotDirectory(directory, digest), `${hash}.nq`);
}
