/**
 * How the hash-subscription devnet suite talks to a daemon: typed reads and posts
 * through the wire validators, and the observation and recovery helpers built on
 * them. The scenario file (automated.test.ts) composes these; nothing here knows
 * which graph or which edge a test uses, so every helper takes its nodes and its
 * expected content as arguments.
 *
 * The transport is injected (`DaemonIo`, defaulting to the harness), so the reply
 * handling and the recovery decision are proven without a devnet (daemon.test.ts).
 *
 * ONE RULE FOR ERRORS. A reply of the wrong shape is a failure of the test, never
 * "not yet": `checked()` adds the node to a validator's `WireShapeError` and keeps
 * its class (`withContext`), and every place that catches to retry or to decorate a
 * message lets a `WireShapeError` through unchanged. What a poll may treat as "not
 * yet" is a transport failure (a rejected fetch, a timeout) or a non-200 status.
 */
import { expect } from 'vitest';
import { getJson, normTerm, postJson, waitFor, type DevnetNode } from '../_bootstrap/harness.js';
import {
  WireShapeError,
  parseCatchupStatusResponse,
  parseQueryBindings,
  parseSubscribeResponse,
  type CatchupStatusReply,
  type SubscribeReply,
} from './wire.js';

export type View = 'shared-working-memory' | 'verifiable-memory';

/** What a transport hands back: the status and the parsed JSON body (`null` when it was not JSON). */
export interface HttpReply {
  readonly status: number;
  readonly json: unknown;
}

/** The transport and the poller. The defaults are the harness's; a unit test injects fakes. */
export interface DaemonIo {
  get(node: DevnetNode, path: string): Promise<HttpReply>;
  post(node: DevnetNode, path: string, body: unknown): Promise<HttpReply>;
  waitFor: typeof waitFor;
}

export const harnessIo: DaemonIo = { get: getJson, post: postJson, waitFor };

export interface DaemonOptions {
  /** How long a recovery waits between two forced catch-ups. */
  readonly recoveryRetryEveryMs?: number;
}

/**
 * A daemon reply. A 200 body has been checked by the endpoint's validator
 * (wire.ts): a renamed or retyped field it reads throws there, naming the
 * endpoint and the field. Any other status carries the body untouched (an error
 * reply is `{ error }`).
 */
export type Reply<T> =
  | { readonly ok: true; readonly status: 200; readonly body: T }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

/**
 * Check a reply with its endpoint's validator. A validator failure keeps its type,
 * endpoint and field and gains the node in its message (`WireShapeError.withContext`),
 * so it can still be told from a transport failure further up.
 */
