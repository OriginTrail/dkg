interface ContentAddressedBlobLease {
  readonly hash: string;
  users: number;
  preserve: boolean;
  created: boolean;
  /** Serialized create/remove lifecycle for this content hash. */
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
  /** Create or verify the blob, returning true only when this call created it. */
  readonly createOrVerify: (hash: string, value: string) => Promise<boolean>;
  readonly remove: (hash: string) => Promise<void>;
}

/**
 * Coordinates content-addressed blob creation and cleanup across concurrent
 * store mutations. A scope represents one mutation attempt; releasing it with
 * `preserve=false` reclaims only blobs created by losing/not-started attempts.
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
        preserve: false,
        created: false,
        ready: Promise.resolve(),
      };
      this.active.set(hash, lease);
    }
    lease.users += 1;
    scopeState.leases.set(hash, lease);

    const state = lease;
    // Chain creation behind pending cleanup. A writer arriving while a losing
    // writer removes this hash waits for removal, then recreates/verifies it
    // before its store mutation can commit.
    const ready = state.ready.then(async () => {
      const created = await this.options.createOrVerify(hash, value);
      state.created ||= created;
    });
    state.ready = ready;
    await ready;
  }

  async release(scope: ContentAddressedBlobLeaseScope, preserve: boolean): Promise<void> {
    const scopeState = this.requireOpenScope(scope);
    // Close ownership before awaiting cleanup so concurrent/double releases
    // cannot decrement the same leases twice.
    scopeState.released = true;
    const cleanup: Promise<void>[] = [];
    for (const state of scopeState.leases.values()) {
      state.preserve ||= preserve;
      state.users -= 1;
      if (state.users !== 0) continue;

      const lifecycle = state.ready.then(async () => {
        // A new acquisition may have joined while cleanup was queued.
        if (state.users !== 0 || !state.created || state.preserve) return;
        await this.options.remove(state.hash);
        state.created = false;
      });
      state.ready = lifecycle;
      cleanup.push(lifecycle.finally(() => {
        // Keep coordination installed through deletion so a concurrent acquire
        // either prevents removal or chains recreation after it.
        if (state.users === 0 && this.active.get(state.hash) === state) {
          this.active.delete(state.hash);
        }
      }));
    }
    await Promise.all(cleanup);
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
