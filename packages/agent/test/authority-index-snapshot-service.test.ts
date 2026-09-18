import { afterEach, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { ContextGraphAuthorityIndexSnapshotExportError } from '@origintrail-official/dkg-chain';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  AuthorityIndexSnapshotUnavailableError,
  AuthorityIndexSnapshotPeerStatusError,
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
    for (const maxTailBlocks of [0, 49, 50, 199, 10_001, Infinity, 200.5, null as unknown as number]) {
      expect(() => normalizeAuthorityIndexSnapshotConfig({ trustedCorePeers: [address(FIRST)], maxTailBlocks })).toThrow(/maxTailBlocks/);
    }
    for (const maxTailBlocks of [200, 2_000, 10_000]) {
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

  it('bounds the complete peer walk and aborts a later candidate before any further peer', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = createAuthorityIndexSnapshotClient({
      config: { trustedCorePeers: [address(FIRST), address(SECOND), address(UNTRUSTED)] },
      request: send, timeoutMs: 100, overallTimeoutMs: 150,
    });
    const result = client.fetchSnapshot(request);
    const rejected = expect(result).rejects.toBeInstanceOf(AuthorityIndexSnapshotUnavailableError);
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls.map(([peer]) => peer.peerId)).toEqual([FIRST, SECOND]);
    expect(send.mock.calls[1][2].timeoutMs).toBe(50);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps later canonical validation inside the total deadline', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(response());
    const signals: AbortSignal[] = [];
    const validate = vi.fn().mockImplementation((_value: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    });
    const client = createAuthorityIndexSnapshotClient({
      config, request: send, timeoutMs: 100, overallTimeoutMs: 150,
    });
    const result = client.fetchSnapshot(request, undefined, validate);
    const rejected = expect(result).rejects.toBeInstanceOf(AuthorityIndexSnapshotUnavailableError);
    await vi.advanceTimersByTimeAsync(100);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(signals[1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves per-peer statuses and causes, and cools down failed scopes before another walk', async () => {
    vi.useFakeTimers();
    const transportFailure = new Error('connection refused');
    const send = vi.fn()
      .mockResolvedValueOnce(encode({ version: 1, status: 'below-range' }))
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValue(response());
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    const failure = await client.fetchSnapshot(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthorityIndexSnapshotUnavailableError);
    expect(failure).toMatchObject({ code: 'AUTHORITY_INDEX_SNAPSHOT_UNAVAILABLE', retryAfterMs: 5_000 });
    const causes = (failure as AggregateError).errors;
    expect(causes[0]).toBeInstanceOf(AuthorityIndexSnapshotPeerStatusError);
    expect(causes[0]).toMatchObject({ peerId: FIRST, status: 'below-range' });
    expect(causes[1]).toBe(transportFailure);
    await vi.advanceTimersByTimeAsync(2_000);
    const cooldown = await client.fetchSnapshot(request).catch((error: unknown) => error);
    expect(cooldown).toMatchObject({ retryAfterMs: 3_000, errors: causes });
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does not turn lifecycle cancellation into a provider cooldown', async () => {
    const controller = new AbortController();
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(response());
    const client = createAuthorityIndexSnapshotClient({ config, request: send });
    const cancelled = client.fetchSnapshot(request, controller.signal);
    controller.abort(new Error('node stopped'));
    await expect(cancelled).rejects.toThrow('node stopped');
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
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

  it.each(['too-large', 'above-range', 'below-range', 'unavailable'] as const)(
    'preserves the chain export diagnostic %s', async (status) => {
      const handler = createAuthorityIndexSnapshotHandler({
        exportSnapshot: async () => { throw new ContextGraphAuthorityIndexSnapshotExportError(status); },
      });
      expect(decode(await handler(encode({ version: 1, request })))).toEqual({ version: 1, status });
    },
  );

  it('limits repeated exports per authenticated peer while allowing another identity', async () => {
    vi.useFakeTimers();
    const exportSnapshot = vi.fn().mockResolvedValue(snapshot);
    const handler = createAuthorityIndexSnapshotHandler({ exportSnapshot });
    const bytes = encode({ version: 1, request });
    for (let i = 0; i < 4; i += 1) {
      expect(decode(await handler(bytes, FIRST)).status).toBe('ok');
    }
    expect(decode(await handler(bytes, FIRST)).status).toBe('busy');
    expect(decode(await handler(bytes, SECOND)).status).toBe('ok');
    expect(exportSnapshot).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(decode(await handler(bytes, FIRST)).status).toBe('ok');
    expect(exportSnapshot).toHaveBeenCalledTimes(6);
  });

  it('bounds limiter identities without evicting an active peer limit', async () => {
    vi.useFakeTimers();
    const exportSnapshot = vi.fn().mockResolvedValue(null);
    const handler = createAuthorityIndexSnapshotHandler({ exportSnapshot });
    const bytes = encode({ version: 1, request });
    for (let i = 0; i < 1_024; i += 1) {
      expect(decode(await handler(bytes, `authenticated-peer-${i}`)).status).toBe('not-ready');
    }
    expect(decode(await handler(bytes, 'new-authenticated-peer')).status).toBe('busy');
    expect(exportSnapshot).toHaveBeenCalledTimes(1_024);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(decode(await handler(bytes, 'new-authenticated-peer')).status).toBe('not-ready');
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
