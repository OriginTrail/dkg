import { resolve } from 'node:path';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

/** All stores for one directory in this process share the metadata-write boundary. */
const directories = new Map<string, SnapshotLifecycleGate>();

export function snapshotLifecycleGate(directory: string): SnapshotLifecycleGate {
  const key = resolve(directory);
  let gate = directories.get(key);
  if (!gate) directories.set(key, gate = new SnapshotLifecycleGate());
  return gate;
}

class SnapshotLifecycleGate {
  private readonly entries = new Map<string, { users: number; exclusive?: Promise<void> }>();

  async acquire(hash: string): Promise<() => void> {
    for (;;) {
      const entry = this.entries.get(hash) ?? { users: 0 };
      if (entry.exclusive) { await entry.exclusive; continue; }
      this.entries.set(hash, entry);
      entry.users += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.users -= 1;
        if (entry.users === 0) this.entries.delete(hash);
      };
    }
  }

  async use<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(hash);
    try { return await operation(); }
    finally { release(); }
  }

  /** Skip a busy hash; other snapshots can still be retired during continuous sync. */
  async tryCollect<T>(hash: string, operation: () => Promise<T>): Promise<T | undefined> {
    if (this.entries.has(hash)) return undefined;
    let release!: () => void;
    this.entries.set(hash, {
      users: 0, exclusive: new Promise<void>(resolve => { release = resolve; }),
    });
    try { return await operation(); }
    finally { this.entries.delete(hash); release(); }
  }
}

/** Keep each touched snapshot alive through its entire RDF metadata write/recovery scope. */
export async function withWorkspaceSnapshotWrites<T>(
  store: WorkspacePublicSnapshotStore | undefined,
  operation: (scopedStore: WorkspacePublicSnapshotStore | undefined) => Promise<T>,
): Promise<T> {
  if (!store?.acquireSnapshotLease) return operation(store);
  const leases = new Map<string, Promise<() => void>>();
  const retain = async (ref: string): Promise<void> => {
    let lease = leases.get(ref);
    if (!lease) { lease = store.acquireSnapshotLease!(ref); leases.set(ref, lease); }
    await lease;
  };
  const scoped: WorkspacePublicSnapshotStore = {
    putSnapshot: async input => { await retain(input.digest); return store.putSnapshot(input); },
    getSnapshot: async ref => { await retain(ref); return store.getSnapshot(ref); },
    ...(store.validateSnapshot ? { validateSnapshot: async (ref: string, digest: string, count: number) => {
      await retain(ref); return store.validateSnapshot!(ref, digest, count);
    } } : {}),
    ...(store.getSnapshotPage ? { getSnapshotPage: async (...args: Parameters<NonNullable<WorkspacePublicSnapshotStore['getSnapshotPage']>>) => {
      await retain(args[0]); return store.getSnapshotPage!(...args);
    } } : {}),
  };
  try { return await operation(scoped); }
  finally {
    for (const lease of leases.values()) {
      // A failed acquisition must not replace the operation's original error.
      await lease.then(release => release(), () => undefined);
    }
  }
}

export function snapshotReferenceCheck(store: TripleStore): (ref: string) => Promise<boolean> {
  return async ref => {
    // Accept the legacy bare hash and case variants as well as the canonical ref.
    // Query every graph: a reference in another CG/operation must prevent deletion.
    const hash = ref.replace(/^sha256:/, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid snapshot retirement ref');
    const result = await store.query(`ASK {
      GRAPH ?graph {
        { ?subject <http://dkg.io/ontology/publicSnapshotRef> ?ref }
        UNION {
          ?subject <http://dkg.io/ontology/publicQuadsDigest> ?ref .
          FILTER NOT EXISTS { ?subject <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
        }
        FILTER(LCASE(STR(?ref)) IN (${JSON.stringify(hash)}, ${JSON.stringify(`sha256:${hash}`)}))
      }
    }`, { signal: AbortSignal.timeout(2_000) });
    if (result.type !== 'boolean') throw new Error('Snapshot reference check did not return a boolean');
    return result.value;
  };
}