export function checked<T>(node: DevnetNode, res: HttpReply, parse: (value: unknown) => T): Reply<T> {
  if (res.status !== 200) return { ok: false, status: res.status, body: res.json };
  try {
    return { ok: true, status: 200, body: parse(res.json) };
  } catch (err) {
    if (err instanceof WireShapeError) throw err.withContext(`node${node.num}`);
    throw new Error(`node${node.num} ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** The checked body of a reply that must be a 200: anything else fails with `label` and the raw body. */
export function expectOk<T>(reply: Reply<T>, label: string): T {
  expect(reply.status, `${label}: ${JSON.stringify(reply.body)}`).toBe(200);
  return (reply as Extract<Reply<T>, { ok: true }>).body;
}

/**
 * Whether a failure of a best-effort attempt may be retried on the next round: any
 * failure except a reply of the wrong shape, which is the test's failure.
 */
export function isTransientFailure(error: unknown): boolean {
  return !(error instanceof WireShapeError);
}

/** Run `attempt`; a transient failure is `null` (try again later), a wire-shape failure is thrown. */
export async function attemptOnce<T>(attempt: () => Promise<T>): Promise<T | null> {
  try {
    return await attempt();
  } catch (error) {
    if (isTransientFailure(error)) return null;
    throw error;
  }
}

/**
 * The failure to show when a wait ran out: `note` is added to a timeout or an
 * assertion message, but a `WireShapeError` already says what is wrong with which
 * reply, so it goes through unchanged.
 */
export function withNote(error: unknown, note: string): Error {
  if (error instanceof WireShapeError) return error;
  return new Error(`${error instanceof Error ? error.message : String(error)} (${note})`, { cause: error });
}

/** The id of the catch-up job a subscribe queued (the completed-catch-up variant of the reply has none). */
export function queuedJobId(reply: SubscribeReply): string | undefined {
  return reply.catchup?.jobId;
}

export function createDaemon(io: DaemonIo = harnessIo, options: DaemonOptions = {}) {
  const recoveryRetryEveryMs = options.recoveryRetryEveryMs ?? 60_000;

  async function getChecked<T>(node: DevnetNode, path: string, parse: (value: unknown) => T): Promise<Reply<T>> {
    return checked(node, await io.get(node, path), parse);
  }

  async function postChecked<T>(node: DevnetNode, path: string, body: unknown, parse: (value: unknown) => T): Promise<Reply<T>> {
    return checked(node, await io.post(node, path, body), parse);
  }

  async function catchupStatus(node: DevnetNode, contextGraphId: string): Promise<CatchupStatusReply | null> {
    const res = await getChecked(
      node,
      `/api/sync/catchup-status?contextGraphId=${encodeURIComponent(contextGraphId)}`,
      parseCatchupStatusResponse,
    );
    return res.ok ? res.body : null;
  }

  /** The rows of a SELECT against one memory view: `null` when the node could not answer it (yet). */
  async function tryRows(node: DevnetNode, contextGraphId: string, sparql: string, view: View) {
    // A transport failure is "no answer yet"; a 200 that is not a SELECT answer is not.
    const res = await io.post(node, '/api/query', { sparql, contextGraphId, view }).then((reply) => reply, () => null);
    if (res === null || res.status !== 200) return null;
    const reply = checked(node, res, parseQueryBindings);
    return reply.ok ? reply.body : null;
  }

  /** Every (predicate, object) of one subject in one memory view, as a sorted list; a failed read throws. */
  async function subjectContent(node: DevnetNode, contextGraphId: string, subject: string, view: View): Promise<string[]> {
    const res = await io.post(node, '/api/query', { sparql: `SELECT ?p ?o WHERE { <${subject}> ?p ?o }`, contextGraphId, view });
    const reply = checked(node, res, parseQueryBindings);
    if (!reply.ok) throw new Error(`query on node${node.num} failed (${reply.status}): ${JSON.stringify(reply.body)}`);
    return reply.body.map((row) => `${normTerm(row.p)} ${normTerm(row.o)}`).sort();
  }

  /** The same read for a poll: `[]` while the node cannot answer or does not know the graph yet (a reply of the wrong shape still throws). */
  async function pollSubjectContent(node: DevnetNode, contextGraphId: string, subject: string, view: View): Promise<string[]> {
    const rows = await tryRows(node, contextGraphId, `SELECT ?p ?o WHERE { <${subject}> ?p ?o }`, view);
    return rows === null ? [] : rows.map((row) => `${normTerm(row.p)} ${normTerm(row.o)}`).sort();
  }

  /** How many rows of `predicate` a subject has in one view; 0 while the node does not know the graph. */
  async function tryRowCount(node: DevnetNode, contextGraphId: string, subject: string, predicate: string, view: View): Promise<number> {
    const res = await io.post(node, '/api/query', {
      sparql: `SELECT ?o WHERE { <${subject}> <${predicate}> ?o }`,
      contextGraphId,
      view,
    });
    if (res.status !== 200) return 0;
    const reply = checked(node, res, parseQueryBindings);
    return reply.ok ? reply.body.length : 0;
  }

  /** The latest catch-up job's verdict, for a failure message. */
  async function describeLatestJob(node: DevnetNode, contextGraphId: string): Promise<string> {
    const found = await catchupStatus(node, contextGraphId).then(
      (job) => (job === null ? 'none' : `${job.jobStatus}${job.error ? `, ${job.error}` : ''}`),
      // The read itself failed: say how, instead of claiming there is no job.
      (err: unknown) => `unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return `last catch-up job: ${found}`;
  }

  /**
   * Poll an edge until a subject's content in one view matches the author's, and
   * report the latest catch-up job's verdict if it never does. `whileWaiting`
   * runs on every poll that found no match yet; without it the poll only reads.
   * A reply of the wrong shape fails the poll at once, whatever comes next.
   */
  async function pollContent(
    node: DevnetNode,
    contextGraphId: string,
    subject: string,
    view: View,
    expected: string[],
    label: string,
    budgetMs: number,
    whileWaiting?: () => Promise<void>,
  ): Promise<void> {
    try {
      await io.waitFor(`${label}: node${node.num} ${view} content of ${subject}`, budgetMs, 3_000, async () => {
        const rows = await pollSubjectContent(node, contextGraphId, subject, view);
        if (rows.length > 0 && JSON.stringify(rows) === JSON.stringify(expected)) return rows;
        await whileWaiting?.();
        return null;
      });
    } catch (err) {
      throw withNote(err, await describeLatestJob(node, contextGraphId));
    }
  }

  /**
   * Wait for a subject's content to match the author's on an edge. Purely
   * observational: it never subscribes, retries or otherwise changes the node, so
   * the catch-up job a test started stays the latest one until the test itself
   * replaces it.
   */
  async function waitForContent(
    node: DevnetNode,
    contextGraphId: string,
    subject: string,
    view: View,
    expected: string[],
    label: string,
    budgetMs = 420_000,
  ): Promise<void> {
    await pollContent(node, contextGraphId, subject, view, expected, label, budgetMs);
  }

  /**
   * Subscribe, retrying only while the node has not yet read the graph from the
   * chain (a retryable 503, or a numeric id the node has not seen yet: 404).
   */
  async function subscribeWhenAdmitted(node: DevnetNode, contextGraphId: string): Promise<SubscribeReply> {
    let last = '';
    try {
      return await io.waitFor(`node${node.num} subscribes ${contextGraphId}`, 120_000, 3_000, async () => {
        const res = await postChecked(node, '/api/context-graph/subscribe', {
          contextGraphId,
          includeSharedMemory: true,
          syncMode: 'always-on',
        }, parseSubscribeResponse);
        if (res.ok) return res.body;
        last = `${res.status} ${JSON.stringify(res.body)}`;
        if (res.status === 503 || res.status === 404) return null;
        throw new Error(`node${node.num} subscribe ${contextGraphId} refused: ${last}`);
      });
    } catch (err) {
      throw withNote(err, `last response: ${last}`);
    }
  }

  /**
   * The operator's recovery for a catch-up job that ended `failed`: a fresh
   * subscribe with `forceCatchup`. It mints a REPLACEMENT job (or, while a job is
   * still queued or running, hands that one back), and from then on the cleartext
   * id and the on-chain id name the latest job, not the one the first subscribe
   * returned. The superseded job stays readable by its own id.
   */
  async function forceCatchup(
    node: DevnetNode,
    contextGraphId: string,
  ): Promise<{ status: number; jobId?: string; detail: string }> {
    const res = await postChecked(node, '/api/context-graph/subscribe', {
      contextGraphId,
      includeSharedMemory: true,
      syncMode: 'always-on',
      forceCatchup: true,
    }, parseSubscribeResponse);
    return {
      status: res.status,
      jobId: res.ok ? queuedJobId(res.body) : undefined,
      detail: JSON.stringify(res.body),
    };
  }

  /**
   * Wait for content and, once a minute while it is missing, recover with a forced
   * catch-up. Only the SWM scenario calls this: its content depends on a holder's
   * RFC-64 authority pipeline, which can lag or trip its RPC circuit for a while
   * after a devnet starts (an operator recovers a short window this way; a node
   * whose circuit stays open needs a restart, and the suite fails rather than hide
   * it). Returns the id of the latest catch-up job, which is what the graph's
   * aliases must name afterwards: `firstJobId` when no recovery replaced it.
   *
   * A failed forced catch-up (a rejected request, a non-200) is retried on the
   * next round. A reply of the wrong shape is not: it rejects the whole wait with
   * the validator's endpoint and field, so a later good reply cannot hide it.
   */
  async function recoverUntilContent(
    node: DevnetNode,
    contextGraphId: string,
    subject: string,
    view: View,
    expected: string[],
    label: string,
    firstJobId: string,
    budgetMs: number,
  ): Promise<string> {
    let latestJobId = firstJobId;
    let lastRetryAt = Date.now();
    await pollContent(node, contextGraphId, subject, view, expected, label, budgetMs, async () => {
      if (Date.now() - lastRetryAt < recoveryRetryEveryMs) return;
      lastRetryAt = Date.now();
      const forced = await attemptOnce(() => forceCatchup(node, contextGraphId));
      if (forced?.jobId !== undefined) latestJobId = forced.jobId;
    });
    return latestJobId;
  }

  return {
    getChecked,
    postChecked,
    catchupStatus,
    subjectContent,
    pollSubjectContent,
    tryRowCount,
    describeLatestJob,
    pollContent,
    waitForContent,
    subscribeWhenAdmitted,
    forceCatchup,
    recoverUntilContent,
  };
}

export type Daemon = ReturnType<typeof createDaemon>;
