#!/usr/bin/env node
// The writes an SWM soak peer's daemon accepted (scripts/swm-soak-test.sh).
//
// A write the daemon accepts but cannot share at once (a promote prerequisite
// is briefly unavailable) comes back as a retryable partial with a share job
// (`recoveryJobId`, `recoveryStatusUrl`), and the daemon finishes the share in
// the background. Such a write counts as accepted once its job has succeeded.
// The soak runs this module as:
//
//   resolve <logDir> <waitSeconds>
//     polls the share job of each such write in writes.jsonl until it settles
//     or the wait runs out, and records the jobs in share-recoveries.jsonl.
//     Status requests go to SWM_RECOVERY_API with SWM_RECOVERY_AUTH as the
//     bearer token, which stays off the command line.
//   count <logDir>
//     writes accepted-counts.json ({cgId: count}), the one accepted-write
//     count that the tombstone, the summary and the self tally all read.

import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SETTLED_STATES = new Set(['succeeded', 'failed']);
const SHARE_JOB_POLL_INTERVAL_MS = 5_000;
const STATUS_REQUEST_CAP_MS = 10_000;

/** Whether the daemon shared a write at once (the write endpoint's answer). */
export function sharedAtOnce(resp) {
  return Boolean(resp && typeof resp === 'object'
    && (resp.swmShared || resp.status === 'swm-shared' || resp.status === 'vm-confirmed'));
}

/** The share jobs of the writes the daemon accepted as retryable partials, not yet polled. */
export function shareRecoveryJobs(writes) {
  return writes.flatMap((write) => {
    const resp = write?.resp;
    if (!resp || typeof resp !== 'object' || sharedAtOnce(resp)) return [];
    const url = resp.recoveryStatusUrl;
    if (typeof url !== 'string' || !url.startsWith('/api/')) return [];
    return [{ cgId: write.cgId, seq: write.seq, jobId: resp.recoveryJobId ?? null, url, state: 'unknown', polls: 0 }];
  });
}

const delay = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * GETs a JSON document and fails once `timeoutMs` has passed, however far the
 * answer has come. Each request uses its own connection, so nothing is left
 * open when polling ends.
 */
export function getJsonWithin(url, { headers = {}, timeoutMs }) {
  return new Promise((resolveAnswer, reject) => {
    let request;
    let timer;
    let done = false;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(value);
    };
    try {
      const target = new URL(url);
      request = (target.protocol === 'https:' ? https : http).get(target, { headers, agent: false }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', (error) => finish(reject, error));
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode > 299) {
            finish(reject, new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            finish(resolveAnswer, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            finish(reject, error);
          }
        });
      });
    } catch (error) {
      finish(reject, error);
      return;
    }
    request.on('error', (error) => finish(reject, error));
    timer = setTimeout(() => {
      finish(reject, new Error(`no answer within ${timeoutMs} ms`));
      request.destroy();
    }, timeoutMs);
  });
}

/**
 * Polls each job's status until every job has settled (succeeded or failed) or
 * `budgetMs` has passed. The remaining budget is checked before each request,
 * and a request may take at most min(`requestCapMs`, remaining), so polling
 * ends by the deadline; a budget of 0 makes no request. Each job keeps the last
 * state it was seen in, and `settled` says whether that state is final.
 */
