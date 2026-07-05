import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { createSseHub } from '../src/daemon/sse-hub.js';

function fakeResponse(): ServerResponse & { writes: string[] } {
  class FakeResponse {
    writableEnded = false;
    writes: string[] = [];
    write = vi.fn((chunk: string) => {
      this.writes.push(chunk);
      return true;
    });
    end = vi.fn(() => {
      this.writableEnded = true;
      return this;
    });
  }
  return new FakeResponse() as unknown as ServerResponse & { writes: string[] };
}

describe('createSseHub', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts named event frames to every connected client', () => {
    const hub = createSseHub();
    const first = fakeResponse();
    const second = fakeResponse();

    hub.add(first);
    hub.add(second, { sessionId: 'session-2', compatToken: 'token-2', expiresAt: Date.now() + 10_000 });
    hub.broadcast('memory_graph_changed', { contextGraphId: 'cg-1', version: 2 });

    const expected = 'event: memory_graph_changed\ndata: {"contextGraphId":"cg-1","version":2}\n\n';
    expect(first.writes).toEqual([expected]);
    expect(second.writes).toEqual([expected]);
    expect(hub.size()).toBe(2);
  });

  it('closes dashboard-session streams when their session expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hub = createSseHub();
    const res = fakeResponse();

    hub.add(res, { sessionId: 'session-1', compatToken: 'token-1', expiresAt: 1_050 });

    expect(hub.size()).toBe(1);
    expect(res.end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(49);
    expect(hub.size()).toBe(1);
    expect(res.end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hub.size()).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('closes dashboard-session streams when their backing token is revoked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let tokenValid = true;
    const hub = createSseHub({
      heartbeatMs: 100,
      isDashboardSessionTokenValid: () => tokenValid,
    });
    const res = fakeResponse();

    hub.add(res, { sessionId: 'session-1', compatToken: 'token-1', expiresAt: 10_000 });
    expect(hub.size()).toBe(1);

    tokenValid = false;
    vi.advanceTimersByTime(100);

    expect(hub.size()).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('closes password-login streams when their credential fingerprint is stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let credentialCurrent = true;
    const hub = createSseHub({
      heartbeatMs: 100,
      isDashboardSessionCredentialFingerprintCurrent: () => credentialCurrent,
    });
    const res = fakeResponse();

    hub.add(res, {
      sessionId: 'session-1',
      compatToken: 'token-1',
      credentialFingerprint: 'credential-a',
      expiresAt: 10_000,
    });
    expect(hub.size()).toBe(1);

    credentialCurrent = false;
    vi.advanceTimersByTime(100);

    expect(hub.size()).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast to stale password-login streams', () => {
    let credentialCurrent = true;
    const hub = createSseHub({
      isDashboardSessionCredentialFingerprintCurrent: () => credentialCurrent,
    });
    const res = fakeResponse();

    hub.add(res, {
      sessionId: 'session-1',
      compatToken: 'token-1',
      credentialFingerprint: 'credential-a',
      expiresAt: Date.now() + 10_000,
    });
    credentialCurrent = false;
    hub.broadcast('memory_graph_changed', { contextGraphId: 'cg-1' });

    expect(hub.size()).toBe(0);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
