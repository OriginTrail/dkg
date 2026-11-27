import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext, type ContextGraphAuthorityIndexSnapshots } from '@origintrail-official/dkg-chain';
import { startAuthorityIndexSnapshotRuntime } from '../src/authority-index-snapshot-runtime.js';
import { AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES } from '../src/authority-index-snapshot-service.js';

afterEach(() => vi.useRealTimers());

function fixture(refresh = vi.fn(async () => {})) {
  const snapshots: ContextGraphAuthorityIndexSnapshots = {
    open: vi.fn(), close: vi.fn(async () => {}),
    exportSnapshot: vi.fn(async () => null), refresh,
  };
  return { snapshots, register: vi.fn(), warn: vi.fn() };
}

describe('core authority index refresh lifecycle', () => {
  it('only starts indexing and serving for cores with an index', () => {
    const ports = fixture();
    expect(startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'edge' })).toBeUndefined();
    expect(startAuthorityIndexSnapshotRuntime({ ...ports, snapshots: undefined, nodeRole: 'core' })).toBeUndefined();
    expect(ports.register).not.toHaveBeenCalled();
    expect(ports.snapshots.refresh).not.toHaveBeenCalled();
  });

  it('registers the shared request byte limit', async () => {
    const ports = fixture();
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    expect(ports.register).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
    });
    await runtime.close();
  });

  it('uses background RPC capacity while rebuilding the core index', async () => {
    let observed: ReturnType<typeof activeRpcRequestContext> | undefined;
    const refresh = vi.fn(async () => {
      observed = activeRpcRequestContext();
    });
    const ports = fixture(refresh);
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    await Promise.resolve();
    await runtime.close();
    expect(observed?.requestClass).toBe('background');
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    expect(ports.warn).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('serves registered requests without starting another refresh and limits router PeerID objects', async () => {
    vi.useFakeTimers();
    const ports = fixture();
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.snapshots.refresh).toHaveBeenCalledOnce();
    const handler = ports.register.mock.calls[0][1];
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, request: {
      scope: 'base:84532:0x123456', deploymentBlockNumber: 100,
      minThroughBlockNumber: 500, maxThroughBlockNumber: 2_500,
    } }));
    const peer = { toString: () => 'authenticated-peer', toBytes: () => new Uint8Array() };
    const status = async () => JSON.parse(new TextDecoder().decode(await handler(bytes, peer))).status;
    for (let i = 0; i < 4; i += 1) expect(await status()).toBe('not-ready');
    expect(await status()).toBe('busy');
    expect(ports.snapshots.exportSnapshot).toHaveBeenCalledTimes(4);
    expect(ports.snapshots.refresh).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('does not overlap slow cold builds and waits 30 seconds after completion', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const ports = fixture(vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(2);
    finish();
    await runtime.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(2);
  });

  it('retries a failed refresh and stops scheduling after close', async () => {
    vi.useFakeTimers();
    const ports = fixture(vi.fn(async () => { throw new Error('RPC unavailable'); }));
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.warn).toHaveBeenCalledWith(expect.stringContaining('RPC unavailable'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(2);
    await runtime.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.snapshots.refresh).toHaveBeenCalledTimes(2);
  });

  it('cancels and drains the in-flight refresh before close resolves', async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    const refresh = vi.fn((options?: { signal?: AbortSignal }) => {
      signal = options!.signal!;
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const ports = fixture(refresh);
    const runtime = startAuthorityIndexSnapshotRuntime({ ...ports, nodeRole: 'core' })!;
    await Promise.resolve();
    let closed = false;
    const drain = runtime.close().then(() => { closed = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await drain;
    expect(closed).toBe(true);
    expect(ports.warn).not.toHaveBeenCalled();
  });
});
