/**
 * The suite's daemon helpers, proven without a devnet through an injected
 * transport: how a reply is checked, which failures a poll may retry, and that a
 * reply of the wrong shape rejects a recovery instead of being swallowed as "not
 * yet".
 *
 * The transport is scripted per path (a reply, or an error to throw, per call; the
 * last entry repeats). The poller is fake too, so nothing sleeps: it probes up to a
 * fixed number of times and then times out the way the harness's `waitFor` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevnetNode } from '../_bootstrap/harness.js';
import {
  attemptOnce,
  checked,
  createDaemon,
  isTransientFailure,
  withNote,
  type DaemonIo,
  type HttpReply,
} from './daemon.js';
import { CatchupJobClassificationError } from './catchup-jobs.js';
import { ENDPOINT, WireShapeError, parseSubscribeResponse } from './wire.js';

const node5 = { num: 5 } as DevnetNode;
const CG = 'devnet-hash-sub-daemon-test';
const SUBJECT = 'urn:test:daemon';
const CONTENT = ['<https://schema.org/name> "kept"'];

type Scripted = HttpReply | Error;

/** A transport that answers each path from its script and records every call. */
function scriptedIo(script: Record<string, Scripted[]>) {
  const calls: Array<{ method: 'GET' | 'POST'; node: number; path: string }> = [];
  const next = (method: 'GET' | 'POST', node: number, path: string): HttpReply => {
    calls.push({ method, node, path });
    const key = Object.keys(script).find((prefix) => path.startsWith(prefix));
    if (key === undefined) throw new Error(`no script for ${method} ${path}`);
    const queue = script[key]!;
    const step = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (step instanceof Error) throw step;
    return step;
  };
  const io: DaemonIo = {
    get: async (node, path) => next('GET', node.num, path),
    post: async (node, path) => next('POST', node.num, path),
    // Probe up to 12 times without sleeping, then time out like the harness.
    waitFor: async <T>(label: string, timeoutMs: number, _intervalMs: number, probe: () => Promise<T | null>): Promise<T> => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const value = await probe();
        if (value) return value;
      }
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    },
  };
  return { io, calls, count: (path: string) => calls.filter((call) => call.path.startsWith(path)).length };
}

const ok = (json: unknown): HttpReply => ({ status: 200, json });
const rows = (...list: Array<Record<string, string>>): HttpReply => ok({ result: { bindings: list } });
const NO_ROWS = rows();
const HAS_CONTENT = rows({ p: '<https://schema.org/name>', o: '"kept"' });
const queuedReply = (jobId: unknown): HttpReply => ok({ subscribed: CG, catchup: { status: 'queued', includeWorkspace: true, jobId } });
const QUERY = '/api/query';
const NO_JOB_REPLY: HttpReply = { status: 404, json: { error: 'No catch-up job found' } };
const SUBSCRIBE = '/api/context-graph/subscribe';

