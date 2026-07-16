/**
 * `publishProfileTail` serialization tests — PR #700 round-2 mutex.
 *
 * The mutex lives at `packages/agent/src/dkg-agent.ts:4085-4101`.
 * Every `publishProfile()` caller chains onto the prior tail's
 * promise via `.catch(swallow).then(() => publishProfileImpl())`,
 * so the four production callers (startup, heartbeat, key
 * rotation, key revocation) can never race on
 * `ProfileManager.currentKcId` or the agent registry triples.
 *
 * #716 review-consolidation audit flagged the mutex itself as
 * "Critical — never proven to serialize concurrent calls". The
 * helper code is tiny but the correctness gate it provides is the
 * widest in PR #700's concurrency-critical fan-out (rotate / revoke
 * mid-heartbeat would otherwise rewrite the same registry triples
 * concurrently). This file pins:
 *
 *   1. **Serialization** — N concurrent `publishProfile()` calls
 *      invoke `publishProfileImpl` exactly once each and never
 *      overlap.
 *
 *   2. **Error isolation** — a failing `publishProfileImpl` does
 *      not poison the tail; the next caller still gets to run.
 *
 *   3. **Return propagation** — each caller's awaited promise
 *      resolves to its OWN `publishProfileImpl` return value, not
 *      a sibling's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

/**
 * Reach into the agent to replace the private `publishProfileImpl`
 * with a controllable stub. The stub records:
 *   - the order of calls
 *   - the maximum number of concurrent invocations observed
 *
 * If the mutex is honoured, `maxConcurrency` stays at 1 across N
 * overlapping `publishProfile()` calls. If a future refactor drops
 * the tail-chain or breaks the `.then(...)` ordering, concurrency
 * spikes to N and the assertion below fires loud.
 */
interface PublishProfileInternals {
  publishProfileImpl(): Promise<unknown>;
  publishProfileTail: Promise<unknown>;
}

