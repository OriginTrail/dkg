import { describe, expect, it, vi } from 'vitest';
import { watchProtocolRefusal, type DialProtocolHost } from '../../../scripts/testing/protocol-refusal.js';

/**
 * The shared late-handler hook of the network-admission and router e2e tests
 * (scripts/testing/protocol-refusal.ts). Those tests only exercise its happy
 * path, so its filters are pinned here against a fake host.
 */
const PROTOCOL = '/test/late-handler/1.0.0';
const refusal = () => Object.assign(new Error('could not negotiate'), { name: 'UnsupportedProtocolError' });

// A fake host with its own peer, options and result types: the watcher infers them from it, exactly
// as it does from a real libp2p node, and the tests call it through the declared signature.
interface FakeDialOptions {
  readonly timeoutMs?: number;
}
type FakeHost = DialProtocolHost<string, FakeDialOptions, string>;

// Plain methods, not vi.fn mocks: the helper spies on `dialProtocol` itself, and a spy on an
// existing mock would be that same mock (the wrapper would call itself).
function hostThatRejectsWith(makeError: () => unknown): FakeHost {
  return {
    async dialProtocol() {
      throw makeError();
    },
  };
}

async function dial(host: FakeHost, protocols: string | string[]): Promise<unknown> {
  return host.dialProtocol('peer', protocols).then(() => 'resolved', (error: unknown) => error);
}

// Compile-time only: vitest strips types and never calls this. The watcher leaves the host's dial
// signature as declared, so a wrong peer, options or result is an error at the call site. The
// directives are checked by a type-aware pass over this file (an editor, or `tsc --noEmit` with
// this file and the helper in `files`); no repository tsconfig includes `packages/core/test`.
async function dialSignatureReachesTheCaller(host: FakeHost, protocols: string[]): Promise<void> {
  watchProtocolRefusal(host, PROTOCOL, () => {});
  const stream: string = await host.dialProtocol('peer', protocols, { timeoutMs: 1 });
  // @ts-expect-error the peer is a string
  await host.dialProtocol(42, protocols);
  // @ts-expect-error the options' timeoutMs is a number
  await host.dialProtocol('peer', protocols, { timeoutMs: 'soon' });
  // @ts-expect-error the result is a string
  const count: number = await host.dialProtocol('peer', protocols);
  // @ts-expect-error a host without a dialProtocol is not watchable
  watchProtocolRefusal({}, PROTOCOL, () => {});
  // @ts-expect-error type arguments that disagree with the host's own
  watchProtocolRefusal<number, FakeDialOptions, string>(host, PROTOCOL, () => {});
  void [stream, count];
}
void dialSignatureReachesTheCaller;

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
    const succeeding: FakeHost = { async dialProtocol() { return 'stream'; } };
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

  it('forwards the peer, protocols and options untouched, on the host, and resolves with the wrapped dial result', async () => {
    const seen: { self: unknown; peer: string; protocols: string | string[]; options: FakeDialOptions | undefined }[] = [];
    const host: FakeHost = {
      async dialProtocol(peer, protocols, options) {
        seen.push({ self: this, peer, protocols, options });
        return `stream:${peer}`;
      },
    };
    const watch = watchProtocolRefusal(host, PROTOCOL, () => {});
    try {
      const protocols = [PROTOCOL];
      const options = { timeoutMs: 5 };
      expect(await host.dialProtocol('peer-1', protocols, options)).toBe('stream:peer-1');
      expect(await host.dialProtocol('peer-2', PROTOCOL)).toBe('stream:peer-2');

      expect(seen).toHaveLength(2);
      // The same array and options objects, and the host as receiver (a real libp2p node needs it).
      expect(seen[0].self).toBe(host);
      expect(seen[0].peer).toBe('peer-1');
      expect(seen[0].protocols).toBe(protocols);
      expect(seen[0].options).toBe(options);
      expect(seen[1].self).toBe(host);
      expect(seen[1].protocols).toBe(PROTOCOL);
      expect(seen[1].options).toBeUndefined();
      expect(watch.refusedDials).toBe(0);
    } finally {
      watch.dispose();
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
