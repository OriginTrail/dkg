// The operator-only CPU profile: request bounds, one recording at a time, a
// session that is always closed, the node-admin gate, and a recording that
// ends when graceful shutdown begins. These tests drive the recorder with a
// fake inspector session; cpu-profile-real.test.ts records a real profile in
// a child process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dkgDir } from '../src/config.js';
import {
  CPU_PROFILE_PATH,
  cpuProfileRequestTimeoutMs,
  parseCpuProfileRequest,
  type CpuProfileResult,
} from '../src/cpu-profile-wire.js';
import {
  CpuProfileBusyError,
  CpuProfileRecorder,
  CpuProfileUnavailableError,
  type CpuProfileRecording,
  type CpuProfilerSession,
} from '../src/daemon/cpu-profile.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleCpuProfileRoutes } from '../src/daemon/routes/cpu-profile.js';
import { beginGracefulShutdown } from '../src/daemon/teardown.js';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const AGENT = requestAuthentication({ kind: 'agent', agentAddress: '0x00000000000000000000000000000000000000a1' });
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const AUTH_DISABLED = requestAuthentication({ kind: 'anonymous', mode: 'disabled' });

const PROFILE = {
  nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 }, hitCount: 1, children: [] }],
  startTime: 1_000,
  endTime: 2_000,
  samples: [1],
  timeDeltas: [1_000],
};

type ProfilerMethod = 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop';

/** An inspector stand-in that records every session call in order. */
function fakeInspector(fail: { open?: boolean; connect?: boolean; method?: ProfilerMethod } = {}) {
  const calls: string[] = [];
  const openSession = async (): Promise<CpuProfilerSession> => {
    if (fail.open) throw new Error('inspector is not available in this build');
    return {
      connect() {
        calls.push('connect');
        if (fail.connect) throw new Error('connect refused');
      },
      async post(method: string) {
        calls.push(method);
        if (method === fail.method) throw new Error(`${method} failed`);
        return method === 'Profiler.stop' ? { profile: PROFILE } : undefined;
      },
      disconnect() { calls.push('disconnect'); },
    };
  };
  return { calls, openSession, fail };
}

/** A clock that moves one second a reading, so file names never collide. */
function steppingClock(start = Date.parse('2026-10-29T12:00:00.000Z')) {
  let now = start - 1_000;
  return () => (now += 1_000);
}

