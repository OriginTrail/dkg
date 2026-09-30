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
  classifyLatestCatchupJob,
  describeLatestJobClass,
  isClassifiable,
  type GraphNames,
  type LatestJobClass,
} from './catchup-jobs.js';
import {
  WireShapeError,
  parseCatchupStatusResponse,
  parseConnectedPeerIds,
  parseContextGraphListResponse,
  parseNodePeerInfo,
  parseQueryBindings,
  parseSubscribeResponse,
  parseSubscriptionsResponse,
  type CatchupContextGraphIdentity,
  type CatchupStatusReply,
  type SubscribeReply,
  type SubscriptionRow,
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

/** A graph as the catch-up assertions need it: both of its ids and its on-chain id. */
export interface JobGraph extends GraphNames {
  readonly onChainId: string;
}

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

  async function listSubscriptions(node: DevnetNode): Promise<readonly SubscriptionRow[]> {
    const res = await getChecked(node, '/api/context-graph/subscriptions', parseSubscriptionsResponse);
    return expectOk(res, `node${node.num} GET /api/context-graph/subscriptions`).subscriptions;
  }

  /** A node's peer id and a direct TCP address it can be dialed on, as the node reports them. */
  async function dialTarget(node: DevnetNode): Promise<{ peerId: string; multiaddr: string }> {
    const info = expectOk(await getChecked(node, '/api/status', parseNodePeerInfo), `node${node.num} GET /api/status`);
    const direct = info.multiaddrs.filter((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
    const chosen = direct.find((addr) => addr.startsWith('/ip4/127.0.0.1/')) ?? direct[0];
    expect(chosen, `node${node.num} reports a direct TCP address: ${JSON.stringify(info.multiaddrs)}`).toBeDefined();
    return { peerId: info.peerId, multiaddr: chosen!.includes('/p2p/') ? chosen! : `${chosen}/p2p/${info.peerId}` };
  }

  async function connectedPeerIds(node: DevnetNode): Promise<string[]> {
    return expectOk(await getChecked(node, '/api/connections', parseConnectedPeerIds), `node${node.num} GET /api/connections`);
  }

  /** Ask `from` to dial `to` (POST /api/connect), then wait until `from` lists the connection. */
  async function dial(from: DevnetNode, to: DevnetNode): Promise<void> {
    const target = await dialTarget(to);
    const res = await io.post(from, '/api/connect', { multiaddr: target.multiaddr });
    expect(res.status, `node${from.num} POST /api/connect to node${to.num}: ${JSON.stringify(res.json)}`).toBe(200);
    await io.waitFor(`node${from.num} lists node${to.num} as connected`, 60_000, 1_000, async () => (
      (await connectedPeerIds(from)).includes(target.peerId) ? true : null
    ));
  }

  /**
   * Wait until the node has observed the graph's slot on chain (its own chain
   * poller staged a row for it): only then does a name-hash subscribe find the
   * hash-keyed row it promotes.
   */
  async function waitUntilChainSlotObserved(node: DevnetNode, onChainId: string): Promise<void> {
    await io.waitFor(`node${node.num} observes on-chain slot ${onChainId}`, 120_000, 3_000, async () => {
      const res = await getChecked(node, '/api/context-graph/list', parseContextGraphListResponse);
      if (!res.ok) return null;
      return res.body.contextGraphs.some((row) => (row.onChainId ?? row.onChain?.id) === onChainId) ? true : null;
    });
  }

  /**
   * Arrange check for a test whose subject is the first subscribe: the edge holds no
   * subscription row for the graph, under either of its ids. It fails with that
   * message instead of letting a later assertion read someone else's leftovers.
   */
  async function expectNoRowFor(node: DevnetNode, graph: GraphNames): Promise<void> {
    const ids = (await listSubscriptions(node)).map((row) => row.contextGraphId);
    expect(ids, `node${node.num} must not yet be subscribed to ${graph.id}`).not.toContain(graph.id);
    expect(ids, `node${node.num} must not yet be subscribed to ${graph.id} by its hash`).not.toContain(graph.nameHash);
  }

  /** Wait for the promotion: a subscribed row keyed by the cleartext id, none keyed by the hash. */
  async function waitForAdoption(node: DevnetNode, graph: GraphNames): Promise<SubscriptionRow> {
    return io.waitFor(`node${node.num} adopts ${graph.id}`, 180_000, 3_000, async () => {
      const rows = await listSubscriptions(node);
      const adopted = rows.find((candidate) => candidate.contextGraphId === graph.id && candidate.subscribed);
      return adopted !== undefined && !rows.some((candidate) => candidate.contextGraphId === graph.nameHash)
        ? adopted
        : null;
    });
  }

  /** A catch-up job by its id; anything but a 200 fails with `label` and the raw body. */
  async function catchupJob(node: DevnetNode, jobId: string, label: string): Promise<CatchupStatusReply> {
    return expectOk(
      await getChecked(node, `/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`, parseCatchupStatusResponse),
      label,
    );
  }

  /** The latest job the graph has under either name: the cleartext id's, else the hash's; null when neither names one. */
  async function findLatestJob(node: DevnetNode, graph: GraphNames): Promise<CatchupStatusReply | null> {
    return (await catchupStatus(node, graph.id)) ?? catchupStatus(node, graph.nameHash);
  }

  /**
   * Wait until a lookup by each of `ids` names job `jobId` as the latest job. A timeout
   * says what the last lookups named, since "names job X by A and B" alone does not say
   * which of the two did not, or what it named instead.
   */
  async function waitUntilNamed(node: DevnetNode, label: string, jobId: string, ids: readonly string[]): Promise<void> {
    let lastSeen = 'no lookup made';
    try {
      await io.waitFor(`${label}: node${node.num} names job ${jobId} by ${ids.join(' and ')}`, 30_000, 2_000, async () => {
        const found = await Promise.all(ids.map((id) => catchupStatus(node, id)));
        lastSeen = ids.map((id, i) => `${id} -> ${found[i] ? `${found[i]!.jobId} (${found[i]!.contextGraphId}, ${found[i]!.jobStatus})` : 'no job'}`).join('; ');
        return found.every((job) => job?.jobId === jobId) ? true : null;
      });
    } catch (err) {
      if (err instanceof Error) err.message = `${err.message} (last lookups: ${lastSeen})`;
      throw err;
    }
  }

  /**
   * Assert what is true of the graph's latest catch-up job `jobId`, whichever way
   * it came about (see catchup-jobs.ts), and return how it was classified. It waits
   * until a job made under the hash has settled or continued, because whether it
   * continues under the cleartext id is only known then.
   *
   *   - continued (made under the cleartext id, or continued under it): the cleartext
   *     id and the on-chain id name it. That the job itself names the cleartext graph
   *     is what the classification checks, and it throws when it does not.
   *   - replaced (settled under the hash, a later job under the cleartext id): the
   *     hash still names the job, and the cleartext id and the on-chain id name the
   *     successor.
   *   - hash-keyed-settled (settled under the hash, never continued, no successor):
   *     the hash names it, the on-chain id reaches it through the hash, and the
   *     cleartext id names no job. That the cleartext id names it is NOT asserted:
   *     it cannot.
   * The decision is printed, so a run never passes over a branch silently.
   */
  async function expectLatestJobNamed(node: DevnetNode, graph: JobGraph, jobId: string, label: string): Promise<LatestJobClass> {
    const job = await io.waitFor(`${label}: node${node.num} job ${jobId} settled or continued under the cleartext id`, 180_000, 3_000, async () => {
      const found = await catchupJob(node, jobId, `${label}: the job by its id`);
      return isClassifiable(graph, found) ? found : null;
    });
    const cleartextAliasJob = (await catchupStatus(node, graph.id)) ?? undefined;
    const cls = classifyLatestCatchupJob(graph, job, cleartextAliasJob);
    // eslint-disable-next-line no-console
    console.log(`hash-sub: ${label}: node${node.num}: ${describeLatestJobClass(graph, cls)}`);
    switch (cls.kind) {
      case 'continued':
        await waitUntilNamed(node, label, jobId, [graph.id, graph.onChainId]);
        break;
      case 'replaced':
        await waitUntilNamed(node, label, jobId, [graph.nameHash]);
        await waitUntilNamed(node, label, cls.successorJobId, [graph.id, graph.onChainId]);
        break;
      case 'hash-keyed-settled':
        await waitUntilNamed(node, label, jobId, [graph.nameHash, graph.onChainId]);
        expect(await catchupStatus(node, graph.id), `${label}: the cleartext id names no job while the settled job stayed under the hash`).toBeNull();
        break;
    }
    return cls;
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
   * ARRANGE, idempotent: leave `graph` subscribed, adopted under its cleartext id
   * and converged on `author`'s VM content on `node`. It subscribes (under
   * `requestedId`) only when the node has no row for the graph, keyed by either
   * id; adoption and content are waits, which return at once when they already
   * hold. So it does the same thing whether or not another test, or an earlier
   * attempt of the same test, already subscribed this node. Returns the id of the
   * catch-up job its own subscribe queued, or none when it did not subscribe (the
   * job is then whichever the graph's names find).
   */
  async function ensureConverged(
    node: DevnetNode,
    author: DevnetNode,
    graph: JobGraph & { readonly subject: string },
    requestedId: string,
    label: string,
  ): Promise<{ jobId?: string }> {
    let jobId: string | undefined;
    const rows = await listSubscriptions(node);
    if (!rows.some((row) => row.contextGraphId === graph.id || row.contextGraphId === graph.nameHash)) {
      await waitUntilChainSlotObserved(node, graph.onChainId);
      jobId = queuedJobId(await subscribeWhenAdmitted(node, requestedId));
    }
    await waitForAdoption(node, graph);
    const expected = await subjectContent(author, graph.id, graph.subject, 'verifiable-memory');
    await waitForContent(node, graph.id, graph.subject, 'verifiable-memory', expected, label);
    return jobId === undefined ? {} : { jobId };
  }

  /**
   * A job made under a name hash is still there under that hash once the hash has
   * resolved (#2779): the hash names the job it was subscribed with, the job is
   * readable by its id, and its identity note is read live, so it now names the
   * cleartext graph. `contextGraphId` stays the hash (the job never changes the id it
   * was created under); `resolvedContextGraphId` is set only when the job continued
   * under the cleartext id while it ran, and then it names that graph.
   */
  async function expectByHashLookupResolved(node: DevnetNode, graph: GraphNames, jobId: string, label: string): Promise<CatchupStatusReply> {
    const byHash = await io.waitFor(`${label}: node${node.num} catch-up status by name hash`, 60_000, 2_000, async () => catchupStatus(node, graph.nameHash));
    expect(byHash.jobId, `${label}: the hash names the job it was subscribed with`).toBe(jobId);
    if (byHash.resolvedContextGraphId === undefined) {
      // The job never continued under another id: it is still keyed by the hash it was made with.
      expect(byHash.contextGraphId, `${label}: a job that did not continue stays keyed by the hash`).toBe(graph.nameHash);
    } else {
      expect(byHash.resolvedContextGraphId, `${label}: a job that continued names the cleartext graph`).toBe(graph.id);
    }
    expect(byHash.identity, `${label}: ${JSON.stringify(byHash)}`).toMatchObject(
      // `satisfies` types the expected object against the daemon's declaration:
      // vitest types toMatchObject loosely, so without it a changed identity state
      // spelling would compile here and fail only in a long devnet run.
      { state: 'resolved', nameHash: graph.nameHash, contextGraphId: graph.id } satisfies Partial<CatchupContextGraphIdentity>,
    );
    const byJobId = await catchupJob(node, jobId, `${label}: the job by its id`);
    expect(byJobId.jobId).toBe(jobId);
    expect(byJobId.identity, `${label}: the job by its id`).toMatchObject(
      { state: 'resolved', nameHash: graph.nameHash, contextGraphId: graph.id } satisfies Partial<CatchupContextGraphIdentity>,
    );
    return byHash;
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
    listSubscriptions,
    dialTarget,
    connectedPeerIds,
    dial,
    waitUntilChainSlotObserved,
    expectNoRowFor,
    waitForAdoption,
    ensureConverged,
    catchupStatus,
    catchupJob,
    findLatestJob,
    expectLatestJobNamed,
    expectByHashLookupResolved,
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
