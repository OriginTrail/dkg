import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, exchangeExperimentalExactBatch: vi.fn() };
});

vi.mock('../src/sync/requester/durable-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/durable-sync.js')>();
  return { ...actual, runDurableSyncDetailed: vi.fn(), runChallengeExactAssetFetch: vi.fn() };
});

import {
  ExperimentalExactBatchUnsupportedError,
  exchangeExperimentalExactBatch
} from '@origintrail-official/dkg-core';
import { quadToNQuad } from '@origintrail-official/dkg-storage';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { exactBatchStreamUnsupported } from '../src/sync/exact-batch-stream-capability.js';
import { EXACT_BATCH_STREAM_PROTOCOL, EXACT_BATCH_FRAME_KIND as K, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';
import { runChallengeExactAssetFetch, runDurableSyncDetailed } from '../src/sync/requester/durable-sync.js';
import { EXACT_BATCH_STREAM_BUSY_RETRY, EXACT_BATCH_STREAM_RETRY } from '../src/sync/requester/exact-batch-stream-driver.js';

import { CG, busyRefusal, createExactBatchHostFixture, emptyResult, resourceLimitRefusal, storedRows } from './_helpers/exact-batch-host.js';
const cleanups: Array<() => Promise<void>> = [];
const fixture = (assetCount = 2) => createExactBatchHostFixture(cleanups, assetCount);

/** What each exchange of the run asked the transport for. */
function requestedExchanges(f: ReturnType<typeof fixture>) {
  return vi.mocked(exchangeExperimentalExactBatch).mock.calls.map(([, peer, start, transport]) => ({
    peer, assetUals: transport.assetUals,
    start: ContextGraphResolveMethods.prototype.parseSyncRequest.call(f.host, start.payload).assetUals,
  }));
}

function requesterLogs(f: ReturnType<typeof fixture>, kind: 'failure' | 'retry' | 'refusal') {
  return f.host.log.info.mock.calls.map(([, message]: [unknown, string]) => message)
    .filter((message: string) => message.startsWith(`Exact batch requester ${kind} `));
}

type StreamBreak = 'read-rejects' | 'ends-early' | 'ack-rejects';

/**
 * Script the next exchanges, one entry each. An exchange serves the fixture
 * items it names, in window order, and then either completes the batch,
 * breaks once the requester has acknowledged `afterAcks` assets, or (`busy`)
 * answers with a BUSY refusal.
 */
function scriptExchanges(f: ReturnType<typeof fixture>, scripts: ReadonlyArray<{
  readonly items: readonly number[];
  readonly ending: 'complete' | 'busy' | StreamBreak;
  readonly afterAcks?: number;
  /** Runs at the moment of the break, before the stream reports it. */
  readonly atBreak?: () => void;
}>) {
  for (const script of scripts) {
    vi.mocked(exchangeExperimentalExactBatch).mockImplementationOnce(async (_router, _peer, _start, options, consume) => {
      const frames: ExactBatchFrame[] = script.items.flatMap((itemIndex, assetIndex) => {
        const item = f.items[itemIndex]!;
        return [
          { kind: K.META, assetIndex, sequence: 0, payload: new TextEncoder().encode(item.meta.map(quadToNQuad).join('\n') + '\n') },
          { kind: K.DATA, assetIndex, sequence: 0, payload: new TextEncoder().encode(item.data.map(quadToNQuad).join('\n') + '\n') },
          { kind: K.ASSET_END, assetIndex, sequence: 1, payload: new Uint8Array() },
        ];
      });
      if (script.ending === 'complete') {
        frames.push({ kind: K.BATCH_END, assetIndex: 255, sequence: script.items.length, payload: new Uint8Array() });
      }
      const breakAfterAcks = script.afterAcks ?? 0;
      let acks = 0;
      const ackWaiters: Array<() => void> = [];
      const acked = async (count: number) => {
        while (acks < count) await new Promise<void>(resolve => { ackWaiters.push(resolve); });
      };
      return consume({
        signal: f.controller.signal, assetUals: options.assetUals, windowSize: 2,
        next: async () => {
          const next = frames[0];
          if (next !== undefined) {
            // A responder keeps at most two assets unacknowledged.
            if (next.kind === K.META && next.assetIndex >= 2) await acked(next.assetIndex - 1);
            return frames.shift();
          }
          if (script.ending === 'complete') return undefined;
          await acked(breakAfterAcks);
          script.atBreak?.();
          if (script.ending === 'busy') return busyRefusal();
          if (script.ending === 'read-rejects') throw new Error('Fixture stream reset');
          if (script.ending === 'ends-early') return undefined;
          return new Promise<never>(() => {}); // the ACK is what fails
        },
        send: async () => {
          if (script.ending === 'ack-rejects' && acks >= breakAfterAcks) throw new Error('Fixture stream closed under the ACK');
          acks += 1;
          for (const wake of ackWaiters.splice(0)) wake();
        },
      } as never);
    });
  }
}

/** The peer cannot be reached: its reconnection never settles, whatever happens to the signal it was given. */
function unreachablePeer(f: ReturnType<typeof fixture>) {
  let start!: (signal: AbortSignal) => void;
  const reconnecting = new Promise<AbortSignal>(resolve => { start = resolve; });
  f.host.ensurePeerConnected.mockImplementation((_peer: string, options: { signal: AbortSignal }) => {
    start(options.signal);
    return new Promise<void>(() => {});
  });
  return { reconnecting };
}

/** Freeze the clock the driver reads; it moves only when the test advances the timers. */
async function withDriverClock(test: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try { await test(); } finally { vi.useRealTimers(); }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  vi.mocked(runDurableSyncDetailed).mockResolvedValue({ result: emptyResult(), exactFetchDisposition: 'incomplete' });
  vi.mocked(runChallengeExactAssetFetch).mockResolvedValue({ result: emptyResult(), disposition: 'incomplete', authenticatedAssets: [] });
});

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // A scripted exchange a test did not consume must not serve the next test.
  vi.mocked(exchangeExperimentalExactBatch).mockReset();
});

