import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type {
  FinalizationRecoveryEntry,
  FinalizationRecoveryStore,
} from './finalization-recovery-store.js';

export type FinalizationPublisherAuthorityStore = Pick<
  FinalizationRecoveryStore,
  'get' | 'recordPendingTrustedPublisher' | 'recordTrustedPublisher'
>;

export type FinalizationPublisherAuthorityLiveEntry = FinalizationRecoveryEntry & {
  readonly state: 'RECEIVED' | 'VERIFIED' | 'REORGED';
};

export type FinalizationPublisherAuthorityTarget =
  | {
      readonly kind: 'pending';
      readonly key: string;
      readonly ual: string;
    }
  | {
      readonly kind: 'live';
      readonly entry: FinalizationPublisherAuthorityLiveEntry;
    };

interface FinalizationPublisherAuthorityProbeIdentity {
  readonly key: string;
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
    identity.key,
    identity.generation,
    identity.sourcePeerId,
  ]);
}

function isLiveEntry(
  entry: FinalizationRecoveryEntry,
): entry is FinalizationPublisherAuthorityLiveEntry {
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
    readonly store: FinalizationPublisherAuthorityStore;
    readonly target: FinalizationPublisherAuthorityTarget;
    readonly sourcePeerId: string;
    readonly prepareInput: PrepareInput;
  }): Promise<FinalizationPublisherAuthorityObservation<Prepared>> {
    const entry = input.target.kind === 'live' ? input.target.entry : undefined;
    if (entry?.trustedPublisherPeerId) return {};
    const key = input.target.kind === 'live' ? input.target.entry.key : input.target.key;
    const ual = input.target.kind === 'live' ? input.target.entry.ual : input.target.ual;
    const probeKey = probeCacheKey({
      key,
      generation: input.target.kind === 'live' ? input.target.entry.generation : 'pending',
      sourcePeerId: input.sourcePeerId,
    });
    if (this.failedProbes.has(probeKey)) return {};

    let prepared: Prepared | undefined;
    try {
      prepared = await this.options.prepare(input.prepareInput);
    } catch (error) {
      this.options.log.info(
        `Finalization recovery deferred publisher authority check for ${ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
    // Preparation can be temporarily unavailable while the workspace arrives.
    // Do not turn that transient absence into a generation-scoped negative probe.
    if (!prepared) return {};
    if (input.sourcePeerId !== prepared.publisherPeerId) {
      this.failedProbes.set(probeKey, true);
      return { prepared };
    }

    try {
      if (input.target.kind === 'live') {
        if (await input.store.recordTrustedPublisher(
          input.target.entry.key,
          input.target.entry.generation,
          prepared.publisherPeerId,
        )) return { prepared };
      } else if (await input.store.recordPendingTrustedPublisher(
        input.target.key,
        prepared.publisherPeerId,
      )) {
        return { prepared };
      }

      // Promotion is independent of the per-entry recovery lock. If it moved
      // the row after admission, preserve the same monotonic evidence there.
      const promoted = await input.store.get(key);
      if (
        promoted
        && isLiveEntry(promoted)
        && await input.store.recordTrustedPublisher(
          promoted.key,
          promoted.generation,
          prepared.publisherPeerId,
        )
      ) return { prepared };
      this.options.log.warn(
        `Finalization recovery inbox refused publisher authority for ${ual}`,
      );
    } catch (error) {
      this.options.log.warn(
        `Finalization recovery pending publisher authority commit failed for ${ual}: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { prepared };
  }
}
