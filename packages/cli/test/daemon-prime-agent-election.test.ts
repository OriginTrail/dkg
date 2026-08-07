/**
 * Session election through the daemon's routing layer. Prime Agent sessions
 * are daemon-managed and survive terminal restarts, so two live sessions is a
 * legitimate state — and after a restart the RESUMED session's descriptor is
 * the newer one. Routing must follow `lastActiveAt`, the per-turn activity
 * stamp, not `startedAt`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getPrimeAgentChannelTargets } from '../src/daemon/prime-agent.js';

let agentDir: string;
let sessionsDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'dkg-prime-agent-election-'));
  sessionsDir = join(agentDir, '.dkg-adapter-prime-agent', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

function writeDescriptor(sessionId: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sessionsDir, `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      bridgeUrl: 'http://127.0.0.1:4321',
      pid: process.pid,
      startedAt: '2030-01-01T00:00:00.000Z',
      ...over,
    }),
  );
}

describe('prime-agent session election', () => {
  beforeEach(() => {
    // The restart shape: OLD was resumed by the Prime daemon, so its descriptor
    // is newer — but the operator's turns are landing in NEW.
    writeDescriptor('old-resumed', {
      startedAt: '2030-01-02T00:00:00.000Z',
      lastActiveAt: '2030-01-02T00:00:00.000Z',
    });
    writeDescriptor('new-active', {
      startedAt: '2030-01-01T00:00:00.000Z',
      lastActiveAt: '2030-01-03T00:00:00.000Z',
    });
  });

  it('routes to the most recently active session when none is named', () => {
    const targets = getPrimeAgentChannelTargets({});
    expect(targets.map((t) => t.sessionId)).toEqual(['new-active', 'old-resumed']);
  });

  it('honours an explicit sessionId over the election', () => {
    const targets = getPrimeAgentChannelTargets({ sessionId: 'old-resumed' });
    expect(targets.map((t) => t.sessionId)).toEqual(['old-resumed']);
  });
});
