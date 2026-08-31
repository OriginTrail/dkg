interface PendingBlobWrite {
  readonly value: string;
  readonly ready: Promise<void>;
}

export interface ContentAddressedBlobSingleFlightOptions {
  /** Create the immutable blob or verify an existing file with the same hash. */
  readonly createOrVerify: (hash: string, value: string) => Promise<void>;
}

/**
 * Coalesces concurrent local writes for one immutable content hash. Completed
 * and failed writes leave no manager state: the blob file itself is durable,
 * while a later caller may verify it or retry after a transient failure.
 */
export class ContentAddressedBlobSingleFlight {
  private readonly pending = new Map<string, PendingBlobWrite>();

  constructor(private readonly options: ContentAddressedBlobSingleFlightOptions) {}

  async createOrVerify(hash: string, value: string): Promise<void> {
    let entry = this.pending.get(hash);
    if (entry) {
      if (entry.value !== value) {
        throw new Error(`Content-addressed blob hash ${hash} has conflicting bytes`);
      }
      await entry.ready;
      return;
    }

    const ready = Promise.resolve().then(() => this.options.createOrVerify(hash, value));
    entry = { value, ready };
    this.pending.set(hash, entry);

    try {
      await ready;
    } finally {
      if (this.pending.get(hash) === entry) this.pending.delete(hash);
    }
  }
}
