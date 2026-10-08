// SPDX-License-Identifier: Apache-2.0

import type { ActiveLiftJobClaim } from './async-lift-publisher-types.js';
import type { LiftJob, LiftJobClaimed, LiftJobState } from './lift-job.js';

/**
 * What a committed write returns: the canonical record in the lifecycle state of its candidate.
 * Persistence rebuilds the record through the restart schema, so a narrower refinement the caller
 * held (a live claim fence, a request subtype) is not promised to survive. A caller that needs
 * one re-establishes it with a check, such as `requireActiveLiftJobClaim`.
 */
export type CommittedLiftJob<T extends LiftJob = LiftJob> = LiftJobInState<T['status']>;

type LiftJobInState<S extends LiftJobState> = Extract<LiftJob, { readonly status: S }>;

/** Narrow a canonical record to the lifecycle state of its write candidate, by its discriminant. */
export function committedLiftJob<T extends LiftJob>(canonical: LiftJob, candidate: T): CommittedLiftJob<T> {
  if (!isInState<T['status']>(canonical, candidate.status)) {
    throw new Error(`Canonical LiftJob is ${canonical.status}; its write candidate was ${candidate.status}`);
  }
  return canonical;
}

function isInState<S extends LiftJobState>(job: LiftJob, status: S): job is LiftJobInState<S> {
  return job.status === status;
}

/** A committed claim is live worker authority only while it still carries its token and lease. */
export function requireActiveLiftJobClaim(committed: LiftJobClaimed): ActiveLiftJobClaim {
  const { claimToken, claimLeaseExpiresAt } = committed.claim;
  if (!claimToken || typeof claimLeaseExpiresAt !== 'number') {
    throw new Error(`Committed claim of LiftJob ${committed.jobId} carries no ownership fence`);
  }
  return { ...committed, claim: { ...committed.claim, claimToken, claimLeaseExpiresAt } };
}
