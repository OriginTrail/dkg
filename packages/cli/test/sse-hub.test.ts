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

  it('closes dashboard-session streams when their session expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const hub = createSseHub();
    const res = fakeResponse();

    hub.add(res, { sessionId: 'session-1', expiresAt: 1_050 });

    expect(hub.size()).toBe(1);
    expect(res.end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(49);
    expect(hub.size()).toBe(1);
    expect(res.end).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(hub.size()).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
