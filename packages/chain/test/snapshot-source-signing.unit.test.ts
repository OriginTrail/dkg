import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { IdentityIdCache } from '../src/identity-id-cache.js';
import { EVMChainAdapterBase } from '../src/evm-adapter-base.js';
import { AckSignMethods } from '../src/evm-adapter-ack-sign.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { activeRpcRequestAbortSignal, withRpcRequestContext } from '../src/rpc-request-transport.js';

const address = `0x${'1'.repeat(40)}`;
const message = new Uint8Array([1, 2, 3]);
function identityFixture(held?: string, cooperative = true) {
  const signals: Array<AbortSignal | undefined> = [];
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const step = vi.fn(async (stage: string) => {
    const signal = activeRpcRequestAbortSignal();
    signals.push(signal);
    if (stage !== held) return;
    enter();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      release = () => { signal?.removeEventListener('abort', abort); resolve(); };
      if (cooperative) signal?.addEventListener('abort', abort, { once: true });
    });
  });
  const adapter = {
    signer: { address }, contracts: {}, identityIdCache: new IdentityIdCache(address),
    init: () => step('init'),
    getIdentityStorage: async () => { await step('storage'); return {}; },
    identityStorageAddressChanged: async () => { await step('rotation'); return false; },
    readContract: async () => { await step('read'); return 7n; },
    readIdentityIdFromStorage: EVMChainAdapterBase.prototype['readIdentityIdFromStorage'],
    readIdentityIdForAddress: vi.fn(async (_address: string) => 9n),
  };
  const get = (signal?: AbortSignal, ownership: 'shared' | 'independent' = 'independent') =>
    EVMChainAdapterBase.prototype.getIdentityId.call(adapter as never, { signal, ownership });
  return { adapter, get, entered, step, signals, release: () => release?.() };
}

