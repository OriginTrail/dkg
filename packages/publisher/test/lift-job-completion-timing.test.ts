/**
 * GH#3081 — the post-finality timeline in isolation: segment arithmetic per path, the split of the
 * executor's tail at the steps it reports, the log level threshold, the bound, and that a failure
 * to observe never changes what the caller sees.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  LIFT_JOB_POST_FINALITY_INFO_THRESHOLD_MS,
  LiftJobCompletionTiming,
} from '../src/lift-job-completion-timing.js';
import { LIFT_JOB_TAIL_STEPS, type LiftJobTailStep } from '../src/lift-job-tail-steps.js';
import { LiftJobChainObservations } from '../src/lift-job-chain-observations.js';

const TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'cd'.repeat(32)}`;

function harness() {
  const clock = { now: 0 };
  const lines: Array<{ level: 'info' | 'debug'; ctx: OperationContext; message: string }> = [];
  const timing = new LiftJobCompletionTiming({
    clock: () => clock.now,
    log: {
      info: (ctx, message) => { lines.push({ level: 'info', ctx, message }); },
      debug: (ctx, message) => { lines.push({ level: 'debug', ctx, message }); },
    },
  });
  const at = (ms: number) => { clock.now = ms; };
  return { timing, lines, at };
}

function fields(message: string): Record<string, string> {
  const [event, ...pairs] = message.split(' ');
  expect(event).toBe('async_publish_post_finality');
  return Object.fromEntries(pairs.map((pair) => pair.split('=') as [string, string]));
}

const TAIL_STEP_FIELDS = [
  'tailPublishMs', 'tailReceiptWriteMs', 'tailPublishedGraphClearMs', 'tailLegacySwmRetireMs',
  'tailRemainingSwmClearMs', 'tailLifecycleStampMs', 'tailGraphIdReadMs', 'tailFinalizationGossipMs',
  'tailShareMarkerClearMs', 'tailCatalogObserverMs',
] as const;

/** The tail fields of a line whose executor reported no step: all of the tail is the rest. */
function unsplitTail(restMs: string): Record<string, string> {
  return { ...Object.fromEntries(TAIL_STEP_FIELDS.map((name) => [name, '-'])), tailRestMs: restMs };
}

/** The printed parts of the tail, added up. */
function tailParts(parsed: Record<string, string>): number {
  return [...TAIL_STEP_FIELDS, 'tailRestMs']
    .map((name) => parsed[name]!)
    .filter((value) => value !== '-')
    .reduce((sum, value) => sum + Number(value), 0);
}