describe('checked', () => {
  it('returns the checked body of a 200', () => {
    const reply = checked(node5, ok({ subscribed: CG }), parseSubscribeResponse);
    expect(reply).toEqual({ ok: true, status: 200, body: expect.objectContaining({ subscribed: CG }) });
  });

  it('carries any other status through untouched, without running the validator', () => {
    const reply = checked(node5, { status: 503, json: { error: 'not ready' } }, () => { throw new Error('must not run'); });
    expect(reply).toEqual({ ok: false, status: 503, body: { error: 'not ready' } });
  });

  it('keeps a validator failure a WireShapeError, with its endpoint and field, and adds the node to the message', () => {
    let caught: unknown;
    try {
      checked(node5, ok({ subscribed: CG, catchup: { jobId: 7 } }), parseSubscribeResponse);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireShapeError);
    const error = caught as WireShapeError;
    expect(error).toMatchObject({ endpoint: ENDPOINT.subscribe, field: 'reply.catchup.jobId', expected: 'a string when present', actual: 7 });
    expect(error.message).toBe(`node5 ${ENDPOINT.subscribe}: reply.catchup.jobId is the number 7, expected a string when present`);
    expect(error.cause).toBeInstanceOf(WireShapeError);
  });

  it('wraps any other validator failure with the node and keeps the original as its cause', () => {
    const original = new Error('boom');
    let caught: unknown;
    try {
      checked(node5, ok({}), () => { throw original; });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeInstanceOf(WireShapeError);
    expect((caught as Error).message).toBe('node5 boom');
    expect((caught as Error).cause).toBe(original);
  });
});

describe('what a wait may retry', () => {
  const shape = new WireShapeError(ENDPOINT.subscribe, 'reply.catchup.jobId', 'a string when present', 7);

  it('treats every failure but a wire-shape failure as transient', () => {
    expect(isTransientFailure(shape)).toBe(false);
    expect(isTransientFailure(shape.withContext('node5'))).toBe(false);
    expect(isTransientFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientFailure(new DOMException('The operation timed out', 'TimeoutError'))).toBe(true);
    expect(isTransientFailure(new Error('boom'))).toBe(true);
  });

  it('attemptOnce turns a transient failure into null and lets a wire-shape failure through', async () => {
    await expect(attemptOnce(async () => 'done')).resolves.toBe('done');
    await expect(attemptOnce(async () => { throw new TypeError('fetch failed'); })).resolves.toBeNull();
    await expect(attemptOnce(async () => { throw shape.withContext('node5'); })).rejects.toBeInstanceOf(WireShapeError);
  });

  it('withNote explains a timeout but passes a wire-shape failure through unchanged', () => {
    const timeout = withNote(new Error('timed out after 10ms waiting for: x'), 'last catch-up job: none');
    expect(timeout.message).toBe('timed out after 10ms waiting for: x (last catch-up job: none)');
    const contextual = shape.withContext('node5');
    expect(withNote(contextual, 'last catch-up job: none')).toBe(contextual);
  });
});

describe('recoverUntilContent', () => {
  const recover = (io: DaemonIo, firstJobId = 'job-1') =>
    createDaemon(io, { recoveryRetryEveryMs: 0 }).recoverUntilContent(node5, CG, SUBJECT, 'shared-working-memory', CONTENT, 'test', firstJobId, 1_000);

  it('rejects with the validator diagnostic when the forced catch-up reply has the wrong shape, and never reaches a later good read', async () => {
    // The comment's example: a 200 whose catchup.jobId is a number. The retry would
    // have delivered the content on the next read, so a swallowed failure passes.
    const { io, count } = scriptedIo({ [QUERY]: [NO_ROWS, HAS_CONTENT], [SUBSCRIBE]: [queuedReply(7)] });
    const outcome = await recover(io).then(() => undefined, (err: unknown) => err);
    expect(outcome, 'the recovery must reject').toBeInstanceOf(WireShapeError);
    expect(outcome).toMatchObject({ endpoint: ENDPOINT.subscribe, field: 'reply.catchup.jobId', actual: 7 });
    expect((outcome as Error).message).toContain(`node5 ${ENDPOINT.subscribe}: reply.catchup.jobId is the number 7`);
    expect(count(QUERY), 'it stopped at the malformed reply').toBe(1);
  });

  it.each([
    ['a 200 that is not JSON', ok(null)],
    ['a 200 whose subscribed is missing', ok({ catchup: { jobId: 'job-2' } })],
    ['a 200 whose identity state is spelled differently', ok({ subscribed: CG, identity: { state: 'hash-only', nameHash: '0x1', message: 'm' } })],
  ])('rejects on %s too', async (_name, reply) => {
    const { io } = scriptedIo({ [QUERY]: [NO_ROWS, HAS_CONTENT], [SUBSCRIBE]: [reply] });
    await expect(recover(io)).rejects.toBeInstanceOf(WireShapeError);
  });

  it.each([
    ['a rejected fetch', new TypeError('fetch failed')],
    ['a request that timed out', new DOMException('The operation timed out', 'TimeoutError')],
    ['a 503 reply', { status: 503, json: { error: 'catch-up is shutting down' } } satisfies HttpReply],
    ['a 500 reply that is not JSON', { status: 500, json: null } satisfies HttpReply],
  ])('retries after %s and takes the job of the next good reply', async (_name, failure) => {
    const { io, count } = scriptedIo({
      [QUERY]: [NO_ROWS, NO_ROWS, HAS_CONTENT],
      [SUBSCRIBE]: [failure, queuedReply('job-2')],
    });
    await expect(recover(io)).resolves.toBe('job-2');
    expect(count(SUBSCRIBE), 'the recovery asked again after the failure').toBe(2);
  });

  it('keeps the first job when the content arrives without any recovery', async () => {
    const { io, count } = scriptedIo({ [QUERY]: [HAS_CONTENT], [SUBSCRIBE]: [queuedReply('never')] });
    await expect(recover(io)).resolves.toBe('job-1');
    expect(count(SUBSCRIBE)).toBe(0);
  });

  it('keeps the first job when a forced reply carries no job id (the completed-catch-up variant)', async () => {
    const completed = ok({ subscribed: CG, catchup: { connectedPeers: 4, dataSynced: 12 } });
    const { io } = scriptedIo({ [QUERY]: [NO_ROWS, HAS_CONTENT], [SUBSCRIBE]: [completed] });
    await expect(recover(io)).resolves.toBe('job-1');
  });

  it('does not force a catch-up before the retry interval has passed', async () => {
    const { io, count } = scriptedIo({ [QUERY]: [NO_ROWS, NO_ROWS, HAS_CONTENT], [SUBSCRIBE]: [queuedReply('job-2')] });
    const slow = createDaemon(io, { recoveryRetryEveryMs: 60_000 });
    await expect(slow.recoverUntilContent(node5, CG, SUBJECT, 'shared-working-memory', CONTENT, 'test', 'job-1', 1_000)).resolves.toBe('job-1');
    expect(count(SUBSCRIBE)).toBe(0);
  });

  it('rejects when the content read itself has the wrong shape, instead of polling on', async () => {
    const { io, count } = scriptedIo({ [QUERY]: [ok({ result: { bindings: 'none' } }), HAS_CONTENT] });
    const outcome = await recover(io).then(() => undefined, (err: unknown) => err);
    expect(outcome).toBeInstanceOf(WireShapeError);
    expect(outcome).toMatchObject({ endpoint: ENDPOINT.query, field: 'reply.result.bindings' });
    expect(count(QUERY)).toBe(1);
  });

  it('polls on while the content read is a failure of the transport or a non-200', async () => {
    const { io } = scriptedIo({
      [QUERY]: [new TypeError('fetch failed'), { status: 503, json: { error: 'busy' } }, NO_ROWS, HAS_CONTENT],
      [SUBSCRIBE]: [{ status: 503, json: { error: 'busy' } }],
    });
    await expect(recover(io)).resolves.toBe('job-1');
  });
});

describe('waiting for content', () => {
  const wait = (io: DaemonIo) => createDaemon(io).waitForContent(node5, CG, SUBJECT, 'verifiable-memory', CONTENT, 'vm', 1_000);

  it('resolves once the rows match and never subscribes', async () => {
    const { io, count } = scriptedIo({ [QUERY]: [NO_ROWS, HAS_CONTENT] });
    await wait(io);
    expect(count(SUBSCRIBE)).toBe(0);
  });

  it('names the latest catch-up job when it times out', async () => {
    const { io } = scriptedIo({
      [QUERY]: [NO_ROWS],
      '/api/sync/catchup-status': [{ status: 404, json: { error: 'No catch-up job found' } }],
    });
    await expect(wait(io)).rejects.toThrow(/timed out after 1000ms waiting for: vm: node5 verifiable-memory content of urn:test:daemon \(last catch-up job: none\)/);
  });

  it('reports a catch-up status of the wrong shape as unreadable, not as "none"', async () => {
    const { io } = scriptedIo({
      [QUERY]: [NO_ROWS],
      '/api/sync/catchup-status': [ok({ jobId: 'j', contextGraphId: CG, jobStatus: 'finished' })],
    });
    await expect(wait(io)).rejects.toThrow(/last catch-up job: unreadable: node5 GET \/api\/sync\/catchup-status: reply\.jobStatus is the string "finished"/);
  });
});

describe('subscribeWhenAdmitted', () => {
  const subscribe = (io: DaemonIo) => createDaemon(io).subscribeWhenAdmitted(node5, CG);

  it.each([
    ['a retryable 503', { status: 503, json: { error: 'not ready' } }],
    ['a numeric id the node has not seen yet (404)', { status: 404, json: { error: 'unknown' } }],
  ])('retries %s', async (_name, notYet) => {
    const { io, count } = scriptedIo({ [SUBSCRIBE]: [notYet, queuedReply('job-1')] });
    await expect(subscribe(io)).resolves.toMatchObject({ subscribed: CG, catchup: { jobId: 'job-1' } });
    expect(count(SUBSCRIBE)).toBe(2);
  });

  it('fails at once on a refusal, with the last response in the message', async () => {
    const { io, count } = scriptedIo({ [SUBSCRIBE]: [{ status: 403, json: { error: 'forbidden' } }] });
    await expect(subscribe(io)).rejects.toThrow(/subscribe devnet-hash-sub-daemon-test refused: 403 .*\(last response: 403 /);
    expect(count(SUBSCRIBE)).toBe(1);
  });

  it('lets a reply of the wrong shape through as the validator failure it is, not as a decorated Error', async () => {
    const { io, count } = scriptedIo({ [SUBSCRIBE]: [queuedReply(7), queuedReply('job-1')] });
    const outcome = await subscribe(io).then(() => undefined, (err: unknown) => err);
    expect(outcome).toBeInstanceOf(WireShapeError);
    expect(outcome).toMatchObject({ field: 'reply.catchup.jobId' });
    expect(count(SUBSCRIBE), 'a malformed reply is not retried').toBe(1);
  });
});

describe('expectLatestJobNamed', () => {
  const graph = { id: CG, nameHash: `0x${'ef'.repeat(32)}`, onChainId: '41' };
  const status = '/api/sync/catchup-status?';
  const byJobId = (jobId: string) => `${status}jobId=${jobId}`;
  const byName = (name: string) => `${status}contextGraphId=${encodeURIComponent(name)}`;
  const NO_JOB: HttpReply = { status: 404, json: { error: 'No catch-up job found' } };
  const jobReply = (jobId: string, contextGraphId: string, jobStatus: string, extra: Record<string, unknown> = {}): HttpReply =>
    ok({ jobId, contextGraphId, jobStatus, includeWorkspace: true, ...extra });
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logged.push(String(line)); });
  });
  afterEach(() => vi.restoreAllMocks());

  const expectNamed = (io: DaemonIo, jobId = 'j1') => createDaemon(io).expectLatestJobNamed(node5, graph, jobId, 'test');

  it('a job made under the cleartext id: the cleartext and on-chain ids must name it', async () => {
    const named = jobReply('j1', graph.id, 'running');
    const { io } = scriptedIo({ [byJobId('j1')]: [named], [byName(graph.id)]: [named], [byName(graph.onChainId)]: [named] });
    await expect(expectNamed(io)).resolves.toEqual({ kind: 'continued', jobId: 'j1', how: 'created-under-cleartext-id' });
    expect(logged.join('\n')).toContain('was made under the cleartext id');
  });

  it('fails when the on-chain id names another job than a job that continued under the cleartext id', async () => {
    const continued = jobReply('j1', graph.nameHash, 'done', { resolvedContextGraphId: graph.id });
    const { io } = scriptedIo({
      [byJobId('j1')]: [continued],
      [byName(graph.id)]: [continued],
      [byName(graph.onChainId)]: [jobReply('j9', graph.id, 'done')],
    });
    await expect(expectNamed(io)).rejects.toThrow(/timed out after 30000ms waiting for: test: node5 names job j1 by devnet-hash-sub-daemon-test and 41/);
  });

  it('a hash-keyed job that settled and never continued: the hash and the on-chain id name it, the cleartext id names none', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const { io } = scriptedIo({
      [byJobId('j1')]: [settled],
      [byName(graph.id)]: [NO_JOB],
      [byName(graph.nameHash)]: [settled],
      [byName(graph.onChainId)]: [settled],
    });
    await expect(expectNamed(io)).resolves.toEqual({ kind: 'hash-keyed-settled', jobId: 'j1' });
    expect(logged.join('\n')).toContain('NOT asserted: that the cleartext id names it');
  });

  it('waits for a hash-keyed job that has neither settled nor continued before it decides', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const { io, count } = scriptedIo({
      [byJobId('j1')]: [jobReply('j1', graph.nameHash, 'queued'), jobReply('j1', graph.nameHash, 'running'), settled],
      [byName(graph.id)]: [NO_JOB],
      [byName(graph.nameHash)]: [settled],
      [byName(graph.onChainId)]: [settled],
    });
    await expect(expectNamed(io)).resolves.toMatchObject({ kind: 'hash-keyed-settled' });
    expect(count(byJobId('j1'))).toBe(3);
  });

  it('a hash-keyed job that settled without continuing, yet the cleartext id names it, is a failure of the reply', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const { io } = scriptedIo({ [byJobId('j1')]: [settled], [byName(graph.id)]: [settled] });
    await expect(expectNamed(io)).rejects.toBeInstanceOf(CatchupJobClassificationError);
  });

  it('fails when the hash does not name the settled hash-keyed job', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const { io } = scriptedIo({
      [byJobId('j1')]: [settled],
      [byName(graph.id)]: [NO_JOB],
      [byName(graph.nameHash)]: [NO_JOB],
      [byName(graph.onChainId)]: [settled],
    });
    await expect(expectNamed(io)).rejects.toThrow(/names job j1 by 0x/);
  });

  it('fails when the cleartext id names a job after all, once the classification saw none', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const { io } = scriptedIo({
      [byJobId('j1')]: [settled],
      // none when classified, then a job appears: the assertion of the state re-reads it
      [byName(graph.id)]: [NO_JOB, jobReply('j2', graph.id, 'running')],
      [byName(graph.nameHash)]: [settled],
      [byName(graph.onChainId)]: [settled],
    });
    await expect(expectNamed(io)).rejects.toThrow(/the cleartext id names no job while the settled job stayed under the hash/);
  });

  it('a hash-keyed job replaced by one under the cleartext id: the hash names the old job, the cleartext and on-chain ids the successor', async () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const successor = jobReply('j2', graph.id, 'running');
    const { io } = scriptedIo({
      [byJobId('j1')]: [settled],
      [byName(graph.id)]: [successor],
      [byName(graph.nameHash)]: [settled],
      [byName(graph.onChainId)]: [successor],
    });
    await expect(expectNamed(io)).resolves.toEqual({ kind: 'replaced', jobId: 'j1', successorJobId: 'j2' });
  });

  it('fails on a job by its id that the daemon does not know', async () => {
    const { io } = scriptedIo({ [byJobId('j1')]: [{ status: 404, json: { error: 'Catch-up job "j1" not found' } }] });
    await expect(expectNamed(io)).rejects.toThrow(/test: the job by its id: .*not found/);
  });
});

