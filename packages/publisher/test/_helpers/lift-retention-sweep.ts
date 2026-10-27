/**
 * OT-RFC-73 P11: the retention sweep under test, as the retention tests drive it, and the log reads that name what it did.
 */
import type { TripleStoreAsyncLiftPublisher } from '../../src/index.js';
import {
  createPublisherRetention, type PublisherRetention, type PublisherRetentionBatchResult, type PublisherRetentionConfig, type PublisherRetentionLogger,
} from '../../src/index.js';
import { DAY, NOW, bySource, type Logged } from './lift-retention-fixtures.js';

export const RETENTION = 'publisher.asyncLift.retention.';

export interface CapturedLog extends PublisherRetentionLogger { readonly infos: string[]; readonly warns: string[] }
export function captureLogger(): CapturedLog {
  const infos: string[] = [], warns: string[] = [];
  return { infos, warns, info: (m) => { infos.push(m); }, warn: (m) => { warns.push(m); } };
}

/**
 * A retention over the publisher's own claim transaction with a fixed wall clock (NOW), a fixed monotonic clock (so the adaptive slice size stays put), a clock guard
 * interval too long to interfere with a test that moves the clock, and a silent logger. `over` replaces any of it.
 */
export function newRetention(publisher: TripleStoreAsyncLiftPublisher, over: Partial<PublisherRetentionConfig> = {}): PublisherRetention {
  return createPublisherRetention({
    access: publisher.retentionAccess(), mode: 'delete', intervalMs: 365 * DAY,
    now: () => NOW, monotonicNow: () => 0, logger: captureLogger(), ...over,
  });
}

/** Call `runBatch()` until the pass is over (nothing left to judge) or `max` calls were made; returns every result. */
export async function drain(retention: PublisherRetention, max = 200): Promise<PublisherRetentionBatchResult[]> {
  const results: PublisherRetentionBatchResult[] = [];
  for (let i = 0; i < max; i++) {
    const res = await retention.runBatch();
    results.push(res);
    if (res.error || (!res.hasMore && res.scanned === 0)) break;
  }
  return results;
}


/** The subjects a retention verify read asked for. */
export const verifiedSubjects = (log: readonly Logged[]): string[] =>
  bySource(log, `${RETENTION}verify`).flatMap((entry) => [...(/VALUES \?job \{([^}]*)\}/.exec(entry.text)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1]!));
/** The job ids the sweep removed (the job subject deletes issued through the removal scope), in order. */
export const removedJobIds = (log: readonly Logged[]): string[] =>
  bySource(log, 'publisher.asyncLift.deleteJob').filter((entry) => entry.kind === 'deleteByPatternWithoutCount')
    .map((entry) => (JSON.parse(entry.text) as { subject: string }).subject.replace('urn:dkg:publisher:lift-job:', ''));
