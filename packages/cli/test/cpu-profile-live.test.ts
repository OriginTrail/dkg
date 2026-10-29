// End to end through a real daemon on the mock chain: the CPU profile route
// behind the daemon's own authentication, a real inspector session in the
// daemon process, and a running profile that a stop of the daemon ends without
// holding the shutdown. The daemon is a child process, so its inspector
// session never touches this test worker's coverage.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CPU_PROFILE_PATH } from '../src/cpu-profile-wire.js';
import { startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

let daemon: LiveDaemon;
let operatorToken: string;
let agentToken: string;

async function call(path: string, token: string, body: unknown) {
  const res = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function readProfile(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as {
    nodes: Array<{ id: number; callFrame: { functionName: string } }>;
    startTime: number;
    endTime: number;
    samples: number[];
    timeDeltas: number[];
  };
}

/** Wait, in real time, for a line in the daemon's output. */
async function untilLogged(text: string): Promise<void> {
  const startedAt = Date.now();
  while (!daemon.owner.stdout.includes(text)) {
    if (Date.now() - startedAt > 20_000) throw new Error(`daemon never logged "${text}"`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('CPU profile on a live daemon (mock chain)', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    operatorToken = daemon.token!;
    const registered = await call('/api/agent/register', operatorToken, { name: 'profile-agent', framework: 'test' });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    agentToken = String(registered.body.authToken);
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  }, 30_000);

  it('refuses an agent-scoped token and writes a real profile for the node operator', async () => {
    const refused = await call(CPU_PROFILE_PATH, agentToken, { seconds: 1 });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toMatch(/requires a node-level admin token/);

    const recorded = await call(CPU_PROFILE_PATH, operatorToken, { seconds: 1 });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body).toMatchObject({ seconds: 1, clamped: false, stoppedEarly: false });
    const path = String(recorded.body.path);
    expect(dirname(path)).toBe(join(daemon.home, 'diagnostics'));
    expect((await stat(path)).size).toBe(recorded.body.bytes);
    const profile = await readProfile(path);
    expect(profile.endTime).toBeGreaterThan(profile.startTime);
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.timeDeltas).toHaveLength(profile.samples.length);
    expect(profile.nodes.map((node) => node.callFrame.functionName)).toContain('(root)');
  });

  it('refuses a second profile while one runs, and a stop of the node ends the running one', async () => {
    const running = call(CPU_PROFILE_PATH, operatorToken, { seconds: 600 });
    // Awaited below; this only keeps a failure before that from going unhandled.
    running.catch(() => {});
    await untilLogged('[cpu-profile] recording for 60 s');

    const second = await call(CPU_PROFILE_PATH, operatorToken, { seconds: 1 });
    expect(second).toEqual({
      status: 409,
      body: { code: 'CPU_PROFILE_IN_PROGRESS', error: 'A CPU profile is already being recorded on this node; try again when it ends.' },
    });

    // Graceful shutdown ends the profile at once: the node stops well inside
    // its 15 s hard deadline, with the ordinary exit code, not the forced one.
    const stoppedAt = Date.now();
    daemon.child.kill('SIGTERM');
    await daemon.owner.waitForExit(14_000);
    expect(Date.now() - stoppedAt).toBeLessThan(14_000);

    const answer = await running;
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ seconds: 60, clamped: true, stoppedEarly: true });
    expect(Number(answer.body.recordedMs)).toBeLessThan(30_000);
    const profile = await readProfile(String(answer.body.path));
    expect(profile.timeDeltas).toHaveLength(profile.samples.length);
  }, 60_000);
});
