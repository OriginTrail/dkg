/**
 * OT-RFC-73 P11: the retention sweep under test, as the retention tests drive it, and the log reads that name what it did.
 */
import { expect } from 'vitest';
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

/** Call `runBatch()` until the pass is over (nothing left to judge) or `max` calls were made; returns every result. `afterBatch` runs after each call. */
export async function drain(
  retention: PublisherRetention, max = 200, afterBatch?: (res: PublisherRetentionBatchResult) => Promise<void>,
): Promise<PublisherRetentionBatchResult[]> {
  const results: PublisherRetentionBatchResult[] = [];
  for (let i = 0; i < max; i++) {
    const res = await retention.runBatch();
    results.push(res);
    await afterBatch?.(res);
    if (res.error || (!res.hasMore && res.scanned === 0)) break;
  }
  return results;
}

/**
 * The suffix rule of one key, asserted: `order` is the key's records oldest first, `left` the job ids still stored. What is left of the key is a suffix of its order
 * (nothing went ahead of an older record that stays), so its newest record is there until the last one goes.
 */
export function expectKeySuffix(left: Iterable<string>, order: readonly string[], when: string): void {
  const stored = new Set(left);
  const remaining = order.filter((id) => stored.has(id));
  expect(remaining, `${when}: what is left of the key is a suffix of its order`).toEqual(order.slice(order.length - remaining.length));
  if (remaining.length > 0) expect(stored.has(order.at(-1)!), `${when}: the newest record is still there`).toBe(true);
}

/** The subjects a retention verify read asked for. */
export const verifiedSubjects = (log: readonly Logged[]): string[] =>
  bySource(log, `${RETENTION}verify`).flatMap((entry) => [...(/VALUES \?job \{([^}]*)\}/.exec(entry.text)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1]!));
/** The job ids the sweep removed (the job subject deletes issued through the removal scope), in order. */
export const removedJobIds = (log: readonly Logged[]): string[] =>
  bySource(log, 'publisher.asyncLift.deleteJob').filter((entry) => entry.kind === 'deleteByPatternWithoutCount')
    .map((entry) => (JSON.parse(entry.text) as { subject: string }).subject.replace('urn:dkg:publisher:lift-job:', ''));
