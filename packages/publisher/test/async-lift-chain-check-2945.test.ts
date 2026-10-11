/**
 * GH#2945 item 1 - what the latest chain re-check of a HELD job found, as the publisher records it.
 *
 * The dispatcher asks the chain about every held job on a backoff and, when the answer does not settle
 * it, defers. Until now the answer was thrown away, so nothing could say WHY a job was still held.
 * `lastChainProofCheck(job)` reads what the schedule keeps beside the deferral: a closed code and when it
 * was recorded, for that exact incarnation, in this process's memory only. It is observability: the
 * cadence, the attempt count and every disposition are asserted unchanged by the existing chain-proof
 * suites (cadence, dispatch, schedule), which this change leaves untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AsyncLiftChainProofResolution } from '../src/index.js';
import { chainCheckOutcomeOf } from '../src/async-lift-publisher-impl.js';
import { createAsyncLift2270Harness, expectFailed } from './_helpers/async-lift-2270-harness.js';

describe('GH#2945 a held job reports what its latest chain re-check found', () => {
  const h = createAsyncLift2270Harness();

  beforeEach(() => h.reset());

  /** A held job (a recorded transaction hash) on a publisher whose resolver answers `answer()`. */
  async function heldJob(answer: () => Promise<unknown>, config: Record<string, unknown> = {}) {
    const publisher = h.createPublisher({
      chainProofResolver: answer as never,
      ...config,
    });
    const job = await h.failAfterRecordedTxHash(publisher);
    return { publisher, job };
  }

  const pending = async () => ({ status: 'pending-mempool' } as const);

  it('has nothing before the first re-check', async () => {
    const { publisher, job } = await heldJob(pending);

    expect(publisher.lastChainProofCheck(job)).toBeUndefined();
  });

  it.each([
    ['pending-mempool', { status: 'pending-mempool' }, 'pending-mempool'],
    ['pending-awaiting-confirmation', { status: 'pending-awaiting-confirmation' }, 'pending-awaiting-confirmation'],
    ['unrecognized', { status: 'unrecognized' }, 'unrecognized'],
    ['a bare inconclusive', { status: 'inconclusive' }, 'inconclusive'],
    ['an inconclusive that says the chain RPC could not answer', { status: 'inconclusive', reason: 'rpc-unavailable' }, 'rpc-unavailable'],
    ['an inconclusive that says the absence is unproven', { status: 'inconclusive', reason: 'absence-unproven' }, 'absence-unproven'],
    ['an inconclusive with a reason this contract does not define', { status: 'inconclusive', reason: 'whatever-a-resolver-invents' }, 'inconclusive'],
    ['a status this contract does not define', { status: 'banana' }, 'inconclusive'],
  ] as const)('records %s as %s', async (_label, verdict, outcome) => {
    const { publisher, job } = await heldJob(async () => verdict);

    await publisher.recover();

    const check = publisher.lastChainProofCheck(job);
    expect(check).toEqual({ outcome, at: expect.any(Number) });
    expect(check!.at).toBeGreaterThan(0);
    // The job itself is untouched: still the same held failure.
    expect(expectFailed(await publisher.getStatus(job.jobId)).failure.code).toBe(job.failure.code);
  });

  it('records a resolver that throws as an error, without the message', async () => {
    const { publisher, job } = await heldJob(async () => {
      throw new Error('boom at https://rpc.example/v2/SECRET-API-KEY');
    });

    await publisher.recover();

    const check = publisher.lastChainProofCheck(job);
    expect(check).toEqual({ outcome: 'error', at: expect.any(Number) });
    expect(JSON.stringify(check)).not.toContain('SECRET-API-KEY');
  });

  it('records a lookup the pass ran out of time for as a deadline', async () => {
    const { publisher, job } = await heldJob(() => new Promise(() => undefined), { chainProofDispatchTimeBudgetMs: 20 });

    await publisher.recover();

    expect(publisher.lastChainProofCheck(job)).toEqual({ outcome: 'deadline', at: expect.any(Number) });
  });

  it('does not call a resolver that merely returned null a deadline', async () => {
    const { publisher, job } = await heldJob(async () => null);

    await publisher.recover();

    expect(publisher.lastChainProofCheck(job)).toEqual({ outcome: 'inconclusive', at: expect.any(Number) });
  });

  it('keeps only the LATEST observation, with its own stamp', async () => {
    const answers: Array<() => Promise<unknown>> = [
      async () => ({ status: 'inconclusive', reason: 'rpc-unavailable' }),
      async () => ({ status: 'pending-awaiting-confirmation' }),
    ];
    const { publisher, job } = await heldJob(async () => answers.shift()!());
    await publisher.recover();
    const first = publisher.lastChainProofCheck(job)!;
    expect(first.outcome).toBe('rpc-unavailable');

    h.advance(61_000);
    await publisher.recover();

    const second = publisher.lastChainProofCheck(job)!;
    expect(second.outcome).toBe('pending-awaiting-confirmation');
    expect(second.at).toBeGreaterThan(first.at);
  });

  it('keeps the observation across a re-ask that is not yet due, and does not invent one for a job it did not ask', async () => {
    const asks: string[] = [];
    const { publisher, job } = await heldJob(async () => {
      asks.push('asked');
      return { status: 'inconclusive' } as const;
    });
    await publisher.recover();
    const first = publisher.lastChainProofCheck(job);
    expect(first).toEqual({ outcome: 'inconclusive', at: expect.any(Number) });

    // Inside the backoff nothing is asked and nothing changes.
    h.advance(1_000);
    await publisher.recover();

    expect(asks).toHaveLength(1);
    expect(publisher.lastChainProofCheck(job)).toEqual(first);
  });

  it('is gone once the job settles: a proven-absent CREATE is released for a re-run', async () => {
    const answers = [{ status: 'pending-mempool' }, { status: 'not-found' }];
    const { publisher, job } = await heldJob(async () => answers.shift());
    await publisher.recover();
    expect(publisher.lastChainProofCheck(job)?.outcome).toBe('pending-mempool');

    h.advance(61_000);
    expect(await publisher.recover()).toBe(1);

    expect(publisher.lastChainProofCheck(job)).toBeUndefined();
  });

  it('is absent on a publisher that runs no chain-proof dispatcher', async () => {
    const publisher = h.createPublisher();
    const job = await h.failAfterRecordedTxHash(publisher);
    await publisher.recover();

    expect(publisher.lastChainProofCheck(job)).toBeUndefined();
  });

  it('is absent for a job that is not a held failure', async () => {
    const { publisher, job } = await heldJob(pending);
    await publisher.recover();
    const live = { ...job, status: 'accepted' } as never;

    expect(publisher.lastChainProofCheck(live)).toBeUndefined();
  });
});

