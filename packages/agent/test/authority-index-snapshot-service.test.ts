import { afterEach, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  createAuthorityIndexSnapshotClient,
  createAuthorityIndexSnapshotHandler,
  normalizeAuthorityIndexSnapshotConfig,
} from '../src/authority-index-snapshot-service.js';

const FIRST = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const SECOND = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const UNTRUSTED = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const address = (peer: string) => `/ip4/127.0.0.1/tcp/9200/p2p/${peer}`;
const request = {
  scope: 'base:84532:0x123456',
  deploymentBlockNumber: 100,
  minThroughBlockNumber: 500,
  maxThroughBlockNumber: 2_500,
};
const snapshot = {
  version: 1,
  scope: request.scope,
  checkpoint: {
    version: 2,
    integrity: `0x${'11'.repeat(32)}`,
    cursor: {
      deploymentBlockNumber: 100,
      throughBlockNumber: 1_000,
      throughBlockHash: `0x${'22'.repeat(32)}`,
    },
    states: [],
  },
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value));
const response = (value: unknown = snapshot) => encode({ version: 1, status: 'ok', snapshot: value });
const config = { trustedCorePeers: [address(FIRST), address(SECOND)] };

afterEach(() => vi.useRealTimers());

describe('explicit authority-index snapshot trust', () => {
  it('pins the final destination in relayed multiaddrs, never the relay identity', () => {
    const routed = `${address(UNTRUSTED)}/p2p-circuit/p2p/${FIRST}`;
    const normalized = normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [routed] });
    expect(normalized.trustedCorePeers).toEqual([{ peerId: FIRST, multiaddr: routed }]);
    expect(normalized.maxTailBlocks).toBe(2_000);
  });

  it.each([
    `/p2p/${FIRST}`,
    '/ip4/127.0.0.1/tcp/9200',
    `${address(FIRST)}/p2p/${SECOND}`,
    `${address(FIRST)}/p2p-circuit`,
    `${address(FIRST)}/p2p-circuit/p2p/${SECOND}/p2p/${UNTRUSTED}`,
    `${address(FIRST)}/p2p-circuit/p2p/${SECOND}/p2p-circuit/p2p/${UNTRUSTED}`,
    `${address(FIRST)}/tcp/9201`,
    '/ip4/127.0.0.1/tcp/9200/p2p/invalid-peer-id',
  ])('rejects missing or ambiguous destination: %s', (multiaddr) => {
    expect(() => normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [multiaddr] })).toThrow();
  });

  it('rejects duplicate identities including alternate CID encodings', () => {
    const same = peerIdFromString(FIRST).toCID().toString();
    expect(() => normalizeAuthorityIndexSnapshotConfig({
      trustedCorePeers: [address(FIRST), address(same)],
    })).toThrow(/duplicate/);
  });

  it('bounds peer count and the maximum local tail', () => {
    expect(() => normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: Array(9).fill(address(FIRST)) })).toThrow(/at most 8/);
    expect(() => normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [] })).toThrow(/at least 1/);
    for (const maxTailBlocks of [0, 49, 10_001, Infinity, 50.5, null as unknown as number]) {
      expect(() => normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [address(FIRST)], maxTailBlocks })).toThrow(/maxTailBlocks/);
    }
    for (const maxTailBlocks of [50, 2_000, 10_000]) {
      expect(normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [address(FIRST)], maxTailBlocks }).maxTailBlocks).toBe(maxTailBlocks);
    }
  });

  it('freezes the trust set and sends only to configured authenticated destinations', async () => {
    const trustedCorePeers = [address(FIRST)];
    const send = vi.fn().mockResolvedValue(response());
    const client = createAuthorityIndexSnapshotClient({ config: { trustedCorePeers }, request: send });
    trustedCorePeers[0] = address(UNTRUSTED);
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toEqual({ peerId: FIRST, multiaddr: address(FIRST) });
    expect(send.mock.calls[0][2]).toMatchObject({
      maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
      payloadReuse: 'single-use',
      timeoutMs: 10_000,
    });
  });
});

