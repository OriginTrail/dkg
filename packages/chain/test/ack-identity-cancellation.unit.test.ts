import { describe, expect, it, vi } from 'vitest';
import { AckSignMethods } from '../src/evm-adapter-ack-sign.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { activeRpcRequestAbortSignal, withRpcRequestContext } from '../src/rpc-request-transport.js';

const address = `0x${'1'.repeat(40)}`;

function fixture(hold?: string, answers = [true, true]) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const signals: Array<AbortSignal | undefined> = [];
  const step = vi.fn(async (name: string) => {
    const signal = activeRpcRequestAbortSignal();
    signals.push(signal);
    if (name !== hold) return;
    enter();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      release = () => { signal?.removeEventListener('abort', abort); resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const adapter = {
    init: () => step('init'),
    resolveContract: async (name: string) => { await step(name); return {}; },
    readContract: vi.fn(async (_contract, _label, method: string) => {
      await step(method); return answers[method === 'keyHasPurpose' ? 0 : 1];
    }),
    verifyACKIdentityDetailed: AckSignMethods.prototype.verifyACKIdentityDetailed,
  };
  const verify = (signal?: AbortSignal) => AckSignMethods.prototype.verifyACKIdentity.call(
    adapter as never, address, 7n, { signal },
  );
  return { verify, entered, release: () => release?.(), step, signals, adapter };
}

describe('cancellable ACK identity verification', () => {
  it('keeps mock registration decisions and cancellation consistent through both public APIs', async () => {
    const signer = `0x${'ab'.repeat(20)}`;
    const adapter = new MockChainAdapter('mock:31337', signer);
    expect(await adapter.verifyACKIdentity(signer, 1n)).toBe(false);
    const identity = await adapter.ensureProfile();
    expect(await adapter.verifyACKIdentity(signer.toUpperCase(), identity)).toBe(true);
    expect(await adapter.verifyACKIdentityDetailed(signer, identity)).toEqual({ valid: true });
    expect(await adapter.verifyACKIdentity(signer, identity + 1n)).toBe(false);
    expect(await adapter.verifyACKIdentityDetailed(address, identity))
      .toEqual({ valid: false, reason: 'key-not-registered' });
    const reason = new Error('mock proof cancelled'), signal = AbortSignal.abort(reason);
    await expect(adapter.verifyACKIdentity(signer, identity, { signal })).rejects.toBe(reason);
    await expect(adapter.verifyACKIdentityDetailed(signer, identity, { signal })).rejects.toBe(reason);
  });

  it.each(['init', 'IdentityStorage', 'keyHasPurpose', 'ShardingTableStorage', 'nodeExists'])(
    'cancels a stalled %s read without starting later reads', async stage => {
      const f = fixture(stage), abort = new AbortController();
      let settled = false;
      const result = f.verify(abort.signal).then(value => ({ value }), error => ({ error }))
        .finally(() => { settled = true; });
      try {
        await f.entered;
        const count = f.step.mock.calls.length;
        const reason = new Error('probe cancelled'); abort.abort(reason);
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(await result).toEqual({ error: reason });
        expect(f.step).toHaveBeenCalledTimes(count);
        expect(f.signals.every(signal => signal === abort.signal)).toBe(true);
      } finally { f.release(); await result; }
    },
  );

  it('preserves both operational-key and active sharding-table gates', async () => {
    for (const answers of [[false, true], [true, false], [true, true]]) {
      const f = fixture(undefined, answers);
      expect(await f.verify()).toBe(answers.every(Boolean));
      expect(f.adapter.readContract).toHaveBeenCalledTimes(answers[0] ? 2 : 1);
    }
  });

  it('inherits parent cancellation and rejects pre-aborted reads before initialization', async () => {
    const f = fixture(), parent = new AbortController();
    parent.abort(new Error('parent stopped'));
    await expect(withRpcRequestContext({ signal: parent.signal }, () => f.verify()))
      .rejects.toThrow('parent stopped');
    expect(f.step).not.toHaveBeenCalled();
  });
});
