import { mkdir, realpath, stat } from 'node:fs/promises';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
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
// Admit marker requests in call order even while a cold alias is resolving its
// physical identity. Only lookup/enqueue is ordered globally; marker I/O remains
// concurrent across digests and does not block readers.
let mutationAdmission: Promise<void> = Promise.resolve();
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
  mutate<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    const admitted = mutationAdmission.then(async () => {
      const gate = await this.get();
      return { completion: gate.mutate(hash, operation) };
    });
    mutationAdmission = admitted.then(() => undefined, () => undefined);
    return admitted.then(({ completion }) => completion);
  }
  async tryCollect<T>(hash: string, operation: () => Promise<T>): Promise<T | undefined> {
    return (await this.get()).tryCollect(hash, operation);
  }
}

class SnapshotLifecycleGate {
  private readonly mutations = new Map<string, Promise<unknown>>();
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

  /** FIFO marker mutations across every store/alias, without excluding readers. */
  mutate<T>(hash: string, operation: () => Promise<T>): Promise<T> {
    // Reserve a shared lease even while queued, so GC cannot slip between mutations.
    const lease = this.acquire(hash);
    const previous = this.mutations.get(hash) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const release = await lease;
      try { return await operation(); }
      finally { release(); }
    });
    this.mutations.set(hash, run);
    return run.finally(() => {
      if (this.mutations.get(hash) === run) this.mutations.delete(hash);
    });
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

// Required keys deliberately include optional I/O methods: adding a new store
// operation must also be considered here, rather than silently bypassing leasing.
type CompleteSnapshotIO = { [K in keyof Required<WorkspaceSnapshotIO>]: WorkspaceSnapshotIO[K] };

/** One operation's snapshot I/O and leases, owned and closed by the coordinator. */
export class WorkspaceSnapshotScope implements CompleteSnapshotIO {
  private readonly leases = new Map<string, Promise<() => void>>();
  /** Operation-long leases exist only for finalized cleanup; otherwise the store keeps its own policy.
   * Not named `lifecycle`: the scope is passed where a WorkspacePublicSnapshotStore is expected. */
  private readonly leasing: WorkspaceSnapshotLifecycle | undefined;
  readonly validateSnapshot: WorkspaceSnapshotIO['validateSnapshot'];
  readonly getSnapshotPage: WorkspaceSnapshotIO['getSnapshotPage'];

  private constructor(private readonly store: WorkspacePublicSnapshotStore) {
    this.leasing = store.lifecycle?.finalizedCleanupEnabled ? store.lifecycle : undefined;
    if (store.validateSnapshot) this.validateSnapshot = async (ref, digest, count) => {
      await this.retain(ref);
      return store.validateSnapshot!(ref, digest, count);
    };
    if (store.getSnapshotPage) this.getSnapshotPage = async (ref, offset, limit, options) => {
      await this.retain(ref);
      return store.getSnapshotPage!(ref, offset, limit, options);
    };
  }

  static async run<T>(store: WorkspacePublicSnapshotStore | undefined,
    operation: (scope: WorkspaceSnapshotScope | undefined) => Promise<T>): Promise<T> {
    if (!store) return operation(undefined);
    const scope = new WorkspaceSnapshotScope(store);
    try { return await operation(scope); }
    finally {
      for (const lease of scope.leases.values()) {
        await lease.then(release => release(), () => undefined);
      }
    }
  }

  private async retain(ref: string): Promise<void> {
    const lifecycle = this.leasing;
    if (!lifecycle) return;
    const hash = snapshotHash(ref);
    let lease = this.leases.get(hash);
    if (!lease) { lease = lifecycle.acquire(ref); this.leases.set(hash, lease); }
    await lease;
  }

  async retainExisting(ref: string): Promise<boolean> {
    await this.retain(ref);
    if (!this.leasing) return true; // Cleanup off, or a custom store: it owns its retention policy.
    const existing = await this.leasing.acquireExisting(ref);
    if (!existing) return false;
    existing();
    return true;
  }

  async putSnapshot(input: Parameters<WorkspaceSnapshotIO['putSnapshot']>[0]) {
    await this.retain(input.digest);
    return this.store.putSnapshot(input);
  }

  async getSnapshot(ref: string) {
    await this.retain(ref);
    return this.store.getSnapshot(ref);
  }
}

/** The callback must include the final RDF metadata commit, not just file I/O. */
export const withSnapshotScope = WorkspaceSnapshotScope.run;

/** Bind an orchestration entry point to a scope; its implementation cannot receive
 * a raw store accidentally. The scope closes only after the complete operation. */
export function snapshotOperation<Params extends { publicSnapshotStore?: WorkspacePublicSnapshotStore }, Result>(
  operation: (params: Omit<Params, 'publicSnapshotStore'> & { publicSnapshotStore: WorkspaceSnapshotScope | undefined }) => Promise<Result>,
): (params: Params) => Promise<Result> {
  return params => withSnapshotScope(params.publicSnapshotStore, scope =>
    operation({ ...params, publicSnapshotStore: scope }));
}

/**
 * Bound how long the caller waits for a store query without handing the store
 * an abort signal. A short caller-owned signal on a managed store can restart
 * the store process even when the query already finished (the store layer's own
 * deadline governs the query itself), so the limit is applied on the client side only.
 */
export async function withClientDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function snapshotReferenceCheck(store: TripleStore): (ref: string) => Promise<boolean> {
  return async ref => {
    // Accept the legacy bare hash and case variants as well as the canonical ref.
    // Query every graph: a reference in another CG/operation must prevent deletion.
    const hash = ref.replace(/^sha256:/, '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid snapshot retirement ref');
    const result = await store.query(`ASK {
      GRAPH ?graph {
        { ?subject <${F.publicSnapshotRef}> ?ref }
        UNION {
          ?subject <${F.publicQuadsDigest}> ?ref .
          FILTER NOT EXISTS { ?subject <${F.publicSnapshotGraph}> ?snapshotGraph }
        }
        FILTER(LCASE(STR(?ref)) IN (${JSON.stringify(hash)}, ${JSON.stringify(`sha256:${hash}`)}))
      }
    }`);
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
