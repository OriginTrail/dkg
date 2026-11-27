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
//
//   node scripts/devnet-soak-rs-share.mjs <nodeHome> <contextGraphId> <name> <fixture.nt> <fieldsFile>
//
// The node's API port is read from <nodeHome>/api.port, as the CLI reads it,
// and the bearer token from SOAK_API_AUTH, so it stays off the command line.
// The publish-log fields `share_retries` and `share_recovery` are written to
// <fieldsFile> as JSON members, also when the share fails. The exit status is
// 0 when the asset is shared.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { pollShareRecoveries } from './lib/swm-soak-accepted-writes.mjs';

/** How many times a share is sent again after a retryable answer that names no share job. */
export const SHARE_RETRY_MAX = 5;
export const RECOVERY_WAIT_ENV = 'SOAK_SHARE_RECOVERY_WAIT_SEC';
/** Long enough for a share job's first two retries (about 60 s, then 120 s, each up to 20% later). */
export const DEFAULT_RECOVERY_WAIT_SEC = 300;
/** The CLI's deadline for a request that changes a Knowledge Asset. */
const SHARE_REQUEST_TIMEOUT_MS = 240_000;

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

// The publisher's fixture lines: `<iri> <iri> "literal" .`, with no escapes.
const FIXTURE_LINE = /^<([^<>"\s]+)> <([^<>"\s]+)> ("[^"\\]*") \.$/;

/** The quads of a publisher fixture, as `dkg ka create --input-file` sends them. */
export function fixtureQuads(text) {
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const match = FIXTURE_LINE.exec(line.trim());
    if (!match) throw new Error(`unsupported fixture line: ${line}`);
    return { subject: match[1], predicate: match[2], object: match[3], graph: '' };
  });
}

function readControlNumber(file) {
  try {
    const value = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The node's API, found as the CLI finds it: the port in <home>/api.port.
 * Without one, the error uses the CLI's words, which the soak's summary reads
 * to excuse failures on the node it stops on purpose.
 */
export function nodeApiBase(home) {
  const port = readControlNumber(join(home, 'api.port'));
  if (port) return `http://127.0.0.1:${port}`;
  const pid = readControlNumber(join(home, 'daemon.pid'));
  if (!pid || !isRunning(pid)) throw new Error(`Daemon is not running at ${home}.`);
  throw new Error(`Cannot read API port in ${home}.`);
}

/**
 * POSTs a JSON body and returns the answer, whatever its status, as
 * `{ status, body }` (`body` is null when it is not JSON), or `{ error }`
 * when no answer came: a refused connection, or none within the timeout.
 */
export async function postJson(url, body, { auth = '', timeoutMs = SHARE_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
  } catch (error) {
    if (controller.signal.aborted) return { error: controller.signal.reason?.message ?? 'aborted' };
    // fetch names a refused or reset connection in its cause ("fetch failed: connect ECONNREFUSED ...").
    const cause = error?.cause instanceof Error ? `: ${error.cause.message}` : '';
    return { error: `${error instanceof Error ? error.message : String(error)}${cause}` };
  } finally {
    clearTimeout(timer);
  }
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
 * its record for the publish log. `pollOptions` reach pollShareRecoveries
 * (its `getJson`, `now` and `sleep`); `now` also measures the wait.
 */
export async function followShareJob({ jobId, url }, { api, auth, budgetMs, log = () => {}, pollOptions = {} }) {
  const now = pollOptions.now ?? Date.now;
  const label = jobId ?? url;
  log(`[soak] share job ${label} owns the share; following it for up to ${Math.round(budgetMs / 1000)}s`);
  const started = now();
  const [job] = await pollShareRecoveries([{ jobId, url, state: 'unknown', polls: 0 }], { api, auth, budgetMs, ...pollOptions });
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
 * `send({ path, body })` returns an answer as postJson does, `follow(job)` a
 * share job's record as followShareJob does. `progress` holds what the publish
 * log records (`shareRetries`, `recovery`) as it happens. Returns whether the
 * asset is shared.
 */
export async function shareWithClientRule({ contextGraphId, name, quads, send, follow, sleep = delay, log = () => {}, progress = {} }) {
  progress.shareRetries = 0;
  progress.recovery = null;
  let answer = await send({ path: '/api/knowledge-assets', body: { contextGraphId, name, quads, alsoShareSwm: true } });
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
    answer = await send({ path: `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`, body: { contextGraphId } });
    log(describeAnswer(`share again, retry ${progress.shareRetries}`, answer));
  }
}

/** The publish-log fields of a share, as JSON members. */
export function publishLogFields({ shareRetries = 0, recovery = null } = {}) {
  return `"share_retries":${JSON.stringify(shareRetries)},"share_recovery":${JSON.stringify(recovery)}`;
}

async function main([home, contextGraphId, name, fixture, fieldsFile]) {
  if (!home || !contextGraphId || !name || !fixture || !fieldsFile) {
    throw new Error('usage: devnet-soak-rs-share.mjs <nodeHome> <contextGraphId> <name> <fixture.nt> <fieldsFile>');
  }
  const progress = {};
  try {
    const budgetMs = recoveryWaitSec() * 1000;
    const quads = fixtureQuads(readFileSync(fixture, 'utf8'));
    const api = nodeApiBase(home);
    const auth = process.env.SOAK_API_AUTH ?? '';
    const log = (line) => console.log(line);
    return await shareWithClientRule({
      contextGraphId, name, quads, log, progress,
      send: ({ path, body }) => postJson(api + path, body, { auth }),
      follow: (job) => followShareJob(job, { api, auth, budgetMs, log }),
    });
  } finally {
    writeFileSync(fieldsFile, publishLogFields(progress));
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).then((shared) => {
    process.exitCode = shared ? 0 : 1;
  }, (error) => {
    console.error(`[soak] share step: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