describe('experimental exact batch same-peer stream retry', () => {
  describe('a stream that breaks', () => {
    it.each([
      ['a read that rejects', 'read-rejects', 1],
      ['an end before the batch is complete', 'ends-early', 1],
      // The second asset is stored, then its ACK cannot be sent.
      ['an ACK that cannot be sent', 'ack-rejects', 2],
    ] as const)('is opened once more with the same peer for the assets not yet applied, after %s', async (_case, ending, applied) => {
      const f = fixture(3);
      scriptExchanges(f, [
        { items: ending === 'ack-rejects' ? [0, 1] : [0], ending, afterAcks: 1 },
        { items: [0, 1, 2].slice(applied), ending: 'complete' },
      ]);
      const outcome = await f.run(f.selection, 'stream-required');
      expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: f.selection.assetUals,
        result: { complete: true, completedPhases: 1, failedPhases: 0, insertedDataTriples: 3 } });
      for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
      // Same peer both times; the second START names only what was still missing.
      expect(requestedExchanges(f)).toEqual([
        { peer: 'fixture-source', assetUals: f.selection.assetUals, start: f.selection.assetUals },
        { peer: 'fixture-source', assetUals: f.selection.assetUals.slice(applied), start: f.selection.assetUals.slice(applied) },
      ]);
      expect(f.host.ensurePeerConnected).toHaveBeenCalledOnce();
      expect(f.host.ensurePeerConnected.mock.calls[0]![0]).toBe('fixture-source');
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
      expect(requesterLogs(f, 'failure')).toEqual([
        expect.stringMatching(new RegExp(`^Exact batch requester failure assetCount=3 committedAssets=${applied} origin=stream `)),
      ]);
      expect(requesterLogs(f, 'retry')).toEqual([
        expect.stringMatching(new RegExp(`^Exact batch requester retry reason=stream-interrupted committedAssets=${applied} outstandingAssets=${3 - applied} reconnectMs=\\d+$`)),
      ]);
      expect(f.host.graphScopedStorePhysicalRuns.size).toBe(0);
    });

    it('is opened again for the whole selection when it broke before applying anything', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [0, 1], ending: 'complete' },
      ]);
      const outcome = await f.run(f.selection, 'stream-required');
      expect(outcome).toMatchObject({ exactFetchDisposition: 'found', committedExactAssetUals: f.selection.assetUals,
        result: { complete: true, insertedDataTriples: 2 } });
      expect(vi.mocked(exchangeExperimentalExactBatch).mock.calls.map(([, , , transport]) => transport.assetUals))
        .toEqual([f.selection.assetUals, f.selection.assetUals]);
    });

    it('is opened again at most once, and keeps what both exchanges applied', async () => {
      const f = fixture(3);
      scriptExchanges(f, [
        { items: [0], ending: 'read-rejects', afterAcks: 1 },
        { items: [1], ending: 'read-rejects', afterAcks: 1 },
        { items: [2], ending: 'complete' },
      ]);
      const outcome = await f.run(f.selection, 'stream-required');
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete',
        committedExactAssetUals: f.selection.assetUals.slice(0, 2),
        result: { complete: false, completedPhases: 0, failedPhases: 1, insertedDataTriples: 2 } });
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(2);
      expect(await storedRows(f.store, f.items[2]!.graph)).toBe(0);
      expect(requesterLogs(f, 'retry')).toHaveLength(1);
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    });

    it('asks once per poll while the peer is not connected, and settles incomplete when the reconnection window closes', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [0, 1], ending: 'complete' },
      ]);
      // Reachable, but not connected: every attempt answers at once.
      f.host.node.libp2p.getConnections.mockReturnValue([]);
      let asked!: () => void;
      const firstAttempt = new Promise<void>(resolve => { asked = resolve; });
      f.host.ensurePeerConnected.mockImplementation(async () => { asked(); });
      const { reconnectWindowMs, reconnectPollMs } = EXACT_BATCH_STREAM_RETRY;
      await withDriverClock(async () => {
        let settled = false;
        const outcome = f.run(f.selection, 'stream-required').finally(() => { settled = true; });
        await firstAttempt;
        await vi.advanceTimersByTimeAsync(reconnectPollMs - 1);
        expect(f.host.ensurePeerConnected).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.host.ensurePeerConnected).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(reconnectWindowMs - reconnectPollMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [],
          result: { complete: false, failedPhases: 1 } });
      });
      expect(f.host.ensurePeerConnected).toHaveBeenCalledTimes(reconnectWindowMs / reconnectPollMs);
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it.each([
      ['the reconnection window closes', undefined, EXACT_BATCH_STREAM_RETRY.reconnectWindowMs],
      // Eight seconds of fetch time are left, and five of them are kept for the second exchange.
      ['only the time kept for a second exchange is left of the fetch', 8_000, 8_000 - EXACT_BATCH_STREAM_RETRY.minRemainingMs],
    ] as const)('cancels a reconnection that does not settle when %s, and settles incomplete', async (_case, fetchTimeLeftMs, waitMs) => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [0, 1], ending: 'complete' },
      ]);
      const { reconnecting } = unreachablePeer(f);
      await withDriverClock(async () => {
        let settled = false;
        const outcome = f.run(f.selection, 'stream-required',
          fetchTimeLeftMs === undefined ? {} : { operationFetchDeadline: Date.now() + fetchTimeLeftMs })
          .finally(() => { settled = true; });
        const reconnectSignal = await reconnecting;
        await vi.advanceTimersByTimeAsync(waitMs - 1);
        expect(reconnectSignal.aborted).toBe(false);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(reconnectSignal.aborted).toBe(true);
        expect(await outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [],
          result: { complete: false, failedPhases: 1 } });
      });
      expect(f.host.ensurePeerConnected).toHaveBeenCalledOnce();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it('does not wait for the peer when no more fetch time is left than a second exchange needs', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [0, 1], ending: 'complete' },
      ]);
      await withDriverClock(async () => {
        const outcome = await f.run(f.selection, 'stream-required',
          { operationFetchDeadline: Date.now() + EXACT_BATCH_STREAM_RETRY.minRemainingMs });
        expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [] });
      });
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
    });

    it('cancels the reconnection at once when the fetch itself is cancelled', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [0, 1], ending: 'complete' },
      ]);
      const { reconnecting } = unreachablePeer(f);
      const owner = new AbortController();
      const outcome = f.run(f.selection, 'stream-required', { signal: owner.signal })
        .then(() => 'settled', () => 'rejected');
      const reconnectSignal = await reconnecting;
      expect(reconnectSignal.aborted).toBe(false);
      owner.abort(new Error('Fixture cancellation'));
      expect(reconnectSignal.aborted).toBe(true);
      // Real timers: this resolves long before the reconnection window could close.
      await outcome;
      expect(f.host.ensurePeerConnected).toHaveBeenCalledOnce();
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it('is not opened again when a cancellation is what broke it', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        // The read fails because its owner cancelled the exchange, and that
        // read is the first thing to fail: nothing else has noticed yet.
        { items: [], ending: 'read-rejects', atBreak: () => f.controller.abort(new Error('Fixture cancellation')) },
        { items: [0, 1], ending: 'complete' },
      ]);
      const outcome = await f.run(f.selection, 'stream-required');
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [] });
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
    });

    describe('and cannot be opened again keeps what it applied, and the ordinary wire does not take the selection over', () => {
      const appliedOneAssetThenBroke = (f: ReturnType<typeof fixture>) => scriptExchanges(f, [
        { items: [0], ending: 'read-rejects', afterAcks: 1 },
      ]);
      const expectAppliedPrefixOnly = async (f: ReturnType<typeof fixture>, outcome: Awaited<ReturnType<typeof f.run>>) => {
        expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [f.items[0]!.ual],
          result: { complete: false, completedPhases: 0, failedPhases: 1, insertedDataTriples: 1 } });
        expect(await storedRows(f.store, f.items[0]!.graph)).toBe(1);
        expect(await storedRows(f.store, f.items[1]!.graph)).toBe(0);
        expect(runDurableSyncDetailed).not.toHaveBeenCalled();
      };

      it('when the peer answers the second START as unsupported', async () => {
        const f = fixture(2);
        appliedOneAssetThenBroke(f);
        vi.mocked(exchangeExperimentalExactBatch).mockRejectedValueOnce(
          new ExperimentalExactBatchUnsupportedError(new Error('Fixture unsupported negotiation after the break')));
        // A stream-preferred fetch may use the ordinary wire, but only before its first START.
        await expectAppliedPrefixOnly(f, await f.run(f.selection, 'stream-preferred'));
        expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(2);
      });

      it.each([
        ['stream-preferred', 'the peer no longer advertises the stream'],
        ['stream-preferred', 'the graph is no longer registered as public'],
        ['stream-required', 'the peer no longer advertises the stream'],
        ['stream-required', 'the graph is no longer registered as public'],
      ] as const)('in a %s fetch when, after the break, %s', async (mode, change) => {
        const f = fixture(2);
        appliedOneAssetThenBroke(f);
        if (change === 'the peer no longer advertises the stream') {
          f.host.getPeerProtocols.mockResolvedValueOnce([EXACT_BATCH_STREAM_PROTOCOL]).mockResolvedValueOnce([]);
        } else {
          f.host.resolveRegisteredContextGraphAuthority
            .mockResolvedValueOnce({ kind: 'public', onChainId: '14' })
            .mockResolvedValueOnce({ kind: 'private', onChainId: '14' });
        }
        await expectAppliedPrefixOnly(f, await f.run(f.selection, mode));
        expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
        expect(f.host.ensurePeerConnected).toHaveBeenCalledOnce();
      });
    });
  });

  describe('a responder that answers BUSY', () => {
    const [firstBackoffMs, secondBackoffMs, thirdBackoffMs] = EXACT_BATCH_STREAM_BUSY_RETRY.backoffMs;
    /**
     * Resolves once `count` exchanges were refused as busy. The driver logs the
     * refusal in the same synchronous run that starts its pause, so the pause
     * is running by then. Real event-loop turns: the driver clock stays put.
     */
    const untilBusyAnswers = async (f: ReturnType<typeof fixture>, count: number) => {
      // Bounded by the wall clock, which the driver clock does not fake: an
      // exchange that first applies an asset waits on the real verify worker.
      const startedAt = performance.now();
      while (requesterLogs(f, 'refusal').length < count && performance.now() - startedAt < 30_000) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(requesterLogs(f, 'refusal')).toHaveLength(count);
    };

    it('is asked again after the backoff, on the stream and with no other peer or wire', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'busy' },
        { items: [0, 1], ending: 'complete' },
      ]);
      await withDriverClock(async () => {
        let settled = false;
        const outcome = f.run(f.selection, 'stream-required').finally(() => { settled = true; });
        await untilBusyAnswers(f, 1);
        await vi.advanceTimersByTimeAsync(firstBackoffMs - 1);
        expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({ exactFetchDisposition: 'found', exactStreamOutcome: 'complete',
          committedExactAssetUals: f.selection.assetUals,
          result: { complete: true, completedPhases: 1, failedPhases: 0, insertedDataTriples: 2 } });
      });
      // Same peer and the same selection both times: BUSY applied nothing.
      expect(requestedExchanges(f)).toEqual([
        { peer: 'fixture-source', assetUals: f.selection.assetUals, start: f.selection.assetUals },
        { peer: 'fixture-source', assetUals: f.selection.assetUals, start: f.selection.assetUals },
      ]);
      for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(1);
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
      // A busy peer answered over a live connection: there is nothing to reconnect.
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
      expect(requesterLogs(f, 'refusal')).toEqual([
        'Exact batch requester refusal code=BUSY startedAssets=0 committedAssets=0 acknowledgedAssets=0 atAssetBoundary=1 verifiedPrefix=0',
      ]);
      expect(requesterLogs(f, 'failure')).toEqual([
        expect.stringMatching(/^Exact batch requester failure assetCount=2 committedAssets=0 origin=refusal /),
      ]);
      expect(requesterLogs(f, 'retry')).toEqual([
        `Exact batch requester retry reason=responder-busy committedAssets=0 outstandingAssets=2 backoffMs=${firstBackoffMs}`,
      ]);
      // BUSY is not a capability verdict: the stream stays selectable for this peer.
      expect(exactBatchStreamUnsupported(f.host, 'fixture-source', 'fixture-connection', Date.now(),
        f.host.captureExperimentalExactBatchRefusalScope(CG))).toBe(false);
    });

    it('waits longer before each further exchange, then settles incomplete and names the busy peer', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        ...EXACT_BATCH_STREAM_BUSY_RETRY.backoffMs.map(() => ({ items: [], ending: 'busy' as const })),
        { items: [], ending: 'busy' },
        // Never opened: the retries are used up.
        { items: [0, 1], ending: 'complete' },
      ]);
      await withDriverClock(async () => {
        const outcome = f.run(f.selection, 'stream-required');
        for (const [index, backoffMs] of [firstBackoffMs, secondBackoffMs, thirdBackoffMs].entries()) {
          await untilBusyAnswers(f, index + 1);
          await vi.advanceTimersByTimeAsync(backoffMs - 1);
          expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(index + 1);
          await vi.advanceTimersByTimeAsync(1);
        }
        expect(await outcome).toMatchObject({ exactFetchDisposition: 'incomplete', exactStreamOutcome: 'responder-busy',
          committedExactAssetUals: [], result: { complete: false, failedPhases: 1, insertedTriples: 0 } });
      });
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledTimes(EXACT_BATCH_STREAM_BUSY_RETRY.backoffMs.length + 1);
      expect(requesterLogs(f, 'retry')).toEqual([firstBackoffMs, secondBackoffMs, thirdBackoffMs].map(backoffMs =>
        `Exact batch requester retry reason=responder-busy committedAssets=0 outstandingAssets=2 backoffMs=${backoffMs}`));
      expect([firstBackoffMs < secondBackoffMs, secondBackoffMs < thirdBackoffMs]).toEqual([true, true]);
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    });

    it('is not waited for when the pause would leave less fetch time than another exchange needs', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'busy' },
        { items: [0, 1], ending: 'complete' },
      ]);
      await withDriverClock(async () => {
        // One millisecond short of the pause plus the time kept for an exchange.
        const outcome = await f.run(f.selection, 'stream-required',
          { operationFetchDeadline: Date.now() + firstBackoffMs + EXACT_BATCH_STREAM_RETRY.minRemainingMs - 1 });
        expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', exactStreamOutcome: 'responder-busy',
          committedExactAssetUals: [] });
      });
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it('stops being waited for at once when the fetch is cancelled, and settles as a cancellation', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'busy' },
        { items: [0, 1], ending: 'complete' },
      ]);
      const owner = new AbortController();
      const outcome = f.run(f.selection, 'stream-required', { signal: owner.signal });
      await untilBusyAnswers(f, 1);
      owner.abort(new Error('Fixture cancellation'));
      // Real timers: this settles long before the first pause could end.
      const settled = await outcome;
      expect(settled).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [] });
      expect(settled).not.toHaveProperty('exactStreamOutcome');
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it('keeps what an earlier exchange applied and asks only for the rest, after a break and after BUSY', async () => {
      const f = fixture(3);
      scriptExchanges(f, [
        { items: [0], ending: 'read-rejects', afterAcks: 1 },
        { items: [], ending: 'busy' },
        { items: [1, 2], ending: 'complete' },
      ]);
      await withDriverClock(async () => {
        const outcome = f.run(f.selection, 'stream-required');
        await untilBusyAnswers(f, 1);
        await vi.advanceTimersByTimeAsync(firstBackoffMs);
        expect(await outcome).toMatchObject({ exactFetchDisposition: 'found', exactStreamOutcome: 'complete',
          committedExactAssetUals: f.selection.assetUals, result: { complete: true, insertedDataTriples: 3 } });
      });
      const outstanding = f.selection.assetUals.slice(1);
      expect(requestedExchanges(f)).toEqual([
        { peer: 'fixture-source', assetUals: f.selection.assetUals, start: f.selection.assetUals },
        { peer: 'fixture-source', assetUals: outstanding, start: outstanding },
        { peer: 'fixture-source', assetUals: outstanding, start: outstanding },
      ]);
      expect(requesterLogs(f, 'retry')).toEqual([
        expect.stringMatching(/^Exact batch requester retry reason=stream-interrupted committedAssets=1 outstandingAssets=2 reconnectMs=\d+$/),
        `Exact batch requester retry reason=responder-busy committedAssets=1 outstandingAssets=2 backoffMs=${firstBackoffMs}`,
      ]);
      expect(runDurableSyncDetailed).not.toHaveBeenCalled();
    });
  });

  describe('the outcome names a setback only when the stop says nothing about the peer\'s data', () => {
    it('names the interruption when the stream broke again after its one retry', async () => {
      const f = fixture(2);
      scriptExchanges(f, [
        { items: [], ending: 'read-rejects' },
        { items: [], ending: 'read-rejects' },
      ]);
      expect(await f.run(f.selection, 'stream-required')).toMatchObject({
        exactFetchDisposition: 'incomplete', exactStreamOutcome: 'stream-interrupted', committedExactAssetUals: [] });
    });

    it('names nothing for another refusal, for an asset this node cannot authenticate, or once everything was applied', async () => {
      const refused = fixture();
      refused.frames.splice(0, refused.frames.length, resourceLimitRefusal());
      expect(await refused.run(refused.selection, 'stream-required')).not.toHaveProperty('exactStreamOutcome');

      const rejected = fixture();
      rejected.host.chain.getKAContextGraphId.mockImplementation(async (id: bigint) => id === rejected.items[1]!.kaId ? 15n : 14n);
      const partial = await rejected.run();
      expect(partial).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [rejected.items[0]!.ual] });
      expect(partial).not.toHaveProperty('exactStreamOutcome');

      // Every asset was applied and acknowledged before the stream broke: nothing is left to come back for.
      const applied = fixture(1);
      scriptExchanges(applied, [{ items: [0], ending: 'read-rejects', afterAcks: 1 }]);
      const settled = await applied.run(applied.selection, 'stream-required');
      expect(settled).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: applied.selection.assetUals });
      expect(settled).not.toHaveProperty('exactStreamOutcome');
      expect(applied.host.ensurePeerConnected).not.toHaveBeenCalled();
    });
  });

  describe('a stream that stops for another reason is not opened again', () => {
    it('when this node cannot authenticate an asset, and the log line says where it stopped', async () => {
      const f = fixture();
      f.host.chain.getKAContextGraphId.mockImplementation(async (id: bigint) => id === f.items[1]!.kaId ? 15n : 14n);
      const outcome = await f.run();
      expect(outcome).toMatchObject({ exactFetchDisposition: 'incomplete', committedExactAssetUals: [f.items[0]!.ual] });
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
      // The second asset passed verification and failed in the store step.
      expect(requesterLogs(f, 'failure')).toEqual([
        expect.stringMatching(/^Exact batch requester failure assetCount=2 committedAssets=1 origin=other lastStage=verify@1 error=\w+ code=\S+ detail=".+"$/),
      ]);
      expect(requesterLogs(f, 'retry')).toEqual([]);
    });

    it('when the responder refuses', async () => {
      const f = fixture();
      f.frames.splice(0, f.frames.length, resourceLimitRefusal());
      await f.run(f.selection, 'stream-required');
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
      expect(requesterLogs(f, 'failure')).toEqual([
        expect.stringMatching(/^Exact batch requester failure assetCount=2 committedAssets=0 origin=refusal /),
      ]);
    });

    it('when the responder sends a frame the receive window refuses', async () => {
      const f = fixture();
      // DATA for an asset whose META never arrived.
      f.frames.splice(0, f.frames.length, f.frames[1]!);
      await f.run(f.selection, 'stream-required');
      expect(exchangeExperimentalExactBatch).toHaveBeenCalledOnce();
      expect(f.host.ensurePeerConnected).not.toHaveBeenCalled();
      expect(requesterLogs(f, 'failure')).toEqual([
        expect.stringMatching(/^Exact batch requester failure assetCount=2 committedAssets=0 origin=other /),
      ]);
    });
  });

});
