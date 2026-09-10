import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryStore,
} from './finalization-recovery-store.js';

export interface FinalizationPublisherAuthorityProbeIdentity {
  readonly entryKey: string;
  readonly generation: number | 'pending';
  readonly sourcePeerId: string;
}

export interface FinalizationPublisherAuthorityObservation<Prepared> {
  readonly prepared?: Prepared;
}

interface FinalizationPublisherAuthorityObserverOptions<PrepareInput, Prepared> {
  readonly maxFailedProbes: number;
  readonly prepare: (input: PrepareInput) => Promise<Prepared | undefined>;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

function probeCacheKey(identity: FinalizationPublisherAuthorityProbeIdentity): string {
  return JSON.stringify([
    identity.entryKey,
    identity.generation,
    identity.sourcePeerId,
  ]);
}

function isLiveEntry(entry: FinalizationRecoveryEntry): boolean {
  return entry.state === 'RECEIVED'
    || entry.state === 'VERIFIED'
    || entry.state === 'REORGED';
}

/** Owns bounded failed-probe state and publisher-authority persistence races. */
export class FinalizationPublisherAuthorityObserver<
  PrepareInput,
  Prepared extends { readonly publisherPeerId: string },
> {
  private readonly failedProbes: BoundedLruCache<string, true>;

  constructor(
    private readonly options: FinalizationPublisherAuthorityObserverOptions<PrepareInput, Prepared>,
  ) {
    this.failedProbes = new BoundedLruCache(options.maxFailedProbes);
  }

  async observe(input: {
    readonly store: FinalizationRecoveryStore;
    readonly identity: FinalizationPublisherAuthorityProbeIdentity;
    readonly ual: string;
    readonly prepareInput: PrepareInput;
    readonly entry?: FinalizationRecoveryEntry;
  }): Promise<FinalizationPublisherAuthorityObservation<Prepared>> {
    if (input.entry?.trustedPublisherPeerId) return {};
    const probeKey = probeCacheKey(input.identity);
    if (this.failedProbes.has(probeKey)) return {};

    let prepared: Prepared | undefined;
    try {
      prepared = await this.options.prepare(input.prepareInput);
    } catch (error) {
      this.options.log.info(
        `Finalization recovery deferred publisher authority check for ${input.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
    if (!prepared || input.identity.sourcePeerId !== prepared.publisherPeerId) {
      this.failedProbes.set(probeKey, true);
      return { prepared };
    }

    try {
      if (input.entry) {
        if (await input.store.recordTrustedPublisher(
          input.identity.entryKey,
          input.entry.generation,
          prepared.publisherPeerId,
        )) return { prepared };
      } else if (await input.store.recordPendingTrustedPublisher(
        input.identity.entryKey,
        prepared.publisherPeerId,
      )) {
        return { prepared };
      }

      // Promotion is independent of the per-entry recovery lock. If it moved
      // the row after admission, preserve the same monotonic evidence there.
      const promoted = await input.store.get(input.identity.entryKey);
      if (
        promoted
        && isLiveEntry(promoted)
        && await input.store.recordTrustedPublisher(
          input.identity.entryKey,
          promoted.generation,
          prepared.publisherPeerId,
        )
      ) return { prepared };
      this.options.log.warn(
        `Finalization recovery inbox refused publisher authority for ${input.ual}`,
      );
    } catch (error) {
      this.options.log.warn(
        `Finalization recovery pending publisher authority commit failed for ${input.ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { prepared };
  }
}