describe('bounded snapshot client failover', () => {
  it.each([
    ['wrong scope', response({ ...snapshot, scope: 'other-deployment' })],
    ['wrong version', encode({ version: 2, status: 'ok', snapshot })],
    ['claimed responder identity', encode({ version: 1, status: 'ok', peerId: UNTRUSTED, snapshot })],
    ['malformed JSON', new TextEncoder().encode('{')],
    ['not ready', encode({ version: 1, status: 'not-ready' })],
    ['stale checkpoint', response({ ...snapshot, checkpoint: { ...snapshot.checkpoint, cursor: { ...snapshot.checkpoint.cursor, throughBlockNumber: 499 } } })],
    ['future checkpoint', response({ ...snapshot, checkpoint: { ...snapshot.checkpoint, cursor: { ...snapshot.checkpoint.cursor, throughBlockNumber: 2_501 } } })],
    ['wrong deployment', response({ ...snapshot, checkpoint: { ...snapshot.checkpoint, cursor: { ...snapshot.checkpoint.cursor, deploymentBlockNumber: 99 } } })],
  ])('tries the next pinned core after %s', async (_label, invalid) => {
    const send = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(response());
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    expect(send.mock.calls.map(([peer]) => peer.peerId)).toEqual([FIRST, SECOND]);
  });

  it('bounds bytes before JSON parsing and fails over after an oversized response', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(new Uint8Array(AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES + 1))
      .mockResolvedValueOnce(response());
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    const validate = vi.fn().mockResolvedValue(undefined);
    await expect(client.fetchSnapshot(request, undefined, validate)).resolves.toEqual(snapshot);
    expect(validate).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('awaits canonical chain admission per peer and retries corrupt or wrong-anchor seeds', async () => {
    const send = vi.fn().mockResolvedValue(response());
    const validate = vi.fn()
      .mockRejectedValueOnce(new Error('Checkpoint integrity or canonical anchor mismatch'))
      .mockResolvedValueOnce(undefined);
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    await expect(client.fetchSnapshot(request, undefined, validate)).resolves.toEqual(snapshot);
    expect(send).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('times out a stalled core without parallel fanout, aborts it, then tries the next', async () => {
    vi.useFakeTimers();
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(response());
    const client = createAuthorityIndexSnapshotClient({ config, request: send, timeoutMs: 100 });
    const result = client.fetchSnapshot(request);
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual(snapshot);
    expect(send.mock.calls[0][2].signal.aborted).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the candidate deadline to canonical validation and aborts that RPC before failover', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(response());
    let firstValidationSignal: AbortSignal | undefined;
    const validate = vi.fn()
      .mockImplementationOnce((_snapshot: unknown, signal: AbortSignal) => {
        firstValidationSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      })
      .mockResolvedValueOnce(undefined);
    const client = createAuthorityIndexSnapshotClient({ config, request: send, timeoutMs: 100 });
    const result = client.fetchSnapshot(request, undefined, validate);
    await vi.advanceTimersByTimeAsync(0);
    expect(validate).toHaveBeenCalledOnce();
    expect(firstValidationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual(snapshot);
    expect(firstValidationSignal?.aborted).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates cancellation without trying more cores', async () => {
    const controller = new AbortController();
    const send = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    const result = client.fetchSnapshot(request, controller.signal);
    controller.abort(new Error('node stopped'));
    await expect(result).rejects.toThrow('node stopped');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][2].signal.aborted).toBe(true);
  });

  it('never uses untrusted discovery peers or unbounded retries when configured peers fail', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection refused'));
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    await expect(client.fetchSnapshot(request)).rejects.toThrow('No configured trusted core');
    expect(send.mock.calls.map(([peer]) => peer.peerId)).toEqual([FIRST, SECOND]);
    expect(() => createAuthorityIndexSnapshotClient({ config: { trustedCorePeers: [] }, request: send })).toThrow(/at least 1/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects caller scope/bounds errors before transport', async () => {
    const send = vi.fn();
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    for (const invalid of [
      { ...request, scope: '' },
      { ...request, scope: 'a\nsecret' },
      { ...request, deploymentBlockNumber: -1 },
      { ...request, minThroughBlockNumber: 99 },
      { ...request, maxThroughBlockNumber: 499 },
      { ...request, maxThroughBlockNumber: 2_501 },
      { ...request, maxThroughBlockNumber: Infinity },
    ]) await expect(client.fetchSnapshot(invalid)).rejects.toThrow(/request/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('cache-only snapshot serving', () => {
  it('exports the cached checkpoint without invoking refresh or scanning', async () => {
    const capabilities = { exportSnapshot: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() };
    const handler = createAuthorityIndexSnapshotHandler(capabilities);
    expect(decode(await handler(encode({ version: 1, request })))).toEqual({ version: 1, status: 'ok', snapshot });
    expect(capabilities.exportSnapshot).toHaveBeenCalledExactlyOnceWith(request);
    expect(capabilities.refresh).not.toHaveBeenCalled();
  });

  it('reports a cold core as not-ready without starting catchup', async () => {
    const exportSnapshot = vi.fn().mockResolvedValue(null);
    const handler = createAuthorityIndexSnapshotHandler({ exportSnapshot });
    expect(decode(await handler(encode({ version: 1, request })))).toEqual({ version: 1, status: 'not-ready' });
  });

  it('rejects oversized or malformed requests before cache I/O', async () => {
    const exportSnapshot = vi.fn();
    const handler = createAuthorityIndexSnapshotHandler({ exportSnapshot });
    for (const invalid of [
      new Uint8Array(AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES + 1),
      encode({ version: 2, request }),
      encode({ version: 1, request: { ...request, maxThroughBlockNumber: null } }),
      encode({ version: 1, request: { ...request, maxThroughBlockNumber: 20_000 } }),
      encode({ version: 1, request, refresh: true }),
    ]) expect(decode(await handler(invalid))).toEqual({ version: 1, status: 'invalid-request' });
    expect(exportSnapshot).not.toHaveBeenCalled();
  });

  it('refuses invalid scope or excessive cache payloads without sending the checkpoint', async () => {
    const invalid = createAuthorityIndexSnapshotHandler({ exportSnapshot: async () => ({ ...snapshot, scope: 'other' }) });
    expect(decode(await invalid(encode({ version: 1, request })))).toEqual({ version: 1, status: 'unavailable' });
    const large = createAuthorityIndexSnapshotHandler({
      exportSnapshot: async () => ({
        ...snapshot,
        checkpoint: { ...snapshot.checkpoint, states: ['x'.repeat(AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES)] },
      }),
    });
    expect(decode(await large(encode({ version: 1, request })))).toEqual({ version: 1, status: 'too-large' });
  });

  it('caps concurrent cache exports and releases capacity after completion', async () => {
    let release!: (value: null) => void;
    const pending = new Promise<null>((resolve) => { release = resolve; });
    const exportSnapshot = vi.fn(() => pending);
    const handler = createAuthorityIndexSnapshotHandler({ exportSnapshot });
    const bytes = encode({ version: 1, request });
    const active = Array.from({ length: 4 }, () => handler(bytes));
    expect(decode(await handler(bytes))).toEqual({ version: 1, status: 'busy' });
    expect(exportSnapshot).toHaveBeenCalledTimes(4);
    release(null);
    await Promise.all(active);
    expect(decode(await handler(bytes))).toEqual({ version: 1, status: 'not-ready' });
    expect(exportSnapshot).toHaveBeenCalledTimes(5);
  });
});
