// SPDX-License-Identifier: Apache-2.0
import { normalizeSyncAdmissionSource, type SyncAdmissionSource } from './sync/policy.js';
import { activeSyncAdmissionSource, recordSyncSingleFlightJoin, type SyncSingleFlightScope } from './sync/attempt-telemetry.js';

type InFlightSyncSingleFlight = {
  promise: Promise<unknown>;
  /** Same contract as {@link InFlightSyncPageFetch.ownerSource}. */
  ownerSource: SyncAdmissionSource;
};

const inFlightSyncSingleFlightsByAgent = new WeakMap<object, Map<string, InFlightSyncSingleFlight>>();

export function runSyncSingleFlight<T>(
  agent: object,
  key: string,
  factory: () => Promise<T>,
  meta: { scope: SyncSingleFlightScope; source?: SyncAdmissionSource; fresh?: boolean },
): Promise<T> {
  let inFlight = inFlightSyncSingleFlightsByAgent.get(agent);
  if (!inFlight) {
    inFlight = new Map();
    inFlightSyncSingleFlightsByAgent.set(agent, inFlight);
  }
  const { scope } = meta;
  const joinerSource = normalizeSyncAdmissionSource(meta.source ?? activeSyncAdmissionSource());
  const existing = inFlight.get(key);
  if (existing && meta.fresh === true) {
    const after = () => runSyncSingleFlight(agent, key, factory, { ...meta, fresh: false });
    return existing.promise.then(after, after);
  }
  if (existing) {
    // Recorded at MAP-HIT time, before any bytes move: a join is a decision to
    // share work, and by the time the shared promise settles there is nothing
    // left to attribute.
    recordSyncSingleFlightJoin({
      scope,
      ownerSource: existing.ownerSource,
      joinerSource,
    });
    return existing.promise as Promise<T>;
  }

  // Mirrors the page-fetch map's `let entry!` idiom below: the cleanup closure
  // must compare the ENTRY it created, not the promise, so a later generation
  // for the same key cannot be evicted by an earlier one's `finally`.
  let entry!: InFlightSyncSingleFlight;
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlight.get(key) === entry) {
        inFlight.delete(key);
      }
    });
  entry = { promise, ownerSource: joinerSource };
  inFlight.set(key, entry);
  return promise;
}

export function syncSingleFlightKey(scope: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ scope, ...fields });
}
