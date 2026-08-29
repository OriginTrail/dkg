interface ContentAddressedBlobLease {
  readonly hash: string;
  users: number;
  /** Serialized create/verify lifecycle for this content hash. */
  ready: Promise<void>;
}

declare const CONTENT_ADDRESSED_BLOB_LEASE_SCOPE: unique symbol;

/** Opaque one-shot lifecycle token owned by the manager that created it. */
export interface ContentAddressedBlobLeaseScope {
  readonly [CONTENT_ADDRESSED_BLOB_LEASE_SCOPE]: true;
}

interface ContentAddressedBlobLeaseScopeState {
  readonly leases: Map<string, ContentAddressedBlobLease>;
  released: boolean;
}

export interface ContentAddressedBlobLeaseManagerOptions {
  /** Create or verify the immutable blob. */
  readonly createOrVerify: (hash: string, value: string) => Promise<boolean>;
}

/**
 * Coordinates content-addressed blob creation across concurrent store
 * mutations. A scope represents one mutation attempt. Release deliberately
 * does not remove blobs from the shared content-addressed namespace: another
 * store instance or process may already have committed the same hash. Orphan
 * reclamation therefore belongs to future reference-aware garbage collection.
 */
export class ContentAddressedBlobLeaseManager {
  private readonly active = new Map<string, ContentAddressedBlobLease>();
  private readonly scopes = new WeakMap<
    ContentAddressedBlobLeaseScope,
    ContentAddressedBlobLeaseScopeState
  >();

  constructor(private readonly options: ContentAddressedBlobLeaseManagerOptions) {}

  createScope(): ContentAddressedBlobLeaseScope {
    const scope = Object.freeze(Object.create(null)) as ContentAddressedBlobLeaseScope;
    this.scopes.set(scope, { leases: new Map(), released: false });
    return scope;
  }

  async acquire(
    hash: string,
    value: string,
    scope: ContentAddressedBlobLeaseScope,
  ): Promise<void> {
    const scopeState = this.requireOpenScope(scope);
    const scoped = scopeState.leases.get(hash);
    if (scoped) {
      await scoped.ready;
      return;
    }

    let lease = this.active.get(hash);
    if (!lease) {
      lease = {
        hash,
        users: 0,
        ready: Promise.resolve(),
      };
      this.active.set(hash, lease);
    }
    lease.users += 1;
    scopeState.leases.set(hash, lease);

    const state = lease;
    // Serialize local create/verify calls. Cross-process safety comes from the
    // content-addressed file's exclusive create and immutable verification.
    const ready = state.ready.then(async () => {
      await this.options.createOrVerify(hash, value);
    });
    state.ready = ready;
    await ready;
  }

  async release(scope: ContentAddressedBlobLeaseScope): Promise<void> {
    const scopeState = this.requireOpenScope(scope);
    // Close ownership before awaiting outstanding verification so concurrent /
    // double releases cannot decrement the same leases twice.
    scopeState.released = true;
    const settled: Promise<void>[] = [];
    for (const state of scopeState.leases.values()) {
      state.users -= 1;
      if (state.users === 0) {
        settled.push(state.ready.finally(() => {
          if (state.users === 0 && this.active.get(state.hash) === state) {
            this.active.delete(state.hash);
          }
        }));
      }
    }
    await Promise.all(settled);
  }

  private requireOpenScope(
    scope: ContentAddressedBlobLeaseScope,
  ): ContentAddressedBlobLeaseScopeState {
    const state = this.scopes.get(scope);
    if (!state) {
      throw new Error('Content-addressed blob lease scope belongs to a different manager');
    }
    if (state.released) {
      throw new Error('Content-addressed blob lease scope has already been released');
    }
    return state;
  }
}