export async function pollShareRecoveries(jobs, {
  api,
  auth = '',
  budgetMs,
  pollIntervalMs = SHARE_JOB_POLL_INTERVAL_MS,
  requestCapMs = STATUS_REQUEST_CAP_MS,
  getJson = getJsonWithin,
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + Math.max(0, budgetMs);
  const base = String(api ?? '').replace(/\/+$/, '');
  let pending = jobs.filter((job) => !SETTLED_STATES.has(job.state));
  polling: while (pending.length > 0) {
    for (const job of pending) {
      const remaining = deadline - now();
      if (remaining <= 0) break polling;
      job.polls = (job.polls ?? 0) + 1;
      try {
        const view = await getJson(base + job.url, {
          headers: { Authorization: `Bearer ${auth}` },
          timeoutMs: Math.min(requestCapMs, remaining),
        });
        job.state = typeof view?.state === 'string' && view.state ? view.state : 'unknown';
        job.attempts = view?.attempts ?? null;
        job.finishedAt = view?.finishedAt ?? null;
        delete job.pollError;
      } catch (error) {
        job.pollError = error instanceof Error ? error.message : String(error);
      }
    }
    pending = pending.filter((job) => !SETTLED_STATES.has(job.state));
    const remaining = deadline - now();
    if (pending.length === 0 || remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  for (const job of jobs) job.settled = SETTLED_STATES.has(job.state);
  return jobs;
}

/**
 * The writes the daemon accepted, per context graph: those it shared at once,
 * and those it accepted as retryable partials whose share job then succeeded.
 * A write is keyed by (cgId, seq), since every cycle writes the same seq to
 * each graph. A graph the soak wrote to counts 0 when nothing was accepted.
 */
export function acceptedWriteCounts(writes, recoveries) {
  const key = (cgId, seq) => JSON.stringify([cgId, seq]);
  const recovered = new Set(recoveries
    .filter((job) => job?.state === 'succeeded')
    .map((job) => key(job.cgId, job.seq)));
  const counts = new Map();
  for (const write of writes) {
    const cgId = write?.cgId;
    if (typeof cgId !== 'string' || cgId === '') continue;
    const accepted = sharedAtOnce(write.resp) || recovered.has(key(cgId, write.seq));
    counts.set(cgId, (counts.get(cgId) ?? 0) + (accepted ? 1 : 0));
  }
  return Object.fromEntries(counts);
}

/** The records of a JSON-lines file, skipping lines that do not parse; none when it is missing. */
export function readJsonLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function recoveryRecord(job) {
  const record = {};
  for (const field of ['cgId', 'seq', 'jobId', 'state', 'settled', 'attempts', 'finishedAt', 'polls', 'pollError']) {
    record[field] = job[field] ?? null;
  }
  return record;
}

async function resolveCommand(logDir, waitSeconds) {
  const seconds = Number(waitSeconds);
  if (!logDir || waitSeconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('usage: resolve <logDir> <waitSeconds>');
  }
  const jobs = shareRecoveryJobs(readJsonLines(join(logDir, 'writes.jsonl')));
  if (jobs.length > 0) {
    console.log(`waiting up to ${seconds}s for ${jobs.length} share job(s) of accepted writes to settle`);
  }
  await pollShareRecoveries(jobs, {
    api: process.env.SWM_RECOVERY_API,
    auth: process.env.SWM_RECOVERY_AUTH ?? '',
    budgetMs: seconds * 1000,
  });
  writeFileSync(join(logDir, 'share-recoveries.jsonl'),
    jobs.map((job) => `${JSON.stringify(recoveryRecord(job))}\n`).join(''));
  for (const job of jobs) {
    console.log(`share job ${job.jobId} for write cg=${job.cgId} seq=${job.seq}: ${job.state}`
      + (job.settled ? '' : ' (not settled)')
      + (job.attempts ? ` after ${job.attempts} attempt(s)` : '')
      + (job.pollError ? ` (last poll: ${job.pollError})` : ''));
  }
}

function countCommand(logDir) {
  if (!logDir) throw new Error('usage: count <logDir>');
  const counts = acceptedWriteCounts(
    readJsonLines(join(logDir, 'writes.jsonl')),
    readJsonLines(join(logDir, 'share-recoveries.jsonl')),
  );
  writeFileSync(join(logDir, 'accepted-counts.json'), `${JSON.stringify(counts)}\n`);
}

async function main([command, ...args]) {
  if (command === 'resolve') return resolveCommand(...args);
  if (command === 'count') return countCommand(...args);
  throw new Error('usage: swm-soak-accepted-writes.mjs resolve|count <logDir> ...');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[swm-soak-accepted-writes] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
