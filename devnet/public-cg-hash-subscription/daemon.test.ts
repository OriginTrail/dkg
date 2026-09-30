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

  it('reports a catch-up status that failed as unreadable, with what the daemon said, not as "none"', async () => {
    const { io } = scriptedIo({
      [QUERY]: [NO_ROWS],
      '/api/sync/catchup-status': [{ status: 500, json: { error: 'boom' } }],
    });
    await expect(wait(io)).rejects.toThrow(/last catch-up job: unreadable: node5 GET \/api\/sync\/catchup-status\?contextGraphId=devnet-hash-sub-daemon-test answered 500: \{"error":"boom"\}/);
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

describe('catch-up lookups: the answer "no job" is the route\'s own 404, nothing else', () => {
  const STATUS = '/api/sync/catchup-status?contextGraphId=';
  const hashId = `0x${'cd'.repeat(32)}`;
  const lookupPath = (id: string) => `node5 GET ${STATUS}${encodeURIComponent(id)}`;
  const job = (jobId: string, contextGraphId: string, jobStatus = 'running'): HttpReply => ok({ jobId, contextGraphId, jobStatus });
  const FAILED: ReadonlyArray<[string, Scripted, string]> = [
    ['HTTP 503', { status: 503, json: { error: 'busy' } }, 'answered 503: {"error":"busy"}'],
    ['HTTP 500', { status: 500, json: { error: 'boom' } }, 'answered 500: {"error":"boom"}'],
    ['HTTP 403', { status: 403, json: { error: 'forbidden' } }, 'answered 403: {"error":"forbidden"}'],
    ['a rejected request', new TypeError('fetch failed'), 'was not answered: fetch failed'],
  ];

  describe('catchupStatus (one read, for an assertion or a classification)', () => {
    const read = (reply: Scripted) => createDaemon(scriptedIo({ [STATUS]: [reply] }).io).catchupStatus(node5, CG);

    it('returns the job of a 200', async () => {
      await expect(read(job('j1', CG))).resolves.toEqual({ jobId: 'j1', contextGraphId: CG, jobStatus: 'running' });
    });

    it('returns null for the route\'s own 404 "No catch-up job found", and only for that', async () => {
      await expect(read(NO_JOB_REPLY)).resolves.toBeNull();
    });

    it.each(FAILED)('throws on %s, naming the node, the endpoint, the status and the body', async (_what, failure, detail) => {
      await expect(read(failure)).rejects.toThrow(`${lookupPath(CG)} ${detail}`);
    });

    it.each([
      ['a 404 of an unmatched route', { status: 404, json: { error: 'Not found' } }],
      ['a 404 for a job id the route does not hold', { status: 404, json: { error: 'Catch-up job "j1" not found' } }],
      ['a 404 whose body is not JSON', { status: 404, json: null }],
      ['a 404 whose error is not that string', { status: 404, json: { error: ['No catch-up job found'] } }],
      ['the no-job message with another status', { status: 400, json: { error: 'No catch-up job found' } }],
      ['the no-job message on a 200', { status: 200, json: { error: 'No catch-up job found' } }],
    ] satisfies ReadonlyArray<[string, HttpReply]>)('does not read %s as "no job"', async (_what, reply) => {
      await expect(read(reply)).rejects.toBeInstanceOf(Error);
    });

    it('keeps a 200 of the wrong shape a WireShapeError, not "no job"', async () => {
      await expect(read(ok({ jobId: 'j', contextGraphId: CG, jobStatus: 'finished' }))).rejects.toBeInstanceOf(WireShapeError);
    });
  });

  describe('lookupCatchup (the same lookup, as a value)', () => {
    const look = (reply: Scripted) => createDaemon(scriptedIo({ [STATUS]: [reply] }).io).lookupCatchup(node5, CG);

    it('is job, none or unavailable, and never throws for a request that failed', async () => {
      await expect(look(job('j1', CG))).resolves.toMatchObject({ kind: 'job', job: { jobId: 'j1' } });
      await expect(look(NO_JOB_REPLY)).resolves.toEqual({ kind: 'none' });
      for (const [, failure, detail] of FAILED) {
        const found = await look(failure);
        expect(found.kind).toBe('unavailable');
        expect(found).toEqual({ kind: 'unavailable', why: `${lookupPath(CG)} ${detail}` });
      }
    });
  });

  describe('lookupLatestJob and findLatestJob (the cleartext id, else the hash)', () => {
    const graph = { id: CG, nameHash: hashId };
    const both = (byId: Scripted, byHash: Scripted) => scriptedIo({ [`${STATUS}${CG}`]: [byId], [`${STATUS}${hashId}`]: [byHash] });

    it('asks the hash only when the cleartext id answered "no job"', async () => {
      const hashed = job('j-hash', hashId, 'unreachable');
      const { io, count } = both(NO_JOB_REPLY, hashed);
      await expect(createDaemon(io).findLatestJob(node5, graph)).resolves.toMatchObject({ jobId: 'j-hash' });
      expect(count(`${STATUS}${hashId}`)).toBe(1);
      const named = both(job('j-id', CG), hashed);
      await expect(createDaemon(named.io).findLatestJob(node5, graph)).resolves.toMatchObject({ jobId: 'j-id' });
      expect(named.count(`${STATUS}${hashId}`)).toBe(0);
    });

    it('is null when both ids answered "no job"', async () => {
      await expect(createDaemon(both(NO_JOB_REPLY, NO_JOB_REPLY).io).findLatestJob(node5, graph)).resolves.toBeNull();
    });

    it.each(FAILED)('does not fall through to the hash when the cleartext lookup is %s', async (_what, failure, detail) => {
      const { io, count } = both(failure, job('j-hash', hashId, 'unreachable'));
      const daemon = createDaemon(io);
      await expect(daemon.lookupLatestJob(node5, graph)).resolves.toEqual({ kind: 'unavailable', why: `${lookupPath(CG)} ${detail}` });
      await expect(daemon.findLatestJob(node5, graph)).rejects.toThrow(detail);
      expect(count(`${STATUS}${hashId}`), 'a failed lookup is not an answer to fall through on').toBe(0);
    });

    it('does not report the hash\'s failure as "no job" either', async () => {
      const { io } = both(NO_JOB_REPLY, { status: 503, json: { error: 'busy' } });
      await expect(createDaemon(io).findLatestJob(node5, graph)).rejects.toThrow(`${lookupPath(hashId)} answered 503`);
    });
  });

  describe('waitForJob (a poll that waits for a job to appear)', () => {
    const wait = (io: DaemonIo, accept?: (job: { jobStatus: string }) => boolean) => {
      const daemon = createDaemon(io);
      return daemon.waitForJob('test: job appears', 1_000, () => daemon.lookupCatchup(node5, CG), accept);
    };

    it.each(FAILED)('retries %s and then returns the job', async (_what, failure) => {
      const { io, count } = scriptedIo({ [STATUS]: [failure, failure, job('j1', CG)] });
      await expect(wait(io)).resolves.toMatchObject({ jobId: 'j1' });
      expect(count(STATUS), 'asked again after each failure').toBe(3);
    });

    it('retries the route\'s "no job" as "not yet"', async () => {
      const { io, count } = scriptedIo({ [STATUS]: [NO_JOB_REPLY, job('j1', CG)] });
      await expect(wait(io)).resolves.toMatchObject({ jobId: 'j1' });
      expect(count(STATUS)).toBe(2);
    });

    it('waits until the job is one the caller accepts', async () => {
      const { io } = scriptedIo({ [STATUS]: [job('j1', CG, 'running'), job('j1', CG, 'done')] });
      await expect(wait(io, (found) => found.jobStatus === 'done')).resolves.toMatchObject({ jobStatus: 'done' });
    });

    it.each(FAILED)('never reads a persistent %s as "no job": the timeout says what the daemon answered', async (_what, failure, detail) => {
      const { io } = scriptedIo({ [STATUS]: [failure] });
      const outcome = await wait(io).then(() => undefined, (err: unknown) => err);
      expect((outcome as Error).message).toContain('timed out after 1000ms waiting for: test: job appears');
      expect((outcome as Error).message).toContain(`(last lookup: unavailable: ${lookupPath(CG)} ${detail})`);
      expect((outcome as Error).message).not.toContain('no job');
    });

    it('says "no job" on a timeout only when that is what the route answered', async () => {
      const { io } = scriptedIo({ [STATUS]: [NO_JOB_REPLY] });
      await expect(wait(io)).rejects.toThrow('(last lookup: no job)');
    });

    it('fails at once, unannotated, on a reply of the wrong shape', async () => {
      const { io, count } = scriptedIo({ [STATUS]: [ok({ jobId: 'j', contextGraphId: CG, jobStatus: 'finished' }), job('j1', CG)] });
      const outcome = await wait(io).then(() => undefined, (err: unknown) => err);
      expect(outcome).toBeInstanceOf(WireShapeError);
      expect((outcome as Error).message).not.toContain('last lookup');
      expect(count(STATUS)).toBe(1);
    });
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

  // The bot's example: replace the cleartext lookup's "no job" reply of the hash-keyed-settled
  // branch with a failure. A daemon that could not answer is not a daemon that said "no job",
  // so none of these may pass the assertion that the cleartext id names no job. Only the
  // route's own 404 "No catch-up job found" is that answer (the positive case is the
  // hash-keyed-settled test above).
  describe('a failed lookup is not the answer "no job"', () => {
    const settled = jobReply('j1', graph.nameHash, 'unreachable');
    const lookupPath = `node5 GET ${byName(graph.id)}`;
    const FAILURES: ReadonlyArray<[string, HttpReply | Error, string]> = [
      ['HTTP 500', { status: 500, json: { error: 'boom' } }, `${lookupPath} answered 500: {"error":"boom"}`],
      ['HTTP 503', { status: 503, json: { error: 'busy' } }, `${lookupPath} answered 503: {"error":"busy"}`],
      ['HTTP 403', { status: 403, json: { error: 'forbidden' } }, `${lookupPath} answered 403: {"error":"forbidden"}`],
      ['HTTP 400', { status: 400, json: { error: 'Missing "contextGraphId" or "jobId" query param' } }, `${lookupPath} answered 400: `],
      ['a 500 that is not JSON', { status: 500, json: null }, `${lookupPath} answered 500: null`],
      ['a 404 of an unmatched route', { status: 404, json: { error: 'Not found' } }, `${lookupPath} answered 404: {"error":"Not found"}`],
      ['a 404 that names a job id instead of "no job"', { status: 404, json: { error: 'Catch-up job "j1" not found' } }, `${lookupPath} answered 404: {"error":"Catch-up job \\"j1\\" not found"}`],
      ['a 404 that is not JSON', { status: 404, json: null }, `${lookupPath} answered 404: null`],
      ['a rejected request', new TypeError('fetch failed'), `${lookupPath} was not answered: fetch failed`],
    ];
    const script = (cleartext: Array<HttpReply | Error>) => scriptedIo({
      [byJobId('j1')]: [settled],
      [byName(graph.id)]: cleartext,
      [byName(graph.nameHash)]: [settled],
      [byName(graph.onChainId)]: [settled],
    });

    it.each(FAILURES)('the hash-keyed-settled branch does not pass when the cleartext lookup is %s', async (_what, failure, message) => {
      await expect(expectNamed(script([failure]).io)).rejects.toThrow(message);
    });

    it.each(FAILURES)('nor when %s comes at the assertion, after the classification read "no job"', async (_what, failure, message) => {
      const outcome = await expectNamed(script([NO_JOB, failure]).io).then(() => undefined, (err: unknown) => err);
      expect(outcome, 'the helper must reject').toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(message);
      expect((outcome as Error).message).toContain('the cleartext id names no job while the settled job stayed under the hash');
    });

    it('a reply of the wrong shape is still the validator failure it is, not "no job"', async () => {
      const malformed: HttpReply = ok({ jobId: 'j1', contextGraphId: graph.id, jobStatus: 'finished' });
      const outcome = await expectNamed(script([malformed]).io).then(() => undefined, (err: unknown) => err);
      expect(outcome).toBeInstanceOf(WireShapeError);
      expect(outcome).toMatchObject({ endpoint: ENDPOINT.catchupStatus, field: 'reply.jobStatus' });
    });
  });

  describe('the waits on the latest job retry a lookup that failed, and never read it as "no job"', () => {
    const named = jobReply('j1', graph.id, 'running');
    const CLEARTEXT_AND_ON_CHAIN = `${graph.id} and ${graph.onChainId}`;
    const unavailable = { status: 503, json: { error: 'busy' } } satisfies HttpReply;

    it.each([
      ['HTTP 503', unavailable],
      ['a rejected request', new TypeError('fetch failed')],
    ] satisfies ReadonlyArray<[string, HttpReply | Error]>)('waitUntilNamed retries %s, then finds the job named', async (_what, failure) => {
      const { io, count } = scriptedIo({
        [byJobId('j1')]: [named],
        [byName(graph.id)]: [named],
        [byName(graph.onChainId)]: [failure, named],
      });
      await expect(expectNamed(io)).resolves.toMatchObject({ kind: 'continued' });
      expect(count(byName(graph.onChainId)), 'the on-chain id was asked again after the failure').toBe(2);
    });

    it('waitUntilNamed, when a lookup keeps failing, times out saying it failed, not that no job names the id', async () => {
      const { io } = scriptedIo({
        [byJobId('j1')]: [named],
        [byName(graph.id)]: [named],
        [byName(graph.onChainId)]: [unavailable],
      });
      const outcome = await expectNamed(io).then(() => undefined, (err: unknown) => err);
      expect((outcome as Error).message).toMatch(new RegExp(`waiting for: test: node5 names job j1 by ${CLEARTEXT_AND_ON_CHAIN} \\(last lookups: ${graph.id} -> j1 \\(${graph.id}, running\\); ${graph.onChainId} -> unavailable: node5 GET ${byName(graph.onChainId).replace(/[?]/g, '\\?')} answered 503: `));
      expect((outcome as Error).message).not.toContain(`${graph.onChainId} -> no job`);
    });

    it('expectByHashLookupResolved waits through a failed lookup and a missing job for the job the hash names', async () => {
      const resolved = { state: 'resolved', nameHash: graph.nameHash, contextGraphId: graph.id, message: 'resolved' };
      const byHash = jobReply('j1', graph.nameHash, 'unreachable', { identity: resolved });
      const { io, count } = scriptedIo({
        [byName(graph.nameHash)]: [unavailable, NO_JOB, byHash],
        [byJobId('j1')]: [byHash],
      });
      await expect(createDaemon(io).expectByHashLookupResolved(node5, graph, 'j1', 'test')).resolves.toMatchObject({ jobId: 'j1' });
      expect(count(byName(graph.nameHash))).toBe(3);
    });

    it('expectByHashLookupResolved does not turn a lookup that keeps failing into an answer', async () => {
      const { io } = scriptedIo({ [byName(graph.nameHash)]: [unavailable] });
      await expect(createDaemon(io).expectByHashLookupResolved(node5, graph, 'j1', 'test')).rejects.toThrow(/waiting for: test: node5 catch-up status by name hash \(last lookup: unavailable: node5 GET .* answered 503/);
    });
  });

  // Each case below breaks one lookup of one branch and names the lookup the failure must
  // be about: which job was being waited for, and by which ids. A branch that stopped
  // asserting one of its lookups would pass the case instead, so it would fail here.
  describe('what each branch asserts', () => {
    const CLEARTEXT_AND_ON_CHAIN = `${graph.id} and ${graph.onChainId}`;
    const HASH_AND_ON_CHAIN = `${graph.nameHash} and ${graph.onChainId}`;
    const waitingFor = (jobId: string, ids: string) => new RegExp(`waiting for: test: node5 names job ${jobId} by ${ids} \\(last lookups: `);
    const other = (contextGraphId: string) => jobReply('j9', contextGraphId, 'running');

    const continuedGraphs = [
      ['made under the cleartext id', jobReply('j1', graph.id, 'running')],
      ['made under the hash and continued under the cleartext id', jobReply('j1', graph.nameHash, 'done', { resolvedContextGraphId: graph.id })],
    ] as const;

    describe.each(continuedGraphs)('a job %s', (_how, job) => {
      const script = (over: Record<string, HttpReply[]>) => scriptedIo({
        [byJobId('j1')]: [job],
        [byName(graph.id)]: [job],
        [byName(graph.onChainId)]: [job],
        ...over,
      }).io;

      it('resolves when the cleartext and on-chain ids both name it', async () => {
        await expect(expectNamed(script({}))).resolves.toMatchObject({ kind: 'continued', jobId: 'j1' });
      });

      it.each([
        ['the on-chain id names no job', { [byName(graph.onChainId)]: [NO_JOB] }],
        ['the on-chain id names another job', { [byName(graph.onChainId)]: [other(graph.id)] }],
        ['the cleartext id names no job', { [byName(graph.id)]: [NO_JOB] }],
        ['the cleartext id names another job', { [byName(graph.id)]: [other(graph.id)] }],
      ])('fails when %s', async (_what, over) => {
        await expect(expectNamed(script(over))).rejects.toThrow(waitingFor('j1', CLEARTEXT_AND_ON_CHAIN));
      });
    });

    describe('a hash-keyed job that settled without continuing or being replaced', () => {
      const settled = jobReply('j1', graph.nameHash, 'unreachable');
      const script = (over: Record<string, HttpReply[]>) => scriptedIo({
        [byJobId('j1')]: [settled],
        [byName(graph.id)]: [NO_JOB],
        [byName(graph.nameHash)]: [settled],
        [byName(graph.onChainId)]: [settled],
        ...over,
      }).io;

      it.each([
        ['the hash names no job', { [byName(graph.nameHash)]: [NO_JOB] }],
        ['the hash names another job', { [byName(graph.nameHash)]: [other(graph.nameHash)] }],
        ['the on-chain id names no job', { [byName(graph.onChainId)]: [NO_JOB] }],
        ['the on-chain id names another job', { [byName(graph.onChainId)]: [other(graph.nameHash)] }],
      ])('fails when %s', async (_what, over) => {
        await expect(expectNamed(script(over))).rejects.toThrow(waitingFor('j1', HASH_AND_ON_CHAIN));
      });
    });

    describe('a hash-keyed job that settled and was replaced by one under the cleartext id', () => {
      const settled = jobReply('j1', graph.nameHash, 'unreachable');
      const successor = jobReply('j2', graph.id, 'running');
      const script = (over: Record<string, HttpReply[]>) => scriptedIo({
        [byJobId('j1')]: [settled],
        [byName(graph.id)]: [successor],
        [byName(graph.nameHash)]: [settled],
        [byName(graph.onChainId)]: [successor],
        ...over,
      }).io;

      it.each([
        ['the hash names no job', { [byName(graph.nameHash)]: [NO_JOB] }, waitingFor('j1', graph.nameHash)],
        ['the hash names the successor instead', { [byName(graph.nameHash)]: [successor] }, waitingFor('j1', graph.nameHash)],
        ['the on-chain id still names the settled job', { [byName(graph.onChainId)]: [settled] }, waitingFor('j2', CLEARTEXT_AND_ON_CHAIN)],
        ['the on-chain id names no job', { [byName(graph.onChainId)]: [NO_JOB] }, waitingFor('j2', CLEARTEXT_AND_ON_CHAIN)],
        ['the cleartext id names another job once the successor was read', { [byName(graph.id)]: [successor, other(graph.id)] }, waitingFor('j2', CLEARTEXT_AND_ON_CHAIN)],
      ])('fails when %s', async (_what, over, message) => {
        await expect(expectNamed(script(over))).rejects.toThrow(message);
      });
    });

    it('says what the lookups named when they do not name the job', async () => {
      const settled = jobReply('j1', graph.nameHash, 'unreachable');
      const { io } = scriptedIo({
        [byJobId('j1')]: [settled],
        [byName(graph.id)]: [NO_JOB],
        [byName(graph.nameHash)]: [settled],
        [byName(graph.onChainId)]: [other(graph.nameHash)],
      });
      await expect(expectNamed(io)).rejects.toThrow(
        new RegExp(`\\(last lookups: ${graph.nameHash} -> j1 \\(${graph.nameHash}, unreachable\\); ${graph.onChainId} -> j9 \\(${graph.nameHash}, running\\)\\)`),
      );
    });
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