describe('lift-job completion timing', () => {
  it('splits a detached job into contiguous segments that sum to its total', () => {
    const { timing, lines, at } = harness();
    at(1_000); timing.receipt('job-1', TX);
    at(4_000); timing.finality('job-1');
    at(64_000); timing.executorSettled('job-1');
    at(66_500); timing.recoveryTurn('job-1');
    at(66_600);
    const handler = timing.timeRecovery(async () => { at(170_000); });
    return handler({ job: { jobId: 'job-1', status: 'included' } }).then(() => {
      at(170_250); timing.terminal('job-1');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('info');
      expect(lines[0]!.ctx.sourceOperationId).toBe('job-1');
      expect(lines[0]!.message).toBe(
        'async_publish_post_finality job=job-1 path=detached anchor=finality totalMs=166250 '
        + 'tailMs=60000 recoveryAdmissionMs=2500 recoveryRetryMs=0 proofMs=100 recoveryMs=103400 '
        + 'terminalWriteMs=250 recoveryTurns=1 recoveryAttempts=1 receiptToFinalityMs=3000 '
        + 'tailPublishMs=- tailReceiptWriteMs=- tailPublishedGraphClearMs=- tailLegacySwmRetireMs=- '
        + 'tailRemainingSwmClearMs=- tailLifecycleStampMs=- tailGraphIdReadMs=- tailFinalizationGossipMs=- '
        + 'tailShareMarkerClearMs=- tailCatalogObserverMs=- tailRestMs=60000',
      );
      const parsed = fields(lines[0]!.message);
      const segments = ['tailMs', 'recoveryAdmissionMs', 'recoveryRetryMs', 'proofMs', 'recoveryMs', 'terminalWriteMs'];
      expect(segments.reduce((sum, name) => sum + Number(parsed[name]), 0)).toBe(Number(parsed.totalMs));
    });
  });

  it('splits the tail at the steps the executor reported, in order, and the parts sum to the tail', () => {
    const { timing, lines, at } = harness();
    at(0); timing.receipt('job-1', TX);
    at(1_000); timing.finality('job-1');
    at(1_200); timing.tailStep('job-1', 'publish');
    at(1_250); timing.tailStep('job-1', 'receiptWrite');
    at(1_600); timing.tailStep('job-1', 'publishedGraphClear');
    // The retirement of the legacy copy is where this executor waited.
    at(9_300); timing.tailStep('job-1', 'legacySwmRetire');
    at(9_340); timing.tailStep('job-1', 'lifecycleStamp');
    at(9_400); timing.tailStep('job-1', 'finalizationGossip');
    at(9_420); timing.tailStep('job-1', 'shareMarkerClear');
    at(9_500); timing.tailStep('job-1', 'catalogObserver');
    at(9_510); timing.executorSettled('job-1');
    at(9_600); timing.terminal('job-1');

    const parsed = fields(lines[0]!.message);
    expect(parsed).toMatchObject({
      path: 'detached', anchor: 'finality', totalMs: '8600', tailMs: '8510',
      tailPublishMs: '200', tailReceiptWriteMs: '50', tailPublishedGraphClearMs: '350',
      tailLegacySwmRetireMs: '7700',
      // Not requested, and the graph id was already known: neither step ran.
      tailRemainingSwmClearMs: '-', tailLifecycleStampMs: '40', tailGraphIdReadMs: '-',
      tailFinalizationGossipMs: '60', tailShareMarkerClearMs: '20', tailCatalogObserverMs: '80',
      tailRestMs: '10',
    });
    expect(tailParts(parsed)).toBe(Number(parsed.tailMs));
    // The new fields follow the ones the line already had.
    expect(Object.keys(parsed).slice(-11)).toEqual([...TAIL_STEP_FIELDS, 'tailRestMs']);
  });

  it('names one field for every step, in the order the executor runs them', () => {
    expect(LIFT_JOB_TAIL_STEPS.map((step) => `tail${step[0]!.toUpperCase()}${step.slice(1)}Ms`))
      .toEqual([...TAIL_STEP_FIELDS]);
  });

  it('starts the split at the anchor: a step that ended before it is not part of the tail', () => {
    const { timing, lines, at } = harness();
    at(0); timing.receipt('job-1', TX);
    at(100); timing.tailStep('job-1', 'publish');
    at(150); timing.tailStep('job-1', 'receiptWrite');
    // Finality is observed while the published graph is being cleared.
    at(400); timing.finality('job-1');
    at(600); timing.tailStep('job-1', 'publishedGraphClear');
    at(2_600); timing.tailStep('job-1', 'legacySwmRetire');
    at(2_700); timing.executorSettled('job-1');
    at(2_800); timing.terminal('job-1');

    const parsed = fields(lines[0]!.message);
    expect(parsed).toMatchObject({
      anchor: 'finality', tailMs: '2300', tailPublishMs: '-', tailReceiptWriteMs: '-',
      tailPublishedGraphClearMs: '200', tailLegacySwmRetireMs: '2000', tailRestMs: '100',
    });
    expect(tailParts(parsed)).toBe(Number(parsed.tailMs));
  });

  it('splits an inline publish up to its terminal write', () => {
    const { timing, lines, at } = harness();
    at(0); timing.receipt('job-1', TX);
    at(300); timing.tailStep('job-1', 'publish');
    at(5_300); timing.tailStep('job-1', 'legacySwmRetire');
    at(5_400); timing.tailStep('job-1', 'catalogObserver');
    at(5_450); timing.terminal('job-1');

    const parsed = fields(lines[0]!.message);
    expect(parsed).toMatchObject({
      path: 'inline', anchor: 'receipt', tailMs: '5450', tailPublishMs: '300',
      tailLegacySwmRetireMs: '5000', tailCatalogObserverMs: '100', tailRestMs: '50',
    });
    expect(tailParts(parsed)).toBe(Number(parsed.tailMs));
  });

  it('keeps the last report of a step, drops a name that is not a step, and starts over with another transaction', () => {
    const { timing, lines, at } = harness();
    at(0); timing.finality('job-1');
    at(100); timing.tailStep('job-1', 'legacySwmRetire');
    // A retried execution reports the step again.
    at(700); timing.tailStep('job-1', 'legacySwmRetire');
    at(800); timing.tailStep('job-1', 'notAStep' as LiftJobTailStep);
    at(900); timing.executorSettled('job-1');
    at(1_000); timing.terminal('job-1');
    const first = fields(lines[0]!.message);
    expect(first).toMatchObject({ tailMs: '900', tailLegacySwmRetireMs: '700', tailRestMs: '200' });
    expect(Object.keys(first).filter((name) => name.startsWith('tail')))
      .toEqual(['tailMs', ...TAIL_STEP_FIELDS, 'tailRestMs']);

    at(2_000); timing.receipt('job-2', TX);
    at(2_100); timing.tailStep('job-2', 'publish');
    at(2_200); timing.receipt('job-2', OTHER_TX);
    at(2_300); timing.terminal('job-2');
    expect(fields(lines[1]!.message)).toMatchObject({ tailMs: '100', ...unsplitTail('100') });
  });

  it('logs a short total at debug and forgets the job once its terminal record is written', () => {
    const { timing, lines, at } = harness();
    at(0); timing.finality('job-1');
    at(LIFT_JOB_POST_FINALITY_INFO_THRESHOLD_MS - 1); timing.terminal('job-1');
    timing.terminal('job-1');
    expect(lines.map(({ level }) => level)).toEqual(['debug']);
    expect(fields(lines[0]!.message)).toMatchObject({ path: 'inline', anchor: 'finality', totalMs: '9999' });
  });

  it('charges an inline publish, which has no settle, turn or handler mark, entirely to its tail', () => {
    const { timing, lines, at } = harness();
    at(10); timing.receipt('job-1', TX);
    at(7_010); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toEqual({
      job: 'job-1', path: 'inline', anchor: 'receipt', totalMs: '7000', tailMs: '7000',
      recoveryAdmissionMs: '-', recoveryRetryMs: '-', proofMs: '-', recoveryMs: '-',
      terminalWriteMs: '-', recoveryTurns: '0', recoveryAttempts: '0', receiptToFinalityMs: '-',
      ...unsplitTail('7000'),
    });
  });

  it('labels a finalize from a held failed record and keeps earlier handler runs in its proof segment', async () => {
    const { timing, lines, at } = harness();
    let runs = 0;
    const handler = timing.timeRecovery(async () => {
      runs += 1;
      if (runs === 1) throw new Error('repair deferred');
    });
    at(0); timing.finality('job-1');
    at(5); await expect(handler({ job: { jobId: 'job-1', status: 'failed' } })).rejects.toThrow('repair deferred');
    at(30_000); await handler({ job: { jobId: 'job-1', status: 'failed' } });
    at(30_010); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({
      path: 'held-failed', totalMs: '30010', tailMs: '-', recoveryAdmissionMs: '-',
      recoveryRetryMs: '-', proofMs: '30000', recoveryMs: '0', terminalWriteMs: '10',
      recoveryAttempts: '2',
      // A line without a tail has no parts of one either.
      ...unsplitTail('-'),
    });
  });

  it('starts an interrupted recovery at its finality, not at turns that came before it', async () => {
    const { timing, lines, at } = harness();
    at(0); timing.recoveryTurn('job-1');
    at(2_000); timing.recoveryTurn('job-1');
    at(2_100); timing.finality('job-1');
    at(2_200); await timing.timeRecovery(async () => { at(2_900); })({ job: { jobId: 'job-1', status: 'broadcast' } });
    at(3_000); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({
      path: 'interrupted', totalMs: '900', tailMs: '-', recoveryAdmissionMs: '-',
      recoveryRetryMs: '-', proofMs: '100', recoveryMs: '700', terminalWriteMs: '100',
      recoveryTurns: '2',
    });
  });

  it('reports turns that did not finalize as retry time', async () => {
    const { timing, lines, at } = harness();
    at(0); timing.finality('job-1');
    at(1_000); timing.executorSettled('job-1');
    at(3_000); timing.recoveryTurn('job-1');
    at(9_000); timing.recoveryTurn('job-1');
    at(9_001); await timing.timeRecovery(async () => {})({ job: { jobId: 'job-1', status: 'included' } });
    at(9_002); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({
      tailMs: '1000', recoveryAdmissionMs: '2000', recoveryRetryMs: '6000', proofMs: '1',
      recoveryMs: '0', terminalWriteMs: '1', recoveryTurns: '2', recoveryAttempts: '1',
    });
  });

  it('shows a finality observed only after the executor settled as a missing tail, not a negative one', () => {
    const { timing, lines, at } = harness();
    at(0); timing.receipt('job-1', TX);
    at(40_000); timing.tailStep('job-1', 'legacySwmRetire');
    at(50_000); timing.executorSettled('job-1');
    at(51_000); timing.recoveryTurn('job-1');
    at(52_000); timing.finality('job-1');
    at(52_500); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({
      path: 'detached', anchor: 'finality', totalMs: '500', tailMs: '-',
      recoveryAdmissionMs: '-', recoveryRetryMs: '-', terminalWriteMs: '500',
      receiptToFinalityMs: '52000',
      // The step was reported, and all of it lies before the anchor.
      ...unsplitTail('-'),
    });
  });

  it('starts over for another transaction and keeps marks recorded before any transaction', () => {
    const { timing, lines, at } = harness();
    at(0); timing.receipt('job-1', TX);
    at(10); timing.finality('job-1');
    at(20); timing.receipt('job-1', OTHER_TX);
    at(30); timing.receipt('job-1', OTHER_TX);
    at(40); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({ anchor: 'receipt', totalMs: '20' });

    at(100); timing.executorSettled('job-2');
    at(110); timing.receipt('job-2', TX);
    at(200); timing.terminal('job-2');
    expect(fields(lines[1]!.message)).toMatchObject({ path: 'detached', anchor: 'receipt', totalMs: '90' });
  });

  it('writes nothing for a job nothing anchored', () => {
    const { timing, lines } = harness();
    timing.executorSettled('job-1');
    timing.recoveryTurn('job-1');
    timing.terminal('job-1');
    timing.terminal('never-seen');
    expect(lines).toEqual([]);
  });

  it('keeps at most 512 jobs, dropping the oldest first', () => {
    const { timing, lines } = harness();
    for (let index = 0; index <= 512; index += 1) timing.finality(`job-${index}`);
    timing.terminal('job-0');
    timing.terminal('job-1');
    timing.terminal('job-512');
    expect(lines.map(({ message }) => fields(message).job)).toEqual(['job-1', 'job-512']);
  });

  it('never throws and never changes the handler it times', async () => {
    const broken = new LiftJobCompletionTiming({
      clock: () => { throw new Error('clock failed'); },
      log: {
        info: () => { throw new Error('log failed'); },
        debug: () => { throw new Error('log failed'); },
      },
    });
    expect(() => {
      broken.receipt('job-1', TX);
      broken.finality('job-1');
      broken.tailStep('job-1', 'publish');
      broken.executorSettled('job-1');
      broken.recoveryTurn('job-1');
      broken.terminal('job-1');
    }).not.toThrow();

    const result = Promise.resolve('value');
    const timed = broken.timeRecovery(() => result);
    expect(timed({ job: { jobId: 'job-1', status: 'included' } })).toBe(result);
    const failure = new Error('handler failed');
    const rejected = broken.timeRecovery(() => Promise.reject(failure));
    await expect(rejected({ job: { jobId: 'job-1', status: 'included' } })).rejects.toBe(failure);
    const synchronous = broken.timeRecovery((): Promise<void> => { throw failure; });
    expect(() => synchronous({ job: { jobId: 'job-1', status: 'included' } })).toThrow(failure);

    const { timing, lines, at } = harness();
    at(0); timing.finality('job-2');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(timing.timeRecovery(() => Promise.reject(failure))({ job: { jobId: 'job-2', status: 'included' } }))
        .rejects.toBe(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    at(10); timing.terminal('job-2');
    expect(fields(lines[0]!.message)).toMatchObject({ recoveryAttempts: '1', recoveryMs: '0' });
  });

  it('is fed by the chain observations it is attached to', () => {
    const { timing, lines, at } = harness();
    const observations = new LiftJobChainObservations();
    observations.completion = timing;
    at(0); observations.receipt('job-1', TX.toUpperCase(), 1);
    at(5); observations.receipt('job-1', TX, 2);
    at(10); observations.finality('job-1', TX, 3);
    at(20); observations.finality('job-1', TX, 4);
    at(30); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({ anchor: 'finality', totalMs: '20', receiptToFinalityMs: '10' });
  });

  it('takes tail steps through the observer the chain observations hand out, whichever timeline is attached then', () => {
    const { timing, lines, at } = harness();
    const observations = new LiftJobChainObservations();
    // The observer is handed out before this timeline replaces the default one.
    const ended = observations.tailObserver('job-1');
    observations.completion = timing;
    at(0); observations.finality('job-1', TX, 1);
    at(40); ended('publish');
    at(900); ended('legacySwmRetire');
    at(1_000); timing.executorSettled('job-1');
    at(1_100); timing.terminal('job-1');
    expect(fields(lines[0]!.message)).toMatchObject({
      tailMs: '1000', tailPublishMs: '40', tailLegacySwmRetireMs: '860', tailRestMs: '100',
    });
  });
});