describe('source responder identity and signing cancellation', () => {
  it.each(['init', 'storage', 'rotation', 'read'])(
    'cancels the scoped %s lookup without issuing subsequent reads', async stage => {
      const f = identityFixture(stage), abort = new AbortController(), reason = new Error('proof expired');
      const outcome = f.get(abort.signal).catch(error => error);
      try {
        await f.entered;
        const calls = f.step.mock.calls.length;
        abort.abort(reason);
        expect(await outcome).toBe(reason);
        expect(f.step).toHaveBeenCalledTimes(calls);
        expect(f.adapter.readIdentityIdForAddress).not.toHaveBeenCalled();
      } finally { f.release(); await outcome; }
    },
  );

  it.each(['init', 'storage', 'rotation', 'read'])(
    'fences a non-cooperative late %s completion', async stage => {
      const f = identityFixture(stage, false), abort = new AbortController();
      let settled = false;
      const outcome = f.get(abort.signal).catch(error => error).finally(() => { settled = true; });
      await f.entered;
      const calls = f.step.mock.calls.length;
      const reason = new Error('shutdown'); abort.abort(reason);
      await Promise.resolve(); expect(settled).toBe(false);
      f.release();
      expect(await outcome).toBe(reason);
      expect(f.step).toHaveBeenCalledTimes(calls);
    },
  );

  it('selects the explicit read strategy independently of explicit or inherited cancellation', async () => {
    const f = identityFixture();
    expect(await EVMChainAdapterBase.prototype.getIdentityId.call(f.adapter as never)).toBe(9n);
    expect(f.adapter.readIdentityIdForAddress).toHaveBeenCalledExactlyOnceWith(address);
    const signal = new AbortController().signal;
    expect(await f.get(signal, 'shared')).toBe(9n);
    expect(await withRpcRequestContext({ signal }, () => f.get(undefined, 'shared'))).toBe(9n);
    expect(await f.get(undefined, 'independent')).toBe(7n);
    expect(await f.get(new AbortController().signal)).toBe(7n);
    expect(f.adapter.readIdentityIdForAddress).toHaveBeenCalledTimes(3);
    const stopped = AbortSignal.abort(new Error('parent stopped'));
    for (const ownership of ['shared', 'independent'] as const)
      await expect(withRpcRequestContext({ signal: stopped }, () => f.get(undefined, ownership))).rejects.toThrow('parent stopped');
    expect(f.step).toHaveBeenCalledTimes(8);
  });

  it('fences a cancelled shared waiter without aborting or poisoning the shared cached load', async () => {
    const f = identityFixture('read'), abort = new AbortController();
    f.adapter.readIdentityIdForAddress.mockImplementation(addr =>
      EVMChainAdapterBase.prototype['readIdentityIdForAddress'].call(f.adapter as never, addr));
    let settled = false;
    const first = f.get(abort.signal, 'shared').catch(error => error).finally(() => { settled = true; });
    const second = f.get(undefined, 'shared');
    try {
      await f.entered;
      const reason = new Error('shared waiter stopped'); abort.abort(reason);
      await Promise.resolve(); expect(settled).toBe(false);
      expect(f.signals.filter((_signal, i) => f.step.mock.calls[i][0] !== 'init'))
        .toEqual([undefined, undefined, undefined]);
      f.release();
      expect(await first).toBe(reason);
      expect(await second).toBe(7n);
      expect(await f.get(undefined, 'shared')).toBe(7n);
      expect(f.step.mock.calls.filter(([stage]) => stage !== 'init'))
        .toEqual([['storage'], ['rotation'], ['read']]);
    } finally { f.release(); await Promise.all([first, second]); }
  });

  it('also fences arbitrary-address cached reads before dispatch and after physical settlement', async () => {
    const f = identityFixture('read'), abort = new AbortController();
    const read = () => EVMChainAdapterBase.prototype['readIdentityIdForAddress'].call(f.adapter as never, address);
    const first = withRpcRequestContext({ signal: abort.signal }, read).catch(error => error);
    await f.entered;
    const reason = new Error('address waiter stopped'); abort.abort(reason);
    const second = read();
    f.release();
    expect(await first).toBe(reason); expect(await second).toBe(7n);
    const calls = f.step.mock.calls.length;
    await expect(withRpcRequestContext({ signal: abort.signal }, read)).rejects.toBe(reason);
    expect(f.step).toHaveBeenCalledTimes(calls);
    expect(f.step.mock.calls.filter(([stage]) => stage !== 'init'))
      .toEqual([['storage'], ['rotation'], ['read']]);
  });

  it('retains non-cancellable signing until settlement and refuses a late signature', async () => {
    const wallet = ethers.Wallet.createRandom(), signature = await wallet.signMessage(message);
    let release!: (signature: string) => void;
    const signMessage = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const adapter = { signer: { signMessage } }, abort = new AbortController();
    let settled = false;
    const outcome = AckSignMethods.prototype.signMessage.call(adapter as never, message, { signal: abort.signal })
      .catch(error => error).finally(() => { settled = true; });
    const reason = new Error('signing expired'); abort.abort(reason);
    await Promise.resolve(); expect(settled).toBe(false);
    release(signature); expect(await outcome).toBe(reason);
    await expect(AckSignMethods.prototype.signMessage.call(adapter as never, message, { signal: abort.signal }))
      .rejects.toBe(reason);
    expect(signMessage).toHaveBeenCalledTimes(1);
    const proof = await AckSignMethods.prototype.signMessage.call({ signer: wallet } as never, message);
    expect(ethers.verifyMessage(message, { r: ethers.hexlify(proof.r), yParityAndS: ethers.hexlify(proof.vs) })).toBe(wallet.address);
  });

  it('preserves mock identity and signing behavior with explicit cancellation', async () => {
    const wallet = ethers.Wallet.createRandom(), adapter = new MockChainAdapter('mock:31337', wallet.address);
    expect(await adapter.getIdentityId()).toBe(0n);
    const identity = await adapter.ensureProfile();
    expect(await adapter.getIdentityId({ signal: new AbortController().signal })).toBe(identity);
    expect(await adapter.signMessage(message)).toEqual({ r: new Uint8Array(32), vs: new Uint8Array(32) });
    adapter.setMockACKSigner(wallet);
    const proof = await adapter.signMessage(message, { signal: new AbortController().signal });
    expect(ethers.verifyMessage(message, { r: ethers.hexlify(proof.r), yParityAndS: ethers.hexlify(proof.vs) })).toBe(wallet.address);
    const reason = new Error('mock stop'), signal = AbortSignal.abort(reason);
    await expect(adapter.getIdentityId({ signal })).rejects.toBe(reason);
    await expect(adapter.signMessage(message, { signal })).rejects.toBe(reason);
    let release!: (signature: string) => void;
    const signature = await wallet.signMessage(message);
    vi.spyOn(wallet, 'signMessage').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const outcome = adapter.signMessage(message, { signal: abort.signal }).catch(error => error);
    abort.abort(reason); release(signature);
    expect(await outcome).toBe(reason);
  });
});
