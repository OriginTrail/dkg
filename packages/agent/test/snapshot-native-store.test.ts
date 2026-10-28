import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSnapshotNativeStore } from '../src/snapshot-native-store.js';
import { startSnapshotNativeProcess } from '../src/snapshot-native-process.js';

const closeClient = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@origintrail-official/dkg-storage', () => ({ BlazegraphStore: class { async close() { await closeClient(); } } }));
vi.mock('../src/snapshot-native-process.js', () => ({ startSnapshotNativeProcess: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
const stop = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks(); closeClient.mockResolvedValue(undefined);
  vi.mocked(delay).mockImplementation(async () => undefined);
  vi.mocked(startSnapshotNativeProcess).mockImplementation(async (_java, _args, _folder, _log, signal) =>
    ({ stop, closed: Promise.resolve(0), assertRunning: () => signal.throwIfAborted() }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const options = (signal = new AbortController().signal) => ({ java: '/fixture/java', jar: '/fixture/runtime.jar',
  properties: '/fixture/audit.properties', folder: '/fixture', log: '/fixture/session.log', signal });

it('closes the physical process once even when client shutdown fails or is requested concurrently', async () => {
  const store = await openSnapshotNativeStore(options());
  closeClient.mockRejectedValue(new Error('client close failed'));
  const results = await Promise.allSettled([store.close(), store.close()]);
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(closeClient).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
});

it('bounds unsuccessful readiness attempts and closes before rejecting', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
  const pending = openSnapshotNativeStore(options());
  const rejected = expect(pending).rejects.toThrow('readiness deadline');
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(60); expect(stop).toHaveBeenCalledOnce();
  expect(delay).toHaveBeenCalledTimes(60);
  expect(delay).toHaveBeenCalledWith(1000, undefined, { signal: expect.any(AbortSignal) });
});

it('cancels the readiness pacing wait without another probe and retains startup errors', async () => {
  const caller = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  vi.mocked(delay).mockImplementation((_ms, _value, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    entered();
  }));
  vi.mocked(fetch).mockRejectedValue(new Error('not listening yet'));
  const pending = openSnapshotNativeStore(options(caller.signal));
  const rejected = expect(pending).rejects.toThrow();
  await waiting;
  caller.abort(new Error('cancelled')); await rejected;
  expect(fetch).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  vi.mocked(startSnapshotNativeProcess).mockRejectedValueOnce(new Error('spawn refused'));
  await expect(openSnapshotNativeStore(options())).rejects.toThrow('spawn refused');
});
