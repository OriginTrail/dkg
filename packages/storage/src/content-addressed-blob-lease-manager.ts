export interface ContentAddressedBlobLease {
  readonly hash: string;
  users: number;
  preserve: boolean;
  created: boolean;
  /** Serialized create/remove lifecycle for this content hash. */
  ready: Promise<void>;
}

export type ContentAddressedBlobLeaseScope = Map<string, ContentAddressedBlobLease>;

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

  constructor(private readonly options: ContentAddressedBlobLeaseManagerOptions) {}

  createScope(): ContentAddressedBlobLeaseScope {
    return new Map();
  }

  async acquire(
    hash: string,
    value: string,
    scope: ContentAddressedBlobLeaseScope,
  ): Promise<void> {
    const scoped = scope.get(hash);
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
    scope.set(hash, lease);

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
    const cleanup: Promise<void>[] = [];
    for (const state of scope.values()) {
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
}
