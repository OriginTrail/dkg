import { mkdir, realpath, stat } from 'node:fs/promises';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore, WorkspaceSnapshotIO } from './workspace-snapshot-store.js';

/** A store opts into the complete leasing/retirement contract, or keeps its own policy. */
export interface WorkspaceSnapshotLifecycle {
  readonly finalizedCleanupEnabled: boolean;
  acquire(ref: string): Promise<() => void>;
  /** Lease an existing source without decoding it; absent bytes must be fetched again. */
  acquireExisting(ref: string): Promise<(() => void) | undefined>;
  markPublished(refs: readonly string[]): Promise<void>;
}

/** All aliases of a physical directory in this process share one gate. */
const directories = new Map<string, SnapshotLifecycleGate>();
export function snapshotLifecycleGate(directory: string): DirectorySnapshotLifecycleGate {
  return new DirectorySnapshotLifecycleGate(directory);
}

export class DirectorySnapshotLifecycleGate {
  private gate?: Promise<SnapshotLifecycleGate>;
  constructor(private readonly directory: string) {}
  private get(): Promise<SnapshotLifecycleGate> {
    return this.gate ??= this.resolve().catch(error => { this.gate = undefined; throw error; });
  }
  private async resolve(): Promise<SnapshotLifecycleGate> {
    await mkdir(this.directory, { recursive: true });
    const physical = await realpath(this.directory);
    const identity = await stat(physical, { bigint: true });
    // Device/inode also coalesces case aliases on case-insensitive filesystems.
    if (!identity.isDirectory() || identity.ino === 0n) throw new Error('Snapshot directory needs a stable physical identity');
    const key = `${identity.dev}:${identity.ino}`;
    let gate = directories.get(key);
    if (!gate) directories.set(key, gate = new SnapshotLifecycleGate());
    return gate;
  }
  async acquire(hash: string): Promise<() => void> { return (await this.get()).acquire(hash); }
  async use<T>(hash: string, operation: () => Promise<T>): Promise<T> { return (await this.get()).use(hash, operation); }
  async tryCollect<T>(hash: string, operation: () => Promise<T>): Promise<T | undefined> {
    return (await this.get()).tryCollect(hash, operation);
  }
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
  operation: (scopedStore: WorkspaceSnapshotIO | undefined, retainExisting: (ref: string) => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const lifecycle = store?.lifecycle;
  if (!store || !lifecycle) return operation(store, async () => true);
  const leases = new Map<string, Promise<() => void>>();
  const retain = async (ref: string): Promise<void> => {
    let lease = leases.get(ref);
    if (!lease) { lease = lifecycle.acquire(ref); leases.set(ref, lease); }
    await lease;
  };
  const retainExisting = async (ref: string): Promise<boolean> => {
    // Reserve the operation lease first, including concurrent calls for one ref.
    // The short existence lease can then close without releasing that boundary.
    await retain(ref);
    const existing = await lifecycle.acquireExisting(ref);
    if (!existing) return false;
    existing();
    return true;
  };
  const scoped: WorkspaceSnapshotIO = {
    putSnapshot: async input => { await retain(input.digest); return store.putSnapshot(input); },
    getSnapshot: async ref => { await retain(ref); return store.getSnapshot(ref); },
    ...(store.validateSnapshot ? { validateSnapshot: async (ref: string, digest: string, count: number) => {
      await retain(ref); return store.validateSnapshot!(ref, digest, count);
    } } : {}),
    ...(store.getSnapshotPage ? { getSnapshotPage: async (...args: Parameters<NonNullable<WorkspacePublicSnapshotStore['getSnapshotPage']>>) => {
      await retain(args[0]); return store.getSnapshotPage!(...args);
    } } : {}),
  };
  try { return await operation(scoped, retainExisting); }
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

export function snapshotHash(ref: string): string {
  const trimmed = ref.trim();
  const hash = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid shared-memory public snapshot ref ${ref}`);
  }
  return hash.toLowerCase();
}
