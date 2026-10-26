/**
 * Concurrent write preflights share one probe (OT-RFC-73 S4a; `write-preflight-coalescing.ts`): who may
 * share, when a probe in flight stops being joinable, what the optional result cache keeps, and that
 * turning the switch off restores today's calls exactly. The real probe, the real store observer and the
 * resolver working together are in `write-preflight-coalescing-seam.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { ContextGraphWritePreflightProbe } from '@origintrail-official/dkg-agent';
import {
  WritePreflightGeneration,
  WritePreflightIdentityMethods,
  attachWritePreflightGeneration,
} from '../../agent/src/dkg-agent-write-preflight.js';
import {
  WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS,
  WRITE_PREFLIGHT_CACHE_ENV,
  WRITE_PREFLIGHT_CACHE_MAX_ENTRIES,
  WRITE_PREFLIGHT_CACHE_MAX_TTL_MS,
  WRITE_PREFLIGHT_CACHE_MIN_TTL_MS,
  WRITE_PREFLIGHT_CACHE_TTL_ENV,
  WRITE_PREFLIGHT_COALESCING_ENV,
  WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS,
  configureWritePreflightCoalescing,
  getWritePreflightCoalescingConfig,
  probeWritePreflight,
  resolveWritePreflightCoalescingConfig,
  type CoalescingProbeAgent,
} from '../src/daemon/write-preflight-coalescing.js';
import { resolveAwaitingWriteReadiness } from '../src/daemon/context-graph-write-readiness.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';

type Probe = ContextGraphWritePreflightProbe;

const CG = '0x1111111111111111111111111111111111111111/policy-cg';
const OTHER_CG = '0x1111111111111111111111111111111111111111/other-cg';
// EIP-55 test vectors: ALICE in three spellings, BAD_CHECKSUM names nobody, BOB is another caller.
const ALICE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ALICE_LOWER = ALICE.toLowerCase();
const BAD_CHECKSUM = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const BOB = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

const ACCEPT: Probe = {
  storeAvailable: true, exists: true, hasLocalContent: true, declarationFound: true,
  accessPolicy: 'public', callerAuthorized: true,
};
const fastAccepts = (probe: Probe): boolean => probe.storeAvailable && probe.exists === true
  && probe.hasLocalContent === true && probe.callerAuthorized === true;

interface PendingProbe {
  readonly contextGraphId: string;
  readonly opts: { callerAgentAddress?: string | null; onChainLookup?: () => void } | undefined;
  resolve(probe: Probe): void;
  reject(error: unknown): void;
}

/** An agent whose probe stays pending until the test settles it, with the real identity rules. */
function fakeAgent(options: { attached?: boolean } = {}) {
  const subs = new Map<string, Record<string, unknown>>();
  const generation = new WritePreflightGeneration();
  const pending: PendingProbe[] = [];
  const probe = vi.fn((contextGraphId: string, opts?: PendingProbe['opts']) => new Promise<Probe>((resolve, reject) => {
    pending.push({ contextGraphId, opts, resolve, reject });
  }));
  const agent = {
    getSubscribedContextGraphs: () => subs,
    probeContextGraphWritePreflight: probe,
    writePreflightIdentity(contextGraphId: string, caller?: string | null) {
      return WritePreflightIdentityMethods.prototype.writePreflightIdentity.call(agent as never, contextGraphId, caller);
    },
  };
  if (options.attached !== false) attachWritePreflightGeneration(agent, generation);
  return { agent: agent as unknown as CoalescingProbeAgent, probe, pending, generation, subs };
}

const call = (agent: CoalescingProbeAgent, caller: string | null, contextGraphId = CG, fresh = false) =>
  probeWritePreflight(agent, contextGraphId, caller, { accepts: fastAccepts, fresh });

const silent = { info: () => {}, warn: () => {} };
const configure = (env: Record<string, string | undefined> = {}) => configureWritePreflightCoalescing(env, silent);

beforeEach(() => { configure(); });
afterEach(() => { vi.useRealTimers(); configure(); });