/** Real event-loop turns, bounded by wall time (vi.waitFor would move a faked clock). */
async function until(condition: () => boolean): Promise<void> {
  const startedAt = performance.now();
  while (!condition()) {
    if (performance.now() - startedAt > 10_000) throw new Error('condition not reached within 10 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const count = (calls: string[], call: string) => calls.filter((entry) => entry === call).length;

/** The node-log lines of the recorders in the current test. */
const logged: string[] = [];
const log = (line: string) => { logged.push(line); };

let directory: string;
beforeEach(async () => {
  logged.length = 0;
  directory = await mkdtemp(join(tmpdir(), 'cpu-profile-'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('CPU profile request', () => {
  it.each([
    ['', 10, false],
    ['  ', 10, false],
    ['{}', 10, false],
    ['{"seconds":30}', 30, false],
    ['{"seconds":60}', 60, false],
    ['{"seconds":61}', 60, true],
    ['{"seconds":3600}', 60, true],
    ['{"seconds":0.25}', 1, true],
    ['{"seconds":1.5}', 1.5, false],
  ])('body %j records for %d s (clamped: %s)', (body, seconds, clamped) => {
    expect(parseCpuProfileRequest(body)).toEqual({ seconds, clamped });
  });

  it.each([
    ['{', /JSON object/],
    ['null', /JSON object/],
    ['[]', /JSON object/],
    ['30', /JSON object/],
    ['"30"', /JSON object/],
    ['{"secs":30}', /Unknown field "secs"/],
    ['{"seconds":30,"interval":1}', /Unknown field "interval"/],
    ['{"seconds":0}', /positive number/],
    ['{"seconds":-5}', /positive number/],
    ['{"seconds":"30"}', /positive number/],
    ['{"seconds":null}', /positive number/],
    ['{"seconds":1e999}', /positive number/],
  ])('refuses body %j', (body, error) => {
    const parsed = parseCpuProfileRequest(body);
    expect('error' in parsed && parsed.error).toMatch(error);
  });

  it('gives the client the clamped recording plus a grace for writing', () => {
    expect(cpuProfileRequestTimeoutMs()).toBe(70_000);
    expect(cpuProfileRequestTimeoutMs(30)).toBe(90_000);
    expect(cpuProfileRequestTimeoutMs(600)).toBe(120_000);
    expect(cpuProfileRequestTimeoutMs(0.2)).toBe(61_000);
  });
});

describe('CpuProfileRecorder', () => {
  it('records for exactly its duration, writes one loadable file and closes its session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const inspector = fakeInspector();
    let now = Date.parse('2026-10-29T12:00:00.000Z');
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: () => now });

    const recording = recorder.record({ seconds: 60, clamped: true, directory });
    await until(() => vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(inspector.calls).toEqual(['connect', 'Profiler.enable', 'Profiler.start']);

    now += 60_000;
    await vi.advanceTimersByTimeAsync(1);
    const result = await recording;

    expect(inspector.calls).toEqual(['connect', 'Profiler.enable', 'Profiler.start', 'Profiler.stop', 'disconnect']);
    const written = await readFile(result.path, 'utf8');
    expect(result).toEqual({
      path: join(directory, 'cpu-2026-10-29T12-00-00-000Z.cpuprofile'),
      seconds: 60,
      clamped: true,
      recordedMs: 60_000,
      bytes: Buffer.byteLength(written),
      stoppedEarly: false,
    });
    expect(JSON.parse(written)).toEqual(PROFILE);
    // Readable by the node's own user only (POSIX permission bits).
    expect(process.platform === 'win32' || ((await stat(result.path)).mode & 0o777) === 0o600).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(logged).toEqual([
      '[cpu-profile] recording for 60 s',
      `[cpu-profile] wrote ${result.path} (60000 ms, ${result.bytes} bytes)`,
    ]);
  });

  it('creates a missing directory for the file', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });
    const nested = join(directory, 'diagnostics');
    const result = await recorder.record({ seconds: 0.01, clamped: false, directory: nested });
    expect(await readdir(nested)).toEqual([result.path.slice(nested.length + 1)]);
  });

  it('refuses a second profile while one runs, and records again once it ends', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });
    const first = recorder.record({ seconds: 0.2, clamped: false, directory });

    await expect(recorder.record({ seconds: 1, clamped: false, directory })).rejects.toBeInstanceOf(CpuProfileBusyError);
    await expect(recorder.record({ seconds: 1, clamped: false, directory })).rejects.toMatchObject({
      code: 'CPU_PROFILE_IN_PROGRESS',
      message: expect.stringMatching(/already being recorded/),
    });
    await expect(first).resolves.toMatchObject({ stoppedEarly: false });
    // The refused requests opened no session.
    expect(count(inspector.calls, 'connect')).toBe(1);

    await expect(recorder.record({ seconds: 0.01, clamped: false, directory })).resolves.toMatchObject({ seconds: 0.01 });
    expect(count(inspector.calls, 'connect')).toBe(2);
    expect(count(inspector.calls, 'disconnect')).toBe(2);
    expect(await readdir(directory)).toHaveLength(2);
  });

  it.each([
    ['Profiler.enable', ['connect', 'Profiler.enable', 'disconnect']],
    ['Profiler.start', ['connect', 'Profiler.enable', 'Profiler.start', 'disconnect']],
    ['Profiler.stop', ['connect', 'Profiler.enable', 'Profiler.start', 'Profiler.stop', 'disconnect']],
  ] as const)(
    'closes its session when %s fails, writes nothing and records again afterwards',
    async (method, calls) => {
      const inspector = fakeInspector({ method });
      const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });

      await expect(recorder.record({ seconds: 0.01, clamped: false, directory })).rejects.toThrow(`${method} failed`);
      expect(inspector.calls).toEqual(calls);
      expect(await readdir(directory)).toEqual([]);

      inspector.fail.method = undefined;
      await expect(recorder.record({ seconds: 0.01, clamped: false, directory })).resolves.toMatchObject({ stoppedEarly: false });
      expect(count(inspector.calls, 'disconnect')).toBe(2);
    },
  );

  it('closes its session when the file cannot be written', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });
    const notADirectory = join(directory, 'blocked');
    await writeFile(notADirectory, '');

    await expect(recorder.record({ seconds: 0.01, clamped: false, directory: notADirectory }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(inspector.calls).toEqual(['connect', 'Profiler.enable', 'Profiler.start', 'Profiler.stop', 'disconnect']);
    await expect(recorder.record({ seconds: 0.01, clamped: false, directory })).resolves.toMatchObject({ stoppedEarly: false });
  });

  it.each([
    ['opened', { open: true }, []],
    ['connected', { connect: true }, ['connect']],
  ] as const)('reports an inspector session that cannot be %s as unavailable', async (_label, fail, calls) => {
    const inspector = fakeInspector({ ...fail });
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession });

    const refused = await recorder.record({ seconds: 0.01, clamped: false, directory }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CpuProfileUnavailableError);
    expect(refused).toMatchObject({ code: 'CPU_PROFILE_UNAVAILABLE', message: expect.stringMatching(/inspector session/) });
    expect((refused as Error).cause).toBeInstanceOf(Error);
    // Nothing was started, so nothing is left to close.
    expect(inspector.calls).toEqual(calls);

    inspector.fail.open = false;
    inspector.fail.connect = false;
    await expect(recorder.record({ seconds: 0.01, clamped: false, directory })).resolves.toMatchObject({ stoppedEarly: false });
  });

  it('stops the running profile when shutdown begins, still writes it, and refuses later ones', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });
    const recording = recorder.record({ seconds: 60, clamped: false, directory });
    await until(() => inspector.calls.includes('Profiler.start'));

    const endedAt = performance.now();
    recorder.end();
    const result = await recording;

    expect(performance.now() - endedAt).toBeLessThan(1_000);
    expect(result).toMatchObject({ seconds: 60, stoppedEarly: true });
    expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual(PROFILE);
    expect(logged.at(-1)).toMatch(/^\[cpu-profile\] wrote .*, stopped early at shutdown\)$/);
    expect(inspector.calls).toEqual(['connect', 'Profiler.enable', 'Profiler.start', 'Profiler.stop', 'disconnect']);

    await expect(recorder.record({ seconds: 1, clamped: false, directory })).rejects.toMatchObject({
      code: 'CPU_PROFILE_UNAVAILABLE',
      message: expect.stringMatching(/shutting down/),
    });
    expect(count(inspector.calls, 'connect')).toBe(1);
  });

  it('refuses a profile once shutdown has begun, without opening a session', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession });
    recorder.end();
    await expect(recorder.record({ seconds: 1, clamped: false, directory })).rejects.toBeInstanceOf(CpuProfileUnavailableError);
    expect(inspector.calls).toEqual([]);
  });
});

