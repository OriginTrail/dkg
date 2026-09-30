import { mkdir, realpath, stat } from 'node:fs/promises';
import { ENTITY_SHARE_METADATA_PREDICATES as F } from './entity-share-metadata.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore, WorkspaceSnapshotIO } from './workspace-snapshot-store.js';

/** The one lease primitive: a shared lease on a snapshot digest, released by calling the result. */
type SnapshotLeaseAcquirer = (ref: string) => Promise<() => void>;

interface WorkspaceSnapshotLifecycleMembers {
  /**
   * Whether the snapshot payload exists, checked without decoding it. This is the authoritative
   * existence probe, so it is consulted whether or not the store also offers `operationLease`.
   *
   * It resolves `false` ONLY when the snapshot is absent, and the caller then fetches it again.
   * Every other outcome must reject: a file that is present but cannot be opened (EACCES, EIO, not a
   * regular file), an exhausted resource (EMFILE) or a failing lease gate. The caller must not read
   * a rejection as "absent", because fetching a copy does not repair a present file (a write skips an
   * existing path), so the operation would report success while reads keep failing.
   *
   * Any lease the check needs stays inside the store: it is taken and released before this resolves,
   * so the caller never owns one. What holds a file for a whole operation is `operationLease`.
   */
  snapshotExists(ref: string): Promise<boolean>;
  markPublished(refs: readonly string[]): Promise<void>;
}

/**
 * A store opts into the complete leasing/retirement contract, or keeps its own policy (a store
 * without a `lifecycle` at all).
 *
 * `operationLease` is the lease primitive itself and the only operation-scope capability: when a
 * store offers it, an operation scope takes it once per digest the operation touches and holds it
 * until the whole operation (metadata commit included) ends. A store that omits it keeps its own
 * retention policy, and the scope takes no operation-long lease. The scope reads nothing else to
 * decide this, in particular not `finalizedCleanupEnabled`.
 *
 * The two are tied together where it matters: a lifecycle that reports finalized cleanup enabled must
 * offer `operationLease` (retirement scheduling and ACK-copy cleanup rely on operations holding their
 * files), so the type rejects one that does not. A cleanup-disabled lifecycle may still offer it.
 *
 * The type cannot see a value built outside the compiler (plain JavaScript, a cast, an object written
 * for the earlier `acquire`/`acquireExisting` shape). {@link assertWorkspaceSnapshotLifecycle} refuses
 * such a lifecycle where it is first used, with a message that names the new contract, instead of
 * letting a cleanup-enabled store run without operation-long leases.
 */
export type WorkspaceSnapshotLifecycle = WorkspaceSnapshotLifecycleMembers & (
  | { readonly finalizedCleanupEnabled: true; readonly operationLease: SnapshotLeaseAcquirer }
  | { readonly finalizedCleanupEnabled: false; readonly operationLease?: SnapshotLeaseAcquirer }
);

const LIFECYCLE_CONTRACT_NOTE = 'The lifecycle contract is operationLease(ref) for operation-long leases and '
  + 'snapshotExists(ref): Promise<boolean> for the existence probe; they replace acquire(ref) and acquireExisting(ref) '
  + 'of an earlier development shape. See docs/use-dkg/swm-public-snapshot-gc.md.';

/**
 * Fail loudly on a lifecycle that does not honor the contract, instead of running without the
 * protection it promises. The type already rejects these shapes at compile time; this covers a value
 * the compiler never saw. A cleanup-disabled lifecycle may omit `operationLease` (that is its policy),
 * so only a cleanup-enabled one is required to offer it. The contract has never shipped in a release, so
 * an object written for the earlier shape is not adapted: it is refused, and the message says what to change.
 */
export function assertWorkspaceSnapshotLifecycle(lifecycle: WorkspaceSnapshotLifecycle | undefined): void {
  if (!lifecycle) return;
  const shape = lifecycle as unknown as Readonly<Record<string, unknown>>;
  const problems: string[] = [];
  if (shape.finalizedCleanupEnabled && typeof shape.operationLease !== 'function') {
    problems.push('It reports finalizedCleanupEnabled but offers no operationLease(ref), so operations would run without '
      + 'operation-long leases and the collector could remove a snapshot between its write and the metadata commit that references it.');
    if (typeof shape.acquire === 'function') {
      problems.push('It still has the earlier acquire(ref) method, which is no longer read: offer the same lease as operationLease(ref).');
    }
  }
  if (typeof shape.snapshotExists !== 'function') problems.push('It offers no snapshotExists(ref).');
  if (problems.length > 0) throw new Error(`Invalid snapshot lifecycle. ${problems.join(' ')} ${LIFECYCLE_CONTRACT_NOTE}`);
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
  readonly validateSnapshot: WorkspaceSnapshotIO['validateSnapshot'];
  readonly getSnapshotPage: WorkspaceSnapshotIO['getSnapshotPage'];

  /** Read once, where it is checked: a later swap of `store.lifecycle` or removal of a method cannot bypass the check. */
  private readonly lifecycle: WorkspaceSnapshotLifecycle | undefined;

  private constructor(private readonly store: WorkspacePublicSnapshotStore) {
    // Every operation starts here, so a lifecycle that breaks the contract is refused before any I/O.
    this.lifecycle = store.lifecycle;
    assertWorkspaceSnapshotLifecycle(this.lifecycle);
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

  /** Hold the store's operation-long lease, if it offers one, until the scope closes. */
  private async retain(ref: string): Promise<void> {
    const lifecycle = this.lifecycle;
    // The same check as at the start of the scope: a method removed from the lifecycle while the operation
    // runs fails here, loudly, instead of the operation carrying on without its lease.
    assertWorkspaceSnapshotLifecycle(lifecycle);
    if (!lifecycle?.operationLease) return;
    const hash = snapshotHash(ref);
    let lease = this.leases.get(hash);
    if (!lease) { lease = lifecycle.operationLease(ref); this.leases.set(hash, lease); }
    await lease;
  }

  async retainExisting(ref: string): Promise<boolean> {
    await this.retain(ref);
    // The existence probe is separate from the lease policy: a store that takes no operation-long
    // lease can still have lost the file (for example to pressure GC), and reuse must then fetch it again.
    const lifecycle = this.lifecycle;
    if (!lifecycle) return true; // A custom I/O store without a lifecycle owns its retention policy.
    // Only the store's explicit `false` means "absent". A probe that fails for any other reason
    // (EACCES, EIO, EMFILE, a gate failure, a defect) propagates: fetching a copy would not repair a
    // file that is present but unreadable, because a write skips an existing path.
    const exists: unknown = await lifecycle.snapshotExists(ref);
    // Not a boolean is a broken probe, never "absent": for example the earlier acquireExisting, which
    // resolved a lease (truthy, never released here) or undefined, renamed without changing its body.
    if (typeof exists !== 'boolean') {
      throw new TypeError('Snapshot lifecycle snapshotExists(ref) must resolve a boolean (true when the snapshot is present, '
        + `false when it is absent), but it resolved ${exists === null ? 'null' : typeof exists}. It replaces acquireExisting(ref), `
        + 'which resolved a lease or undefined. See docs/use-dkg/swm-public-snapshot-gc.md.');
    }
    return exists;
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