async function bootAgent(): Promise<{ agent: DKGAgent; internals: PublishProfileInternals }> {
  const agent = await DKGAgent.create({
    name: 'PublishProfileMutexTest',
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as PublishProfileInternals;
  return { agent, internals };
}

describe('DKGAgent.publishProfile — tail-chain mutex serialization (PR #700 round 2)', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('serializes N concurrent publishProfile() calls — max-in-flight stays at 1', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Per-call stub that sleeps a controllable amount. We pick a
    // short delay (15 ms) — enough that all calls overlap in the
    // event loop if they were ever allowed to run concurrently, but
    // short enough that the test stays well under any reasonable
    // CI timeout even with `maxWorkers: 1` agent test config.
    const SLEEP_MS = 15;
    const N = 5;
    let inFlight = 0;
    let maxConcurrency = 0;
    const callOrder: number[] = [];
    let nextCallId = 0;

    internals.publishProfileImpl = async function stubImpl(): Promise<unknown> {
      const myId = nextCallId++;
      callOrder.push(myId);
      inFlight++;
      try {
        if (inFlight > maxConcurrency) maxConcurrency = inFlight;
        await new Promise<void>((resolve) => setTimeout(resolve, SLEEP_MS));
        return { ok: true, callId: myId };
      } finally {
        inFlight--;
      }
    } as PublishProfileInternals['publishProfileImpl'];

    // Fire N concurrent publishProfile() calls. Each must wait for
    // the prior tail to settle.
    const promises = Array.from({ length: N }, () => agent!.publishProfile());
    const results = await Promise.all(promises);

    // The whole point: never more than 1 publishProfileImpl in flight.
    expect(maxConcurrency).toBe(1);

    // And: every call ran exactly once, in submission order
    // (the chain is FIFO — each new caller appends to the tail).
    expect(callOrder).toEqual([0, 1, 2, 3, 4]);

    // Each caller awaits ITS OWN run — not a sibling's return value
    // — even though they're chained.
    expect(results.map((r) => (r as { callId: number }).callId)).toEqual([0, 1, 2, 3, 4]);
  });

  it('coalesces concurrent first-profile readiness checks into one publish', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    let publishes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (agent as unknown as { publishProfile: () => Promise<unknown> }).publishProfile = async () => {
      publishes++;
      await gate;
      return { ok: true };
    };

    const readiness = [
      agent.ensureProfilePublished(),
      agent.ensureProfilePublished(),
      agent.ensureProfilePublished(),
    ];
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(publishes).toBe(1);

    release();
    await expect(Promise.all(readiness)).resolves.toHaveLength(3);
    expect(publishes).toBe(1);
  });

  it('error isolation: a failing publishProfileImpl does not poison the tail for subsequent callers', async () => {
    // Pinned by the explicit `.catch(swallow)` in the mutex body.
    // Without that, a single rejected publish would wedge every
    // future publishProfile() in `await publishProfileTail` because
    // the tail promise would stay rejected forever (and `.then()` on
    // a rejected promise without a `.catch` propagates).
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    let invocation = 0;
    internals.publishProfileImpl = async function stubImpl(): Promise<unknown> {
      const myInvocation = invocation++;
      if (myInvocation === 1) {
        throw new Error('synthetic failure to test error isolation');
      }
      return { ok: true, invocation: myInvocation };
    } as PublishProfileInternals['publishProfileImpl'];

    // Codex review feedback: collecting the three promises with
    // `Promise.allSettled` attaches a handler to each one BEFORE
    // awaiting. Without it, the middle promise can reject between
    // the call site at line `agent.publishProfile()` and the
    // subsequent `await expect(...).rejects.toThrow(...)` call,
    // surfacing as an unhandled rejection under Vitest/Node and
    // making the test flaky on busy CI runners.
    const settled = await Promise.allSettled([
      agent.publishProfile(),
      agent.publishProfile(),
      agent.publishProfile(),
    ]);

    expect(settled[0].status).toBe('fulfilled');
    expect((settled[0] as PromiseFulfilledResult<unknown>).value).toEqual({
      ok: true,
      invocation: 0,
    });

    expect(settled[1].status).toBe('rejected');
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(((settled[1] as PromiseRejectedResult).reason as Error).message).toMatch(
      /synthetic failure to test error isolation/,
    );

    // The crucial assertion: the third call must still run even
    // though the second tail rejected. The `.catch()` in
    // `publishProfile()` swallows the prior error before chaining.
    expect(settled[2].status).toBe('fulfilled');
    expect((settled[2] as PromiseFulfilledResult<unknown>).value).toEqual({
      ok: true,
      invocation: 2,
    });

    // And: the next *fresh* call (after the bad ones settled) also
    // succeeds — proves the tail is healthy long-term.
    await expect(agent.publishProfile()).resolves.toEqual({ ok: true, invocation: 3 });
  });

  it('returns each caller their OWN publishProfileImpl result (return-value isolation across chained tails)', async () => {
    // Subtle correctness boundary: the chained-promise shape could
    // accidentally collapse N callers to receiving the same return
    // value if the mutex was implemented as a single shared promise
    // (e.g. `return this.publishProfileTail`). The actual
    // implementation captures `run` per-caller and returns it, so
    // each awaited promise resolves to its OWN implementation call.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    let counter = 0;
    internals.publishProfileImpl = async function stubImpl(): Promise<unknown> {
      const myId = counter++;
      // Stagger so the chained-promise shape can't accidentally
      // resolve all callers to the last result via shared state.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return { uniqueResult: `result-${myId}` };
    } as PublishProfileInternals['publishProfileImpl'];

    const results = await Promise.all([
      agent.publishProfile(),
      agent.publishProfile(),
      agent.publishProfile(),
    ]);

    expect(results.map((r) => (r as { uniqueResult: string }).uniqueResult))
      .toEqual(['result-0', 'result-1', 'result-2']);
  });
});