describe('who shares a probe', () => {
  it('lets concurrent calls for one graph and one caller share one probe, each with its own copy', async () => {
    const { agent, probe, pending } = fakeAgent();
    const calls = [call(agent, ALICE), call(agent, ALICE), call(agent, ALICE)];
    expect(probe).toHaveBeenCalledTimes(1);
    pending[0]!.resolve({ ...ACCEPT, failureAttribution: [{ site: 'declaration', kind: 'unknown' }] });
    const [first, second, third] = await Promise.all(calls);
    expect(first!.probe).toEqual(second!.probe);
    expect(first!.probe).not.toBe(second!.probe);
    // One caller changing what it got changes nothing for the others.
    (first!.probe as { callerAuthorized?: boolean }).callerAuthorized = false;
    (second!.probe.failureAttribution as unknown[]).length = 0;
    expect(third!.probe.callerAuthorized).toBe(true);
    expect(third!.probe.failureAttribution).toEqual([{ site: 'declaration', kind: 'unknown' }]);
  });

  it('shares between spellings of one caller, and probes with the first caller\'s spelling', async () => {
    const { agent, probe, pending } = fakeAgent();
    const calls = [call(agent, ALICE_LOWER), call(agent, ALICE), call(agent, `did:dkg:agent:${ALICE_LOWER}`)];
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![1]).toMatchObject({ callerAgentAddress: ALICE_LOWER });
    pending[0]!.resolve(ACCEPT);
    await Promise.all(calls);
  });

  it('never merges different callers: each gets the answer for itself', async () => {
    const { agent, probe, pending } = fakeAgent();
    const alice = call(agent, ALICE);
    const bob = call(agent, BOB);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.map(([, opts]) => opts?.callerAgentAddress)).toEqual([ALICE, BOB]);
    pending[1]!.resolve({ ...ACCEPT, callerAuthorized: false });
    pending[0]!.resolve(ACCEPT);
    expect((await alice).probe.callerAuthorized).toBe(true);
    expect((await bob).probe.callerAuthorized).toBe(false);
  });

  it('never merges different context graphs, whose allowlists differ, for the same caller', async () => {
    const { agent, probe, pending } = fakeAgent();
    const allowed = call(agent, ALICE, CG);
    const refused = call(agent, ALICE, OTHER_CG);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.map(([id]) => id)).toEqual([CG, OTHER_CG]);
    pending[0]!.resolve(ACCEPT);
    pending[1]!.resolve({ ...ACCEPT, accessPolicy: 'private', callerAuthorized: false });
    expect((await allowed).probe.callerAuthorized).toBe(true);
    expect((await refused).probe.callerAuthorized).toBe(false);
  });

  it('keeps "no caller" apart from every address, and merges strings that name nobody with it', async () => {
    const { agent, probe, pending } = fakeAgent();
    const calls = [call(agent, null), call(agent, BAD_CHECKSUM), call(agent, ALICE)];
    expect(probe).toHaveBeenCalledTimes(2);
    pending[0]!.resolve({ ...ACCEPT, callerAuthorized: undefined });
    pending[1]!.resolve(ACCEPT);
    const [anonymous, typo, alice] = await Promise.all(calls);
    expect(anonymous!.probe.callerAuthorized).toBeUndefined();
    expect(typo!.probe.callerAuthorized).toBeUndefined();
    expect(alice!.probe.callerAuthorized).toBe(true);
  });

  it('does not join a probe that has finished', async () => {
    const { agent, probe, pending } = fakeAgent();
    const first = call(agent, ALICE);
    pending[0]!.resolve(ACCEPT);
    await first;
    const second = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await second;
  });

  it('rejects every joined caller with the probe\'s failure, and probes afresh afterwards', async () => {
    const { agent, probe, pending } = fakeAgent();
    const first = call(agent, ALICE);
    const second = call(agent, ALICE);
    const failure = new Error('probe blew up');
    pending[0]!.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    const retry = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await expect(retry).resolves.toMatchObject({ probe: ACCEPT });
  });

  it('still gives each caller its own copy of a probe that cannot be cloned', async () => {
    const { agent, pending } = fakeAgent();
    const calls = [call(agent, ALICE), call(agent, ALICE)];
    // A probe carrying a function: a plain copy of its fields is what is left to hand out.
    pending[0]!.resolve({ ...ACCEPT, onNote: () => {} } as Probe);
    const [first, second] = await Promise.all(calls);
    expect(first!.probe).not.toBe(second!.probe);
    expect(first!.probe).toMatchObject({ callerAuthorized: true, exists: true });
    expect(second!.probe).toMatchObject({ callerAuthorized: true, exists: true });
  });

  it('turns a probe that throws before returning a promise into a rejection for all callers', async () => {
    const { agent, probe } = fakeAgent();
    probe.mockImplementationOnce(() => { throw new Error('threw at once'); });
    const first = call(agent, ALICE);
    const second = call(agent, ALICE);
    await expect(first).rejects.toThrow('threw at once');
    await expect(second).rejects.toThrow('threw at once');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('a probe in flight stops being joinable', () => {
  it('when a write to a policy source settles: the new caller starts its own probe and never gets the older one\'s result', async () => {
    const { agent, probe, pending, generation } = fakeAgent();
    const before = call(agent, ALICE);
    const alsoBefore = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(1);

    generation.bump(); // a ratchet commit lands while the probe is in flight

    const after = call(agent, ALICE);
    const alsoAfter = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);

    // The older probe ends last, with the answer it read before the commit.
    pending[1]!.resolve({ ...ACCEPT, accessPolicy: 'private', callerAuthorized: false });
    pending[0]!.resolve(ACCEPT);
    expect((await after).probe.callerAuthorized).toBe(false);
    expect((await alsoAfter).probe.callerAuthorized).toBe(false);
    expect((await before).probe.callerAuthorized).toBe(true);
    expect((await alsoBefore).probe.callerAuthorized).toBe(true);
  });

  it('keeps the newer probe joinable when the older one ends first', async () => {
    const { agent, probe, pending, generation } = fakeAgent();
    const older = call(agent, ALICE);
    generation.bump();
    const newer = call(agent, ALICE);
    pending[0]!.resolve(ACCEPT);
    await older;
    // The older probe's end must not release the newer probe's slot.
    const joiner = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({ ...ACCEPT, callerAuthorized: false });
    expect((await newer).probe.callerAuthorized).toBe(false);
    expect((await joiner).probe.callerAuthorized).toBe(false);
  });

  it('when the graph\'s subscription changes, but not when another graph\'s does', async () => {
    const { agent, probe, pending, subs } = fakeAgent();
    const first = call(agent, ALICE);
    subs.set(OTHER_CG, { subscribed: true, synced: true });
    const unrelated = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(1);
    subs.set(CG, { subscribed: true, synced: true });
    const afterSync = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[0]!.resolve(ACCEPT);
    pending[1]!.resolve(ACCEPT);
    await Promise.all([first, unrelated, afterSync]);
  });

  it('after the join limit, so a probe that hangs cannot hold every later caller', async () => {
    vi.useFakeTimers();
    const { agent, probe, pending } = fakeAgent();
    const hung = call(agent, ALICE);
    vi.advanceTimersByTime(WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS - 1);
    const stillJoined = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    const fresh = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await expect(fresh).resolves.toMatchObject({ probe: ACCEPT });
    // The hung probe, once it ends, still answers its own callers.
    pending[0]!.resolve({ ...ACCEPT, hasLocalContent: false });
    expect((await hung).probe.hasLocalContent).toBe(false);
    expect((await stillJoined).probe.hasLocalContent).toBe(false);
  });

  it('for the second pass after a readiness wait, which neither joins nor is joined away from the newest probe', async () => {
    const { agent, probe, pending } = fakeAgent();
    const concurrent = call(agent, ALICE);
    const afterWait = call(agent, ALICE, CG, true);
    expect(probe).toHaveBeenCalledTimes(2);
    // Callers arriving later join the newest probe, the fresh one.
    const later = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({ ...ACCEPT, hasLocalContent: true });
    pending[0]!.resolve({ ...ACCEPT, hasLocalContent: false });
    expect((await afterWait).probe.hasLocalContent).toBe(true);
    expect((await later).probe.hasLocalContent).toBe(true);
    expect((await concurrent).probe.hasLocalContent).toBe(false);
  });
});

describe('without coalescing', () => {
  it('probes directly, with exactly the call made before, when the agent has no identity', async () => {
    const { agent, probe, pending } = fakeAgent({ attached: false });
    const first = call(agent, ALICE);
    const second = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls).toEqual([[CG, { callerAgentAddress: ALICE }], [CG, { callerAgentAddress: ALICE }]]);
    pending[0]!.resolve(ACCEPT);
    pending[1]!.resolve(ACCEPT);
    expect((await first).probe).toBe(ACCEPT);
    await second;
  });

  it('probes directly when the agent has no identity method at all', async () => {
    const probe = vi.fn(async () => ACCEPT);
    const result = await probeWritePreflight({ probeContextGraphWritePreflight: probe }, CG, null, { accepts: fastAccepts });
    expect(probe).toHaveBeenCalledWith(CG, { callerAgentAddress: null });
    expect(result.probe).toBe(ACCEPT);
  });

  it('probes directly when asking for the identity throws', async () => {
    const probe = vi.fn(async () => ACCEPT);
    const agent = { probeContextGraphWritePreflight: probe, writePreflightIdentity: () => { throw new Error('no identity'); } };
    await probeWritePreflight(agent, CG, ALICE, { accepts: fastAccepts });
    await probeWritePreflight(agent, CG, ALICE, { accepts: fastAccepts });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledWith(CG, { callerAgentAddress: ALICE });
  });

  it.each(['0', 'false', 'no', 'off', 'OFF'])('with %s the switch restores today\'s calls: every call probes, with the same arguments, and gets the probe itself', async (value) => {
    configure({ [WRITE_PREFLIGHT_COALESCING_ENV]: value, [WRITE_PREFLIGHT_CACHE_ENV]: '1' });
    const { agent, probe, pending } = fakeAgent();
    const calls = [call(agent, ALICE), call(agent, ALICE)];
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls).toEqual([[CG, { callerAgentAddress: ALICE }], [CG, { callerAgentAddress: ALICE }]]);
    pending[0]!.resolve(ACCEPT);
    pending[1]!.resolve(ACCEPT);
    const [first, second] = await Promise.all(calls);
    expect(first!.probe).toBe(ACCEPT);
    expect(second!.probe).toBe(ACCEPT);
    first!.fastAccepted();
    // Not even a cache: the next call probes again.
    const third = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(3);
    pending[2]!.resolve(ACCEPT);
    await third;
  });
});