function fakeReq(method: string, path: string, rawBody = '') {
  const req = Readable.from([]);
  Object.assign(req, {
    method,
    url: path,
    headers: { host: '127.0.0.1' },
    __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8'),
  });
  return req as unknown as RequestContext['req'];
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
  };
}

const RESULT: CpuProfileResult = {
  path: '/node-home/diagnostics/cpu-2026-10-29T12-00-00-000Z.cpuprofile',
  seconds: 10,
  clamped: false,
  recordedMs: 10_004,
  bytes: 4_096,
  stoppedEarly: false,
};

/** A recorder stand-in whose `record` answers with `outcome`. */
function recorderAnswering(outcome: CpuProfileResult | Error) {
  const record = vi.fn(async (_recording: CpuProfileRecording) => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { recorder: { record } as unknown as CpuProfileRecorder, record };
}

async function callRoute(
  authentication: AllowedHttpAuthentication,
  opts: { method?: string; path?: string; body?: string; outcome?: CpuProfileResult | Error; directory?: string | null } = {},
) {
  const res = fakeRes();
  const path = opts.path ?? CPU_PROFILE_PATH;
  const { recorder, record } = recorderAnswering(opts.outcome ?? RESULT);
  const ctx = {
    req: fakeReq(opts.method ?? 'POST', path, opts.body),
    res: res as unknown as ServerResponse,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    authentication,
    requestAgentAddress: '0x00000000000000000000000000000000000000a1',
  } as unknown as RequestContext;
  await handleCpuProfileRoutes(ctx, {
    recorder,
    ...(opts.directory === null ? {} : { directory: opts.directory ?? '/node-home/diagnostics' }),
  });
  return {
    status: res.statusCode,
    handled: res.writableEnded,
    body: res.body ? JSON.parse(res.body) as Record<string, unknown> : undefined,
    record,
  };
}

describe('POST /api/diagnostics/cpu-profile', () => {
  it('refuses an agent-scoped token before it reads the request or records', async () => {
    const answer = await callRoute(AGENT, { body: '{"seconds":30}' });
    expect(answer.status).toBe(403);
    expect(answer.body?.error).toBe(
      'POST /api/diagnostics/cpu-profile requires a node-level admin token; agent-scoped tokens cannot record a CPU profile of the node.',
    );
    expect(answer.record).not.toHaveBeenCalled();
  });

  it.each([
    ['a node-operator token', OPERATOR],
    ['auth disabled', AUTH_DISABLED],
  ])('records for %s and answers with the written file', async (_label, authentication) => {
    const answer = await callRoute(authentication);
    expect(answer).toMatchObject({ status: 200, body: { ...RESULT } });
    expect(answer.record).toHaveBeenCalledExactlyOnceWith({ seconds: 10, clamped: false, directory: '/node-home/diagnostics' });
  });

  it('records into the diagnostics directory of the node home by default', async () => {
    const answer = await callRoute(OPERATOR, { directory: null });
    expect(answer.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ directory: join(dkgDir(), 'diagnostics') }));
  });

  it.each([
    ['{"seconds":30}', 30, false],
    ['{"seconds":600}', 60, true],
    ['{"seconds":0.5}', 1, true],
  ])('passes the bounded duration of %s to the recorder', async (body, seconds, clamped) => {
    const answer = await callRoute(OPERATOR, { body });
    expect(answer.status).toBe(200);
    expect(answer.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seconds, clamped }));
  });

  it.each(['{', '[]', '{"seconds":-1}', '{"seconds":"10"}', '{"duration":10}'])(
    'refuses body %j with 400 and records nothing',
    async (body) => {
      const answer = await callRoute(OPERATOR, { body });
      expect(answer.status).toBe(400);
      expect(typeof answer.body?.error).toBe('string');
      expect(answer.record).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['GET', CPU_PROFILE_PATH],
    ['POST', '/api/diagnostics/cpu-profiles'],
  ])('leaves %s %s to the other routes', async (method, path) => {
    const answer = await callRoute(OPERATOR, { method, path });
    expect(answer).toMatchObject({ handled: false, status: 0 });
    expect(answer.record).not.toHaveBeenCalled();
  });

  it('answers 409 while another profile runs', async () => {
    const answer = await callRoute(OPERATOR, { outcome: new CpuProfileBusyError() });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({
      code: 'CPU_PROFILE_IN_PROGRESS',
      error: 'A CPU profile is already being recorded on this node; try again when it ends.',
    });
  });

  it('answers 503 when the node is shutting down or has no inspector, logging only a cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shuttingDown = await callRoute(OPERATOR, { outcome: new CpuProfileUnavailableError('The node is shutting down.') });
    expect(shuttingDown).toMatchObject({ status: 503, body: { code: 'CPU_PROFILE_UNAVAILABLE', error: 'The node is shutting down.' } });
    expect(log).not.toHaveBeenCalled();

    const cause = new Error('inspector is not available in this build');
    const noInspector = await callRoute(OPERATOR, { outcome: new CpuProfileUnavailableError('No inspector.', { cause }) });
    expect(noInspector).toMatchObject({ status: 503, body: { code: 'CPU_PROFILE_UNAVAILABLE', error: 'No inspector.' } });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[cpu-profile]'), cause);
  });

  it('answers 500 with a short error and logs the cause when recording fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const answer = await callRoute(OPERATOR, { outcome: failure });
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ code: 'CPU_PROFILE_FAILED', error: 'Recording or writing the CPU profile failed; see the node log.' });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('[cpu-profile]'), failure);
  });

  it('is reached through the daemon router, behind the same gate', async () => {
    const dispatch = async (authentication: AllowedHttpAuthentication, body: string) => {
      const res = fakeRes();
      await handleRequest({
        req: fakeReq('POST', CPU_PROFILE_PATH, body),
        res,
        agent: { resolveAgentAddress: () => '0x00000000000000000000000000000000000000a1' },
        authentication,
      } as unknown as HandleRequestInput);
      return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
    };
    expect((await dispatch(AGENT, '{"seconds":30}')).status).toBe(403);
    // An operator reaches the route's own validation; nothing is recorded.
    expect(await dispatch(OPERATOR, '{"seconds":0}')).toEqual({ status: 400, body: { error: 'seconds must be a positive number.' } });
  });
});

