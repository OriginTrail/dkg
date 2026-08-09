import { describe, expect, it, vi } from 'vitest';

import type { AgentProfileAdmittedSliceContextV1 } from '../src/system-records/admitted-slice-context-v1.js';
import {
  createAgentProfileReceiverV1,
  type AgentProfileReceiverCandidateV1,
} from '../src/system-records/receiver-v1.js';
import {
  NETWORK,
  PRODUCER_FIXTURE_NOW_MS,
} from './support/agent-profile-producer-v1-fixture.js';
import {
  DEFAULT_MONOTONIC_APPLY_TIMING,
  preparedFixtureApply,
  publishedReceiverFixture as publishedFixture,
} from './support/agent-profile-receiver-v1-fixture.js';

const ADMITTED_CONTEXT = Object.freeze(
  Object.create(null),
) as AgentProfileAdmittedSliceContextV1;

describe('agent-profile system-record prepared receiver apply', () => {
  it('rechecks freshness immediately before the materialization point of no return', async () => {
    const fixture = await publishedFixture();
    const validUntilMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 1)
      .mockReturnValue(validUntilMs);
    const verifyCurrentBundle = vi.fn(() => true);
    const prepareCandidateApply = vi.fn(() => preparedFixtureApply('1', 'a'));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .rejects.toThrow(/expired agent-profile head/);
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(verifyCurrentBundle).toHaveBeenCalledTimes(1);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
  });

  it('clamps bridge admission after waits without mixing wall and monotonic clocks', async () => {
    const fixture = await publishedFixture();
    const validUntilUnixMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilUnixMs - 100)
      .mockReturnValue(validUntilUnixMs - 60);
    const existingMonotonicDeadlineMs = 5_200;
    const monotonicNowMs = 5_000;
    const inspectAdmittedContext = vi.fn((context: AgentProfileAdmittedSliceContextV1) => {
      expect(context).toBe(ADMITTED_CONTEXT);
      return Object.freeze({
        nowMs: monotonicNowMs,
        admittedDeadlineMs: existingMonotonicDeadlineMs,
      });
    });
    const issueProofAndApply = vi.fn(async (admittedDeadlineMs: number) => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
      admittedDeadlineMs,
    }));
    const prepareCandidateApply = vi.fn(async (
      _candidate: AgentProfileReceiverCandidateV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => {
      await Promise.resolve();
      const inspected = inspectAdmittedContext(admittedContext);
      return Object.freeze({
        existingMonotonicDeadlineMs: inspected.admittedDeadlineMs,
        monotonicNowMs: Math.floor(inspected.nowMs),
        apply: issueProofAndApply,
      });
    });
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(inspectAdmittedContext).toHaveBeenCalledTimes(1);
    expect(issueProofAndApply).toHaveBeenCalledWith(5_060);
    expect(issueProofAndApply).not.toHaveBeenCalledWith(validUntilUnixMs);
  });

  it('preserves an authenticated existing deadline when it is tighter', async () => {
    const fixture = await publishedFixture();
    const validUntilUnixMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilUnixMs - 100)
      .mockReturnValueOnce(validUntilUnixMs - 80)
      .mockReturnValue(validUntilUnixMs - 60);
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => Object.freeze({
        existingMonotonicDeadlineMs: 5_025,
        monotonicNowMs: 5_000,
        apply,
      }),
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(5_025);
  });

  it('rejects an already-expired authenticated monotonic deadline', async () => {
    const fixture = await publishedFixture();
    const apply = vi.fn();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: () => Object.freeze({
        existingMonotonicDeadlineMs: 5_000,
        monotonicNowMs: 5_000,
        apply,
      }),
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .rejects.toThrow(/monotonic apply admission is expired/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('invokes the prepared lifecycle apply entry exactly once', async () => {
    const fixture = await publishedFixture();
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      ...DEFAULT_MONOTONIC_APPLY_TIMING,
      apply,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .resolves.toMatchObject({ outcome: 'applied' });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge an apply outcome returned instead of prepared state', async () => {
    const fixture = await publishedFixture();
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply: vi.fn(async () => Object.freeze({
        outcome: 'applied',
        stateRevision: '6',
        appliedStateDigest: `0x${'8'.repeat(64)}`,
      }) as never),
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .rejects.toThrow(/monotonic apply existing deadline is invalid/);
  });

  it('lets the lifecycle bridge reject expiry after its own asynchronous admission work', async () => {
    const fixture = await publishedFixture();
    const validUntilMs = Date.parse(fixture.envelope.object.validUntil);
    const nowMs = vi.fn()
      .mockReturnValueOnce(validUntilMs - 2)
      .mockReturnValue(validUntilMs);
    const apply = vi.fn(() => ({
      outcome: 'applied' as const,
      stateRevision: '6',
      appliedStateDigest: `0x${'8'.repeat(64)}`,
    }));
    const prepareCandidateApply = vi.fn(async (
      _candidate: AgentProfileReceiverCandidateV1,
      admittedContext: AgentProfileAdmittedSliceContextV1,
      _signal: AbortSignal,
    ) => {
      expect(admittedContext).toBe(ADMITTED_CONTEXT);
      await Promise.resolve();
      return Object.freeze({ ...DEFAULT_MONOTONIC_APPLY_TIMING, apply });
    });
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });

    await expect(receiver.receiveActive(
      fixture.row,
      ADMITTED_CONTEXT,
      new AbortController().signal,
    ))
      .rejects.toThrow(/expired agent-profile head/);
    expect(nowMs).toHaveBeenCalledTimes(2);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('dispatches a real prepared apply once and honors abort before dispatch', async () => {
    const fixture = await publishedFixture();
    const apply = vi.fn(async () => preparedFixtureApply('1', 'a').apply(10_000));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      ...DEFAULT_MONOTONIC_APPLY_TIMING,
      apply,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => PRODUCER_FIXTURE_NOW_MS,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });
    const signal = new AbortController().signal;
    const prepared = await receiver.prepareActive(fixture.row, signal);

    await expect(prepared.apply(ADMITTED_CONTEXT, signal))
      .resolves.toMatchObject({ outcome: 'applied' });
    await expect(prepared.apply(ADMITTED_CONTEXT, signal))
      .rejects.toThrow(/already dispatched/);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);

    const abortedPrepared = await receiver.prepareActive(fixture.row, signal);
    const controller = new AbortController();
    controller.abort(new Error('abort before prepared apply'));
    await expect(abortedPrepared.apply(ADMITTED_CONTEXT, controller.signal))
      .rejects.toThrow(/abort before prepared apply/);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects a prepared apply when the verified active head expires before dispatch', async () => {
    const fixture = await publishedFixture();
    let nowMs = PRODUCER_FIXTURE_NOW_MS;
    const apply = vi.fn(async () => ({ outcome: 'stale' as const }));
    const prepareCandidateApply = vi.fn(() => Object.freeze({
      ...DEFAULT_MONOTONIC_APPLY_TIMING,
      apply,
    }));
    const receiver = createAgentProfileReceiverV1({
      networkId: NETWORK,
      artifacts: fixture.store,
      nowMs: () => nowMs,
      verifyCurrentBundle: () => true,
      prepareCandidateApply,
    });
    const signal = new AbortController().signal;
    const prepared = await receiver.prepareActive(fixture.row, signal);

    nowMs = Date.parse(fixture.envelope.object.validUntil);
    await expect(prepared.apply(ADMITTED_CONTEXT, signal))
      .rejects.toThrow(/expired agent-profile head/);
    expect(prepareCandidateApply).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});