describe('the arrange and precondition helpers', () => {
  const author = { num: 1 } as DevnetNode;
  const graph = { id: CG, nameHash: `0x${'ab'.repeat(32)}`, onChainId: '41', subject: SUBJECT };
  const LIST = '/api/context-graph/list';
  const SUBSCRIPTIONS = '/api/context-graph/subscriptions';
  const row = (contextGraphId: string, subscribed = true) => ({ contextGraphId, subscribed, synced: false, coreHosted: false });
  const rowsReply = (...rowsIn: Array<ReturnType<typeof row>>): HttpReply => ok({ subscriptions: rowsIn });
  const observedSlot = ok({ contextGraphs: [{ onChainId: '41' }] });

  it('expectNoRowFor passes for an edge with no row under either id, and names the row it finds otherwise', async () => {
    const daemon = createDaemon(scriptedIo({ [SUBSCRIPTIONS]: [rowsReply(row('another-graph'))] }).io);
    await expect(daemon.expectNoRowFor(node5, graph)).resolves.toBeUndefined();
    for (const id of [graph.id, graph.nameHash]) {
      const busy = createDaemon(scriptedIo({ [SUBSCRIPTIONS]: [rowsReply(row(id, false))] }).io);
      await expect(busy.expectNoRowFor(node5, graph)).rejects.toThrow(`node5 must not yet be subscribed to ${graph.id}`);
    }
  });

  it('waitForAdoption waits for a subscribed row under the cleartext id and none under the hash', async () => {
    const { io, count } = scriptedIo({
      [SUBSCRIPTIONS]: [rowsReply(row(graph.nameHash)), rowsReply(row(graph.nameHash), row(graph.id)), rowsReply(row(graph.id, false)), rowsReply(row(graph.id))],
    });
    await expect(createDaemon(io).waitForAdoption(node5, graph)).resolves.toMatchObject({ contextGraphId: graph.id, subscribed: true });
    expect(count(SUBSCRIPTIONS)).toBe(4);
  });

  it('waitUntilChainSlotObserved reads the on-chain id from the row or from its chain view, and retries a non-200', async () => {
    const { io, count } = scriptedIo({
      [LIST]: [{ status: 503, json: { error: 'starting' } }, ok({ contextGraphs: [{ id: 'x' }] }), ok({ contextGraphs: [{ onChain: { id: '41' } }] })],
    });
    await createDaemon(io).waitUntilChainSlotObserved(node5, '41');
    expect(count(LIST)).toBe(3);
  });

  it('ensureConverged subscribes an edge that has no row, and hands back the job its subscribe queued', async () => {
    const { io, calls } = scriptedIo({
      [SUBSCRIPTIONS]: [rowsReply(), rowsReply(row(graph.id))],
      [LIST]: [observedSlot],
      [SUBSCRIBE]: [queuedReply('job-arranged')],
      [QUERY]: [HAS_CONTENT],
    });
    await expect(createDaemon(io).ensureConverged(node5, author, graph, graph.nameHash, 'arrange')).resolves.toEqual({ jobId: 'job-arranged' });
    const subscribes = calls.filter((call) => call.path === SUBSCRIBE);
    expect(subscribes).toEqual([{ method: 'POST', node: 5, path: SUBSCRIBE }]);
  });

  it.each([
    ['the cleartext id', CG],
    ['the hash', `0x${'ab'.repeat(32)}`],
  ])('ensureConverged does not subscribe an edge that already has a row under %s, and has no job id to hand back', async (_name, id) => {
    const { io, count } = scriptedIo({ [SUBSCRIPTIONS]: [rowsReply(row(id)), rowsReply(row(graph.id))], [QUERY]: [HAS_CONTENT] });
    await expect(createDaemon(io).ensureConverged(node5, author, graph, graph.nameHash, 'arrange')).resolves.toEqual({});
    expect(count(SUBSCRIBE)).toBe(0);
  });

  it('ensureConverged takes the expected content from the author it is given, and waits for it on the edge', async () => {
    const { io, calls } = scriptedIo({ [SUBSCRIPTIONS]: [rowsReply(row(graph.id))], [QUERY]: [HAS_CONTENT] });
    await createDaemon(io).ensureConverged(node5, author, graph, graph.nameHash, 'arrange');
    expect(calls.filter((call) => call.path === QUERY).map((call) => call.node)).toEqual([1, 5]);
  });

  it('ensureConverged fails when the edge never holds the author\'s content, naming the wait', async () => {
    let queries = 0;
    const { io } = scriptedIo({
      [SUBSCRIPTIONS]: [rowsReply(row(graph.id))],
      [QUERY]: [HAS_CONTENT],
      '/api/sync/catchup-status': [NO_JOB_REPLY],
    });
    const original = io.post;
    io.post = async (node, path, body) => (path === QUERY && ++queries > 1 ? ok({ result: { bindings: [] } }) : original(node, path, body));
    await expect(createDaemon(io).ensureConverged(node5, author, graph, graph.nameHash, 'arrange')).rejects.toThrow(/timed out after 420000ms waiting for: arrange: node5 verifiable-memory content/);
  });
});
