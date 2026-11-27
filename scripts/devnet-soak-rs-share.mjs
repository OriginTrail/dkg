#!/usr/bin/env node
// The share step of the RS soak's publisher (scripts/devnet-soak-rs-publisher.sh).
//
// It creates the draft and shares it in one request, the one
// `dkg ka create --share` sends, and then does what the node's answer asks of
// a client. The CLI prints only an answer's message, so the soak sends the
// requests itself and decides on the answer's status and recovery fields,
// never on its wording:
//
// - An answer that names a share job (`recoveryStatusUrl`) leaves the share to
//   that job. We poll the job, as scripts/swm-soak-test.sh does for its writes,
//   until it succeeds or fails, or the wait runs out. A job retries a failed
//   attempt after about 60 s and then twice as long each time, so the wait is
//   300 s unless SOAK_SHARE_RECOVERY_WAIT_SEC says otherwise. Sharing again
//   meanwhile would only be answered that the job is still active.
// - A retryable answer that names no job: we share the same draft again (the
//   request `dkg ka share` sends) after 1 s, then 2 s and so on, at most five
//   times. The create is never sent again, since the draft is already sealed.
// - A create whose share part did not finish and named no job (a 2xx that
//   lists the share's error, as when the share failed before its job was
//   admitted) says nothing more than the message, so we share the draft
//   explicitly, as the CLI advises, and that answer decides. It counts as
//   the first retry.
// - Any other answer is final.
// The Node publisher owns each attempt and its complete log record.

import { setTimeout as delay } from 'node:timers/promises';
import { pollShareRecoveryJobs } from './lib/swm-soak-accepted-writes.mjs';

