import { describe, expect, it, vi } from 'vitest';
import { watchProtocolRefusal, type DialProtocolHost } from '../../../scripts/testing/protocol-refusal.js';

/**
 * The shared late-handler hook of the network-admission and router e2e tests
 * (scripts/testing/protocol-refusal.ts). Those tests only exercise its happy
 * path, so its filters are pinned here against a fake host.
 */
const PROTOCOL = '/test/late-handler/1.0.0';
const refusal = () => Object.assign(new Error('could not negotiate'), { name: 'UnsupportedProtocolError' });

// Plain methods, not vi.fn mocks: the helper spies on `dialProtocol` itself, and a spy on an
// existing mock would be that same mock (the wrapper would call itself).
function hostThatRejectsWith(makeError: () => unknown): DialProtocolHost {
  return {
    async dialProtocol() {
      throw makeError();
    },
  } as unknown as DialProtocolHost;
}

async function dial(host: DialProtocolHost, protocols: string | string[]): Promise<unknown> {
  return (host.dialProtocol as (peer: unknown, protocols: string | string[]) => Promise<unknown>)('peer', protocols)
    .then(() => 'resolved', (error: unknown) => error);
}

describe('watchProtocolRefusal', () => {
  it('runs the callback once, on the first refused dial of exactly the watched protocol, and rethrows', async () => {
    const host = hostThatRejectsWith(refusal);
    const onFirstRefusal = vi.fn();
    const watch = watchProtocolRefusal(host, PROTOCOL, onFirstRefusal);
    try {
      expect(watch.registrations).toBe(0);
      expect(() => watch.msSinceFirstRefusal()).toThrow(/no refusal of .* was observed/);

      const first = await dial(host, PROTOCOL);
      expect((first as Error).name).toBe('UnsupportedProtocolError');
      expect(onFirstRefusal).toHaveBeenCalledTimes(1);
      expect(watch.refusedDials).toBe(1);
      expect(watch.registrations).toBe(1);

      // A later refusal is counted but never registers again; a one-element list is the same dial.
      await dial(host, [PROTOCOL]);
      await dial(host, PROTOCOL);
      expect(onFirstRefusal).toHaveBeenCalledTimes(1);
      expect(watch.refusedDials).toBe(3);
      expect(watch.registrations).toBe(1);
      expect(watch.msSinceFirstRefusal()).toBeGreaterThanOrEqual(0);
    } finally {
      watch.dispose();
    }
  });

  it('ignores a refusal of another protocol, and a dial that offers more than the watched protocol', async () => {
    const host = hostThatRejectsWith(refusal);
    const onFirstRefusal = vi.fn();
    const watch = watchProtocolRefusal(host, PROTOCOL, onFirstRefusal);
    try {
      await dial(host, '/test/another/1.0.0');
      await dial(host, [PROTOCOL, '/test/another/1.0.0']);
      await dial(host, [PROTOCOL, PROTOCOL]);
      expect(onFirstRefusal).not.toHaveBeenCalled();
      expect(watch.refusedDials).toBe(0);
    } finally {
      watch.dispose();
    }
  });

  it('ignores a failure that is not a protocol refusal, and a dial that succeeds', async () => {
    const failing = hostThatRejectsWith(() => Object.assign(new Error('dial timed out'), { name: 'TimeoutError' }));
    const onFirstRefusal = vi.fn();
    const watchFailing = watchProtocolRefusal(failing, PROTOCOL, onFirstRefusal);
    const succeeding = { async dialProtocol() { return 'stream'; } } as unknown as DialProtocolHost;
    const watchSucceeding = watchProtocolRefusal(succeeding, PROTOCOL, onFirstRefusal);
    try {
      expect((await dial(failing, PROTOCOL) as Error).name).toBe('TimeoutError');
      expect(await dial(succeeding, PROTOCOL)).toBe('resolved');
      expect(onFirstRefusal).not.toHaveBeenCalled();
      expect(watchFailing.refusedDials).toBe(0);
      expect(watchSucceeding.refusedDials).toBe(0);
    } finally {
      watchFailing.dispose();
      watchSucceeding.dispose();
    }
  });

  it('reports what it saw when the awaited work fails, and stops watching on dispose', async () => {
    const host = hostThatRejectsWith(refusal);
    const original = host.dialProtocol;
    const watch = watchProtocolRefusal(host, PROTOCOL, () => {});
    await dial(host, PROTOCOL);
    const failure = (() => {
      try {
        watch.failWithContext('the probe did not admit the peer')(new Error('boom'));
      } catch (error) {
        return error as Error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toBe('the probe did not admit the peer (refused dials: 1, handler registrations: 1): boom');
    expect((failure!.cause as Error).message).toBe('boom');

    watch.dispose();
    expect(host.dialProtocol).toBe(original);
  });
});
