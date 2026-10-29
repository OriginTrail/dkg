/**
 * The share queue's retention sweep, built for the daemon's admission instance (OT-RFC-73 P10b, plan section 5.3).
 *
 * The core (`createShareRetention`, P10a) protects a job whose admission outcome is still uncertain through the queue's OWN admission coordinator, which is keyed on
 * the store object the queue was built with and on its graph. Two things follow, and this factory is where they are made true:
 *  - the queue must exist before the sweep. `agent.promoteQueue` makes it on first access, over `agent.store`, so the factory reads it first;
 *  - the sweep is built over `agent.store`, the object `dkg-agent.ts` hands to `TripleStoreAsyncPromoteQueue`, and over nothing else (not the raw store, not a
 *    wrapper): a coordinator made for another object is empty, and an uncertain admission would silently stop protecting its job.
 *
 * Mode `off` builds nothing and touches neither the agent nor the store.
 *
 * What may be deleted is decided by the core, never here. For the cancelled class (P10a's final rule) the core deletes a job only when every attempt is proven unstarted
 * (`attempt.count` equals `preparationAttempts`, or nothing was ever claimed) at an integer `formatVersion` of 2 or more; a legacy format is kept. Two limits belong to the
 * operator and are stated in packages/publisher/docs/async-queue-internals.md (share sweep limits): `recover()` followed by `cancel()` erases the history the class rests on,
 * and "proven unstarted" means only that `promoteStarted` and `swmInserted` were false when the attempt ended.
 *
 * If the core still refuses with `ShareRetentionAdmissionUnavailableError` (the queue was not made over `agent.store`: a wiring defect, not something an operator can
 * configure away), the factory logs it as an error, naming the cause, and returns no sweep. The daemon keeps running with share retention not started. That is the
 * deliberate choice: retention is an optional janitor and not starting it is the safe side (nothing is judged, nothing is deleted, every row stays), whereas
 * stopping a node that is admitting and promoting shares because its janitor could not be wired would trade a harmless omission for an outage. A bad VALUE in the
 * config is different and is refused at startup (retention-config.ts): the operator can fix it at once, and a node must not run for weeks believing a typo is a setting.
 */
import { ShareRetentionAdmissionUnavailableError, createShareRetention, type ShareRetentionCounters } from '@origintrail-official/dkg-publisher';
import type { RetentionSweep, RetentionSweepContext, RetentionSweepCounters, RetentionSweepFactory } from './retention-timer.js';

/** The core's counters in the shape the periodic line reads. */
function toSweepCounters(counters: ShareRetentionCounters): RetentionSweepCounters {
  const pass = counters.lastCompletePass;
  return {
    deleted: counters.deleted, kept: counters.kept, skipped: counters.skipped, errors: counters.errors,
    lastCompletePass: pass ? { scanned: pass.scanned, wouldDelete: pass.wouldDelete, deleted: pass.deleted } : null,
  };
}

export function createShareRetentionSweep({ agent, settings, log }: RetentionSweepContext): RetentionSweep | undefined {
  const share = settings.share;
  if (share.mode === 'off') return undefined;
  // The queue is made lazily, over `agent.store`, together with its admission coordinator: read it before the sweep looks that coordinator up.
  if (!agent.promoteQueue) throw new Error('the share promote queue is unavailable');
  try {
    const retention = createShareRetention({
      store: agent.store,
      mode: share.mode,
      intervalMs: share.intervalMs,
      batchSize: share.batchSize,
      succeededMaxAgeMs: share.succeededMaxAgeMs,
      benignFailedMaxAgeMs: share.benignFailedMaxAgeMs,
      rescanIntervalMs: share.rescanIntervalMs,
    });
    return {
      queue: 'share', mode: share.mode, intervalMs: share.intervalMs,
      runBatch: () => retention.runBatch(),
      counters: () => toSweepCounters(retention.counters()),
    };
  } catch (cause) {
    if (!(cause instanceof ShareRetentionAdmissionUnavailableError)) throw cause;
    log(`[error] [retention] share retention (mode=${share.mode}) was NOT started - ${cause.code}: ${cause.message}. `
      + 'The daemon keeps running with share retention off: nothing is judged or deleted. This is a wiring defect (the sweep was not created over the store object '
      + 'the promote queue was built with), not a configuration error; please report it.');
    return undefined;
  }
}

export const shareRetentionSweepFactory: RetentionSweepFactory = { queue: 'share', create: createShareRetentionSweep };
