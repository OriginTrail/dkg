/**
 * What the publisher retention sweep may do inside the queue's claim transaction (OT-RFC-73 P11).
 *
 * The publisher queue serializes admission, claims, retries, clears and every other mutation of the control graph in ONE claim transaction
 * (`AsyncLiftClaimCoordinator.runClaimTransaction`, under the journal's public operation). Retention must judge a lifecycle key's records and delete them INSIDE it:
 * an admission, a claim or a reaccept that interleaved would otherwise change the key between the judgement and the delete. This module is the narrow window the sweep
 * gets onto that transaction; the publisher hands it out (`TripleStoreAsyncLiftPublisher.retentionAccess()`), so the sweep itself holds no claim machinery and no
 * second way to remove a job exists:
 *  - `siblings(key)` reads the records of a key exactly as admission reads them (`vmPublishAdmissionCandidates`, the control path), so the sweep judges the very
 *    records admission would bind; and it refuses a key whose read holds two records of one job id, of which admission sees the one the engine's row order puts last
 *    (online review 4396325296);
 *  - `remove(jobId, confirm)` removes one job through the job's own transition scope (`commitRemoval`, the path `clear` and `clearTerminalJob` take): under the job lock,
 *    from a fresh read, and only if `confirm` accepts that read. The journal is never touched.
 * A job lock is taken per removal inside the claim transaction (never the claim lock again), in the global-claim-then-job order every other mutation uses.
 */
import { controlStoreOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJob, PersistedLiftJob } from './lift-job.js';
import type { AsyncLiftClaimCoordinator } from './async-lift-claim-session.js';
import type { AsyncLiftJournalCompletion } from './async-lift-journal-completion.js';
import type { LiftJobListingSelectors } from './lift-job-listing-selectors.js';

export const LIFT_RETENTION_SIBLINGS_SOURCE = 'publisher.asyncLift.retention.siblings';

export type LiftRetentionRemoval = 'removed' | 'missing' | 'changed';

export interface LiftRetentionTransaction {
  /**
   * The records of one lifecycle key as admission reads them (all states, the control path). Throws when a record cannot be decoded, as admission does, and when the read
   * holds two records of one job id (a payload under a subject that is not its job's, or two payloads of one job), which admission does not: it shows one of them.
   */
  siblings(lifecycleKey: string): Promise<PersistedLiftJob[]>;
  /** Remove one job under its job lock, from a fresh read: `missing` if it is gone, `changed` if `confirm` refused the fresh record. */
  remove(jobId: string, confirm: (current: LiftJob) => boolean): Promise<LiftRetentionRemoval>;
}

export interface LiftRetentionAccess {
  /** The queue's store object (the scan, the verify reads and the flush go through it) and its graphs. */
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly walletLockGraphUri: string;
  /** Run `work` inside the claim transaction. The transaction is closed when `work` settles. */
  runClaimTransaction<T>(work: (tx: LiftRetentionTransaction) => Promise<T>): Promise<T>;
}

export interface LiftRetentionAccessDeps {
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly walletLockGraphUri: string;
  readonly ensureGraph: () => Promise<void>;
  readonly journal: AsyncLiftJournalCompletion;
  readonly claims: AsyncLiftClaimCoordinator;
  readonly selectors: LiftJobListingSelectors;
}

/** The retention capability, segregated off the base publisher contract like its siblings: the daemon's admission instance hands it to the sweep. */
export interface VmPublishRetentionAccess {
  retentionAccess(): LiftRetentionAccess;
}

export function createLiftRetentionAccess(deps: LiftRetentionAccessDeps): LiftRetentionAccess {
  return {
    store: deps.store,
    graphUri: deps.graphUri,
    walletLockGraphUri: deps.walletLockGraphUri,
    runClaimTransaction: (work) => deps.journal.runPublicOperation(async (owner) => {
      await deps.ensureGraph();
      return await deps.claims.runClaimTransaction(owner, async (section) => await work({
        siblings: (lifecycleKey) => deps.selectors.vmPublishCandidates(lifecycleKey, controlStoreOptions('publisher', LIFT_RETENTION_SIBLINGS_SOURCE), true),
        remove: (jobId, confirm) => deps.claims.runNestedJobTransaction(section, jobId, async (transaction): Promise<LiftRetentionRemoval> => {
          if (transaction.kind === 'missing') return 'missing';
          if (transaction.kind !== 'present' || !confirm(transaction.current)) return 'changed';
          await transaction.scope.commitRemoval();
          return 'removed';
        }),
      }));
    }),
  };
}