describe('a CPU profile during graceful shutdown', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is ended before the first await of the shutdown, and a failure there does not stop it', async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      removeApiPort: async () => { order.push('removeApiPort'); },
      log: (message) => logged.push(message),
      endCpuProfile: () => {
        order.push('endCpuProfile');
        throw new Error('recorder closed twice');
      },
    });
    expect(order).toEqual(['endCpuProfile', 'removeApiPort']);
    expect(logged).toContain('CPU profile stop error: recorder closed twice');
    expect(logged).toContain('Shutting down...');
  });

  it('does not hold the HTTP server close: the profile is written and answered at once', async () => {
    const inspector = fakeInspector();
    const recorder = new CpuProfileRecorder({ log, openSession: inspector.openSession, now: steppingClock() });
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      const ctx = { req, res, path, url: new URL(`http://127.0.0.1${path}`), authentication: OPERATOR } as unknown as RequestContext;
      await handleCpuProfileRoutes(ctx, { recorder, directory });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const answered = new Promise<{ status: number; body: CpuProfileResult }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: CPU_PROFILE_PATH, agent: false });
      request.on('response', (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as CpuProfileResult }));
      });
      request.on('error', reject);
      request.end('{"seconds":60}');
    });
    await until(() => inspector.calls.includes('Profiler.start'));

    const shutdownAt = performance.now();
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      removeApiPort: async () => {},
      log: () => {},
      endCpuProfile: () => recorder.end(),
    });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    servers.splice(servers.indexOf(server), 1);
    const closedAfterMs = performance.now() - shutdownAt;

    const answer = await answered;
    expect(closedAfterMs).toBeLessThan(2_000);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ seconds: 60, stoppedEarly: true });
    expect(JSON.parse(await readFile(answer.body.path, 'utf8'))).toEqual(PROFILE);
    expect(inspector.calls.at(-1)).toBe('disconnect');
  });
});