describe('GH#2945 chainCheckOutcomeOf: the closed vocabulary at the boundary', () => {
  const statuses: AsyncLiftChainProofResolution['status'][] = [
    'recovered', 'reverted', 'unrecognized', 'pending-mempool', 'pending-awaiting-confirmation', 'not-found', 'inconclusive',
  ];

  it.each(statuses)('reports the %s verdict as itself', (status) => {
    expect(chainCheckOutcomeOf({ status } as AsyncLiftChainProofResolution)).toBe(status);
  });

  it('carries the reasons it defines, only on an inconclusive verdict', () => {
    expect(chainCheckOutcomeOf({ status: 'inconclusive', reason: 'rpc-unavailable' })).toBe('rpc-unavailable');
    expect(chainCheckOutcomeOf({ status: 'inconclusive', reason: 'absence-unproven' })).toBe('absence-unproven');
    // A reason on any other verdict is not a reason.
    expect(chainCheckOutcomeOf({ status: 'not-found', reason: 'rpc-unavailable' } as never)).toBe('not-found');
  });

  it('never puts an arbitrary string on the wire', () => {
    expect(chainCheckOutcomeOf({ status: 'constructor' } as never)).toBe('inconclusive');
    expect(chainCheckOutcomeOf({ status: 'inconclusive', reason: 'x' } as never)).toBe('inconclusive');
  });
});