describe('the result cache', () => {
  beforeEach(() => { configure({ [WRITE_PREFLIGHT_CACHE_ENV]: '1' }); });

  /** One probe call that ends in a fast accept, as the resolver reports it. */
  async function accepted(agent: CoalescingProbeAgent, pending: PendingProbe[], caller: string | null = ALICE, contextGraphId = CG, probe: Probe = ACCEPT) {
    const index = pending.length;
    const result = call(agent, caller, contextGraphId);
    pending[index]!.resolve(probe);
    const settled = await result;
    settled.fastAccepted();
    return settled;
  }

  it('is off by default: a fast accept is probed again', async () => {
    configure();
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    const again = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await again;
  });

  it('serves a fast accept to the same caller within the TTL, without probing', async () => {
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    const hit = await call(agent, ALICE_LOWER);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(hit.probe).toEqual(ACCEPT);
    expect(hit.probe).not.toBe(ACCEPT);
  });

  it('expires after the TTL', async () => {
    vi.useFakeTimers();
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    vi.advanceTimersByTime(WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS - 1);
    await call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    const expired = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await expired;
  });

  it('does not trust an entry that is dated after now, as when the clock stepped back', async () => {
    vi.useFakeTimers();
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    vi.setSystemTime(Date.now() - 60_000);
    const stepped = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await stepped;
  });

  it('measures the TTL from the start of the probe, not from when its answer was used', async () => {
    vi.useFakeTimers();
    const { agent, probe, pending } = fakeAgent();
    const slow = call(agent, ALICE);
    vi.advanceTimersByTime(WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS - 100);
    pending[0]!.resolve(ACCEPT);
    (await slow).fastAccepted();
    vi.advanceTimersByTime(100);
    const expired = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await expired;
  });

  it('is dropped by a write to a policy source or a change of the graph\'s subscription', async () => {
    const { agent, probe, pending, generation, subs } = fakeAgent();
    await accepted(agent, pending);
    generation.bump();
    const afterWrite = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    (await afterWrite).fastAccepted();
    subs.set(CG, { subscribed: true, synced: true });
    const afterSubscription = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(3);
    pending[2]!.resolve(ACCEPT);
    await afterSubscription;
  });

  it('serves only what the asking caller would fast-accept', async () => {
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    const stricter = probeWritePreflight(agent, CG, ALICE, { accepts: () => false });
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await stricter;
  });

  it('never serves one caller\'s entry to another, or one graph\'s to another', async () => {
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    const bob = call(agent, BOB);
    const otherGraph = call(agent, ALICE, OTHER_CG);
    const anonymous = call(agent, null);
    expect(probe).toHaveBeenCalledTimes(4);
    pending[1]!.resolve({ ...ACCEPT, callerAuthorized: false });
    pending[2]!.resolve({ ...ACCEPT, callerAuthorized: false });
    pending[3]!.resolve({ ...ACCEPT, callerAuthorized: undefined });
    expect((await bob).probe.callerAuthorized).toBe(false);
    expect((await otherGraph).probe.callerAuthorized).toBe(false);
    expect((await anonymous).probe.callerAuthorized).toBeUndefined();
  });

  it('keeps nothing unless the caller reports a fast accept: a negative answer is never kept', async () => {
    const { agent, probe, pending } = fakeAgent();
    const denied = call(agent, ALICE);
    pending[0]!.resolve({ ...ACCEPT, accessPolicy: 'private', callerAuthorized: false });
    await denied; // the caller denies and never calls fastAccepted
    const again = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await again;
  });

  it('keeps nothing from a probe that saw the store unavailable, however it is reported', async () => {
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending, ALICE, CG, { storeAvailable: false, storeUnavailable: true, storeErrorMessage: 'down', inMemorySubscription: { subscribed: true, synced: true } });
    await accepted(agent, pending, BOB, CG, { storeAvailable: true, storeUnavailable: true, exists: true, hasLocalContent: true, callerAuthorized: true });
    expect(probe).toHaveBeenCalledTimes(2);
    const aliceAgain = call(agent, ALICE);
    const bobAgain = call(agent, BOB);
    expect(probe).toHaveBeenCalledTimes(4);
    pending[2]!.resolve(ACCEPT);
    pending[3]!.resolve(ACCEPT);
    await Promise.all([aliceAgain, bobAgain]);
  });

  it('keeps nothing from a probe whose answer consulted the chain (an identity-ID allowlist entry)', async () => {
    const { agent, probe, pending } = fakeAgent();
    const chainBacked = call(agent, ALICE);
    pending[0]!.opts!.onChainLookup!();
    pending[0]!.resolve(ACCEPT);
    (await chainBacked).fastAccepted();
    const again = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    // A later probe that did not consult the chain is kept: the first one's flag was its own.
    (await again).fastAccepted();
    await call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing from a probe during which a policy write settled', async () => {
    const { agent, probe, pending, generation } = fakeAgent();
    const racing = call(agent, ALICE);
    generation.bump();
    pending[0]!.resolve(ACCEPT);
    (await racing).fastAccepted();
    const again = call(agent, ALICE);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await again;
  });

  it('is skipped by the second pass after a readiness wait, which probes anew', async () => {
    const { agent, probe, pending } = fakeAgent();
    await accepted(agent, pending);
    const afterWait = call(agent, ALICE, CG, true);
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve(ACCEPT);
    await afterWait;
  });

  it('forgets its oldest entries beyond the bound', async () => {
    const { agent, probe, pending } = fakeAgent();
    for (let i = 0; i <= WRITE_PREFLIGHT_CACHE_MAX_ENTRIES; i += 1) {
      await accepted(agent, pending, ALICE, `0x1111111111111111111111111111111111111111/graph-${i}`);
    }
    const probes = probe.mock.calls.length;
    await call(agent, ALICE, `0x1111111111111111111111111111111111111111/graph-${WRITE_PREFLIGHT_CACHE_MAX_ENTRIES}`);
    expect(probe).toHaveBeenCalledTimes(probes);
    const oldest = call(agent, ALICE, '0x1111111111111111111111111111111111111111/graph-0');
    expect(probe).toHaveBeenCalledTimes(probes + 1);
    pending[probes]!.resolve(ACCEPT);
    await oldest;
  });
});

