/**
 * The publisher queue's retention sweep, built for the daemon's admission instance (OT-RFC-73 P11, plan section 5.3).
 *
 * The core (`createPublisherRetention`) judges and deletes a lifecycle key's records INSIDE the publisher queue's claim transaction, the one that serializes admission,
 * claims, retries and clears. It gets that transaction through one narrow window, `retentionAccess()`, and the window belongs to a publisher INSTANCE: the daemon's
 * admission instance, the one `lifecycle.ts` builds with `createPublisherControlFromStore(agent.store, ...)` and serves the API with. Two things follow, and this factory is
 * where they are made true:
 *  - the sweep is built after that instance and from it, with `publisher.retentionAccess()`, and from nothing else: not a second publisher built on the side, not the
 *    standalone runner's or the offline inspector's instance, and not the raw store. The access carries the instance's own store object (the scan, the verify reads and the
 *    flush go through it) and its own graphs, so the sweep reads and deletes exactly where the queue it protects writes;
 *  - nothing here opens a transaction of its own or removes a job any other way: the core removes a job only through the access, under the job lock, from a fresh read.
 *
 * Mode `off` builds nothing and touches neither the publisher nor the store.
 *
 * What may be deleted is decided by the core, never here: a `finalized` job 7 days after it finished, in the key's oldest-first order and never past an older record of its
 * lifecycle key that is kept (docs/promote-queue-operations.md states the rule and its limits). Every failed job and every job that is not finished is kept.
 *
 * If the sweep cannot be built (the daemon handed in no publisher, or the core refuses a setting) the factory throws, and the starter logs it as an error naming the cause and
 * runs no publisher retention. The daemon keeps running: retention is an optional janitor and not starting it is the safe side (nothing is judged, nothing is deleted, every
 * row stays), whereas stopping a node that is admitting and publishing because its janitor could not be wired would trade a harmless omission for an outage. A bad VALUE in the
 * config is different and is refused at startup (retention-config.ts).
 */
import { createPublisherRetention, type PublisherRetentionCounters } from '@origintrail-official/dkg-publisher';
import type { RetentionSweep, RetentionSweepContext, RetentionSweepCounters, RetentionSweepFactory } from './retention-timer.js';

/** The core's counters in the shape the periodic line reads. */
function toSweepCounters(counters: PublisherRetentionCounters): RetentionSweepCounters {
  const pass = counters.lastCompletePass;
  return {
    deleted: counters.deleted, kept: counters.kept, skipped: counters.skipped, errors: counters.errors,
    lastCompletePass: pass ? { scanned: pass.scanned, wouldDelete: pass.wouldDelete, deleted: pass.deleted } : null,
  };
}

export function createPublisherRetentionSweep({ publisher, settings }: RetentionSweepContext): RetentionSweep | undefined {
  const config = settings.publisher;
  if (config.mode === 'off') return undefined;
  if (typeof publisher?.retentionAccess !== 'function') throw new Error('the daemon admission instance of the publisher queue is unavailable');
  const retention = createPublisherRetention({
    access: publisher.retentionAccess(),
    mode: config.mode,
    intervalMs: config.intervalMs,
    batchSize: config.batchSize,
    finalizedMaxAgeMs: config.finalizedMaxAgeMs,
    rescanIntervalMs: config.rescanIntervalMs,
  });
  return {
    queue: 'publisher', mode: config.mode, intervalMs: config.intervalMs,
    runBatch: () => retention.runBatch(),
    counters: () => toSweepCounters(retention.counters()),
  };
}

export const publisherRetentionSweepFactory: RetentionSweepFactory = { queue: 'publisher', create: createPublisherRetentionSweep };