/** How many times a share is sent again after a retryable answer that names no share job. */
export const SHARE_RETRY_MAX = 5;
export const RECOVERY_WAIT_ENV = 'SOAK_SHARE_RECOVERY_WAIT_SEC';
/** Long enough for a share job's first two retries (about 60 s, then 120 s, each up to 20% later). */
export const DEFAULT_RECOVERY_WAIT_SEC = 300;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The seconds to wait for a share job, from SOAK_SHARE_RECOVERY_WAIT_SEC. */
export function recoveryWaitSec(env = process.env) {
  const value = env[RECOVERY_WAIT_ENV];
  if (value === undefined || value === '') return DEFAULT_RECOVERY_WAIT_SEC;
  if (!/^(?:0|[1-9]\d{0,5})$/.test(value)) {
    throw new Error(`${RECOVERY_WAIT_ENV} must be a whole number of seconds, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * What a share answer asks of the client, from its status and recovery fields
 * only: `shared`, `follow` (a share job owns the share; its state decides),
 * `repeat` (share the same draft again) or `final`. `createAnswer` marks the
 * answer to the create, whose 2xx means the draft exists and is sealed.
 */
export function shareDisposition(answer, { createAnswer = false } = {}) {
  if (!answer || answer.status === undefined) return { kind: 'final' };
  const body = isRecord(answer.body) ? answer.body : {};
  const ok = answer.status >= 200 && answer.status < 300;
  // The checks `dkg ka create --share` and `dkg ka share` make of a 2xx answer.
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (ok && errors.length === 0 && body.swmShared === true && body.publishReady !== false) return { kind: 'shared' };
  const url = body.recoveryStatusUrl;
  if (typeof url === 'string' && url.startsWith('/api/')) {
    return { kind: 'follow', jobId: typeof body.recoveryJobId === 'string' ? body.recoveryJobId : null, url };
  }
  if (ok && createAnswer) return { kind: 'repeat' };
  if (!ok && body.retryable === true) return { kind: 'repeat' };
  return { kind: 'final' };
}

function detailText(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value)) {
    const parts = [
      typeof value.phase === 'string' ? `phase=${value.phase}` : undefined,
      typeof value.code === 'string' ? `code=${value.code}` : undefined,
      typeof value.message === 'string' ? value.message : undefined,
      typeof value.error === 'string' ? value.error : undefined,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  return JSON.stringify(value);
}

/** One transcript line for an answer, with the fields the decision used and the node's message. */
export function describeAnswer(step, answer) {
  if (answer.error !== undefined) return `[soak] ${step}: no answer (${answer.error})`;
  const body = isRecord(answer.body) ? answer.body : {};
  const fields = [
    `HTTP ${answer.status}`,
    typeof body.code === 'string' ? body.code : undefined,
    typeof body.retryable === 'boolean' ? `retryable=${body.retryable}` : undefined,
    typeof body.recoveryJobId === 'string' ? `share job ${body.recoveryJobId}` : undefined,
    typeof body.recoveryState === 'string' ? `(${body.recoveryState})` : undefined,
    body.swmShared === true ? 'swmShared' : undefined,
  ].filter(Boolean);
  const details = [
    typeof body.error === 'string' ? body.error : undefined,
    ...(Array.isArray(body.errors) ? body.errors.map(detailText) : []),
  ].filter(Boolean);
  return `[soak] ${step}: ${fields.join(' ')}${details.length ? `: ${details.join('; ')}` : ''}`;
}

/**
 * Polls the share job until it settles or `budgetMs` has passed, and returns
 * its record for the publish log. The reader owns transport; `pollOptions`
 * supply the polling clock and interval. `now` also measures the wait.
 */
export async function followShareJob({ jobId, url }, { readJob, budgetMs, log = () => {}, pollOptions = {} }) {
  const now = pollOptions.now ?? Date.now;
  const label = jobId ?? url;
  log(`[soak] share job ${label} owns the share; following it for up to ${Math.round(budgetMs / 1000)}s`);
  const started = now();
  const jobs = [{ jobId, url, state: 'unknown', polls: 0 }];
  const [job] = await pollShareRecoveryJobs(jobs, { budgetMs, ...pollOptions, readJob });
  const record = {
    job: jobId,
    state: job.state,
    settled: job.settled,
    attempts: job.attempts ?? null,
    polls: job.polls,
    waited_s: Math.round((now() - started) / 1000),
    ...(job.pollError ? { poll_error: job.pollError } : {}),
  };
  log(`[soak] share job ${label}: ${record.state}${record.settled ? '' : ' (not settled)'}`
    + `${record.attempts ? ` after ${record.attempts} attempt(s)` : ''}, ${record.waited_s}s, ${record.polls} poll(s)`
    + `${record.poll_error ? `; last poll: ${record.poll_error}` : ''}`);
  return record;
}

/**
 * Creates and shares the draft, then follows the answers as the header says.
 * `create` and `share` return structured client answers; `follow(job)` returns a
 * share job's record as followShareJob does. `progress` holds what the publish
 * log records (`shareRetries`, `recovery`) as it happens. Returns whether the
 * asset is shared.
 */
export async function shareWithClientRule({ contextGraphId, name, quads, create, share, follow, sleep = delay, log = () => {}, progress = {} }) {
  progress.shareRetries = 0;
  progress.recovery = null;
  let answer = await create(contextGraphId, name, { quads, alsoShareSwm: true });
  log(describeAnswer('create and share', answer));
  for (let createAnswer = true; ; createAnswer = false) {
    const next = shareDisposition(answer, { createAnswer });
    if (next.kind === 'shared') return true;
    if (next.kind === 'follow') {
      progress.recovery = await follow({ jobId: next.jobId, url: next.url });
      return progress.recovery.state === 'succeeded';
    }
    if (next.kind !== 'repeat' || progress.shareRetries >= SHARE_RETRY_MAX) return false;
    progress.shareRetries += 1;
    log(`[soak] the share is not done and no share job owns it: sharing the same draft again in ${progress.shareRetries}s (retry ${progress.shareRetries} of ${SHARE_RETRY_MAX})`);
    await sleep(progress.shareRetries * 1000);
    answer = await share(contextGraphId, name);
    log(describeAnswer(`share again, retry ${progress.shareRetries}`, answer));
  }
}