describe('the switches', () => {
  const warnings = () => {
    const messages: string[] = [];
    return { messages, logger: { warn: (message: string) => { messages.push(message); } } };
  };

  it('defaults to coalescing on and the cache off', () => {
    expect(resolveWritePreflightCoalescingConfig({})).toEqual({ coalescing: true, cacheTtlMs: 0 });
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_COALESCING_ENV]: '  ' })).toEqual({ coalescing: true, cacheTtlMs: 0 });
  });

  it.each(['1', 'true', 'yes', 'on', 'ON'])('reads %s as on', (value) => {
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_COALESCING_ENV]: value }).coalescing).toBe(true);
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_CACHE_ENV]: value }).cacheTtlMs).toBe(WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS);
  });

  it.each(['0', 'false', 'no', 'off'])('reads %s as off', (value) => {
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_COALESCING_ENV]: value })).toEqual({ coalescing: false, cacheTtlMs: 0 });
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_CACHE_ENV]: value })).toEqual({ coalescing: true, cacheTtlMs: 0 });
  });

  it('turns a mistyped coalescing value off, with a warning, so a failed rollback never leaves it on', () => {
    const { messages, logger } = warnings();
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_COALESCING_ENV]: 'flase' }, logger)).toEqual({ coalescing: false, cacheTtlMs: 0 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(WRITE_PREFLIGHT_COALESCING_ENV);
    expect(messages[0]).toContain('"flase"');
  });

  it('keeps the cache off for a mistyped value, with a warning', () => {
    const { messages, logger } = warnings();
    expect(resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_CACHE_ENV]: 'maybe' }, logger)).toEqual({ coalescing: true, cacheTtlMs: 0 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(WRITE_PREFLIGHT_CACHE_ENV);
  });

  it('ignores the cache while coalescing is off, and says so', () => {
    const { messages, logger } = warnings();
    expect(resolveWritePreflightCoalescingConfig({
      [WRITE_PREFLIGHT_COALESCING_ENV]: 'off', [WRITE_PREFLIGHT_CACHE_ENV]: 'on',
    }, logger)).toEqual({ coalescing: false, cacheTtlMs: 0 });
    expect(messages).toEqual([expect.stringContaining('ignored while write preflight coalescing is off')]);
  });

  it('reads the TTL, clamps it to its range and falls back to the default when it is not a number', () => {
    const ttl = (value: string, logger?: { warn(message: string): void }) =>
      resolveWritePreflightCoalescingConfig({ [WRITE_PREFLIGHT_CACHE_ENV]: '1', [WRITE_PREFLIGHT_CACHE_TTL_ENV]: value }, logger).cacheTtlMs;
    expect(ttl('750')).toBe(750);
    const tooSmall = warnings();
    expect(ttl('5', tooSmall.logger)).toBe(WRITE_PREFLIGHT_CACHE_MIN_TTL_MS);
    expect(tooSmall.messages).toHaveLength(1);
    const tooLarge = warnings();
    expect(ttl('600000', tooLarge.logger)).toBe(WRITE_PREFLIGHT_CACHE_MAX_TTL_MS);
    expect(tooLarge.messages).toHaveLength(1);
    for (const bad of ['soon', '-5', '1.5', '1e3', '99999999999999999999']) {
      const { messages, logger } = warnings();
      expect(ttl(bad, logger)).toBe(WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS);
      expect(messages).toHaveLength(1);
    }
  });

  it('logs the effective setting once at start', () => {
    const info: string[] = [];
    configureWritePreflightCoalescing({ [WRITE_PREFLIGHT_CACHE_ENV]: '1', [WRITE_PREFLIGHT_CACHE_TTL_ENV]: '500' }, { info: (m) => info.push(m), warn: () => {} });
    expect(getWritePreflightCoalescingConfig()).toEqual({ coalescing: true, cacheTtlMs: 500 });
    expect(info).toEqual([expect.stringContaining('coalescing: on, result cache: on (500 ms)')]);
    configureWritePreflightCoalescing({ [WRITE_PREFLIGHT_COALESCING_ENV]: '0' }, { info: (m) => info.push(m), warn: () => {} });
    expect(info[1]).toContain('coalescing: off, result cache: off');
  });
});

