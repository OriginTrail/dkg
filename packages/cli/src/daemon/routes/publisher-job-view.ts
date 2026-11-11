// daemon/routes/publisher-job-view.ts
//
// A publish job as the job routes answer it: the stored record, except a failure reason stored before
// reasons were bounded. That one is cut to the bound the publisher applies when it records a failure
// (`jobFailureReason`: at most 512 characters, without transaction payloads, long hex or request
// details, any URL reduced to its host). A job recorded since is already bounded, so for it the view
// is the stored record itself.

import { jobFailureReason, type IntentLookupResult, type PersistedLiftJob } from '@origintrail-official/dkg-publisher';

export function publisherJobView<T extends PersistedLiftJob>(job: T): T {
  const { failure } = job as { failure?: { message?: unknown } };
  if (typeof failure?.message !== 'string') return job;
  const message = jobFailureReason(failure.message);
  return message === failure.message ? job : { ...job, failure: { ...failure, message } } as T;
}

/** The jobs an intent lookup answers with, each as {@link publisherJobView}; any other answer is left as it is. */
export function publisherIntentLookupView(lookup: IntentLookupResult): IntentLookupResult {
  if (lookup.kind === 'active') {
    return { ...lookup, job: publisherJobView(lookup.job), superseded: lookup.superseded.map(publisherJobView) };
  }
  if (lookup.kind === 'superseded' || lookup.kind === 'conflict') {
    return { ...lookup, jobs: lookup.jobs.map(publisherJobView) };
  }
  return lookup;
}