describe('the re-resolve after a readiness wait', () => {
  const SCOPED = { callerAgentAddress: ALICE, allowLocalExactFallback: false } as const;
  const ready = { getSubscribedContextGraphs: () => new Map([[CG, { subscribed: true, synced: true }]]) };

  it('is told that it follows a wait; the first pass is not', async () => {
    const passes: boolean[] = [];
    const resolved = await resolveAwaitingWriteReadiness(ready, async (afterWait) => {
      passes.push(afterWait);
      return passes.length === 1 ? { notWritable: CG, raw: CG } : CG;
    }, () => null);
    expect(resolved).toBe(CG);
    expect(passes).toEqual([false, true]);
  });

  it('probes anew instead of joining a probe another request began before the wait ended', async () => {
    const NOT_WRITABLE: Probe = {
      storeAvailable: true, exists: true, hasLocalContent: false, declarationFound: true, accessPolicy: 'public',
      callerAuthorized: true, inMemorySubscription: { subscribed: true, synced: false },
    };
    const WRITABLE: Probe = { ...NOT_WRITABLE, hasLocalContent: true };
    let probes = 0;
    let finishOther!: () => void;
    let other: Promise<unknown> | undefined;
    const provider: any = {
      listContextGraphs: async () => [],
      // Nothing the stamp sees moves, so a probe in flight stays joinable: only the re-resolve's own rule keeps it apart.
      writePreflightIdentity: () => ({ key: 'one-key', stamp: 'one-stamp' }),
      probeContextGraphWritePreflight: vi.fn(() => {
        probes += 1;
        if (probes === 1) return Promise.resolve(NOT_WRITABLE);
        // The other request's probe: it began before the wait ended, and it ends only when the test says.
        if (probes === 2) return new Promise<Probe>((resolve) => { finishOther = () => resolve(NOT_WRITABLE); });
        return Promise.resolve(WRITABLE);
      }),
      getSubscribedContextGraphs: () => {
        // The wait first looks at the registry once the first pass is over. Another request has meanwhile begun
        // its own probe of the same graph for the same caller.
        other ??= probeWritePreflight(provider, CG, ALICE, { accepts: fastAccepts });
        return ready.getSubscribedContextGraphs();
      },
    };
    const out: { status?: number } = {};
    const res = { writeHead(status: number) { out.status = status; return res; }, end() {} } as unknown as ServerResponse;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the re-resolve is waiting on the other request\'s probe')), 5_000);
    });
    const resolved = await Promise.race([resolveRequiredWriteContextGraphId(provider, CG, res, SCOPED), timeout])
      .finally(() => clearTimeout(timer));
    expect(resolved).toBe(CG);
    expect(out.status).toBeUndefined();
    // Its own probe, started after the wait, answered it while the other request's was still open.
    expect(probes).toBe(3);
    finishOther();
    await other;
  });
});
