import { SubscriptionRecoveryCoordinator } from '../src/subscription-recovery-owner.js';
import { recoverDeferredContextGraphSubscriptionAuthorities as recoverRows } from '../src/context-graph-subscription-authority-recovery.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NAME_BINDING_RETRY_WINDOW_MS,
  PersistedSubscriptionNameBindingRetry,
  isChainNameBindingUnavailable,
  type NameBindingRetryPorts,
} from '../src/context-graph-subscription-name-binding-retry.js';
import { SubscriptionActivationCapacityError } from '../src/context-graph-subscription-activation-capacity.js';
import { recoverDeferredContextGraphSubscriptionAuthorities } from './_helpers/deferred-authority-recovery.js';
import type { ContextGraphDormancyReason } from '../src/context-graph-subscription-dormancy.js';
import type { ContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

/**
 * A saved row the startup pass left dormant because its graph's chain name
 * binding could not be read is asked again within seconds, on its own, until
 * the lookup answers. Every timer is faked: the times below are the node's own.
 */

const CHECK_TIMEOUT_MS = 20_000;

const ALLOWED = (onChainId?: bigint): ContextGraphReadAuthorityDecision => ({
  outcome: 'allowed', grantScope: 'public', source: 'registered-chain',
  reason: 'open-context-graph', metadataBootstrap: 'forbidden',
  ...(onChainId === undefined ? {} : { onChainId }),
});
const NO_NAME_BINDING: ContextGraphReadAuthorityDecision = {
  outcome: 'unavailable', source: 'registered-chain', reason: 'chain-name-binding-unavailable',
  metadataBootstrap: 'eligible', dependency: 'chain',
};
const DENIED: ContextGraphReadAuthorityDecision = {
  outcome: 'denied', grantScope: 'none', source: 'registered-chain',
  reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden',
};
const CHAIN_UNKNOWN: ContextGraphReadAuthorityDecision = {
  outcome: 'unavailable', source: 'registered-chain', reason: 'chain-access-policy-unknown',
  metadataBootstrap: 'forbidden', dependency: 'chain',
};

type Answer = ContextGraphReadAuthorityDecision | ((signal: AbortSignal) => Promise<ContextGraphReadAuthorityDecision>);

function row(id: string, extra: Partial<ContextGraphSubscriptionRecord> = {}): ContextGraphSubscriptionRecord {
  return { id, subscribed: true, synced: true, syncScoped: true, ...extra };
}

function host(rows: ContextGraphSubscriptionRecord[], options: {
  /** Answers per row, in order; the last one repeats. */
  answers?: Record<string, Answer[]>;
  capHasRoom?: boolean;
} = {}) {
  const saved = new Map(rows.map((r) => [r.id, { ...r }]));
  const dormancy = new Map<string, ContextGraphDormancyReason>(rows.map((r) => [r.id, 'authorityUnavailable']));
  const revisions = new Map<string, number>();
  const subscriptions = new Map<string, ContextGraphSub>();
  const answers = new Map(Object.entries(options.answers ?? {}).map(([id, list]) => [id, [...list]]));
  const controller = new AbortController();
  const startedAt = Date.now();
  const checks: Array<{ id: string; at: number }> = [];
  const activations: Array<{ id: string; onChainId: string | undefined; at: number }> = [];
  const retired: Array<{ id: string; reason: ContextGraphDormancyReason }> = [];
  const capped: string[] = [];
  const info: string[] = [];
  const warn: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const state = { current: true, capHasRoom: options.capHasRoom ?? true };
  const ports: NameBindingRetryPorts = {
    recovery: new SubscriptionRecoveryCoordinator(),
    signal: controller.signal,
    isCurrent: () => state.current,
    dormancy: (id) => dormancy.get(id),
    revision: (id) => revisions.get(id) ?? 0,
    subscription: (id) => subscriptions.get(id),
    load: async (id) => {
      const r = saved.get(id);
      return r === undefined ? null : { ...r };
    },
    resolveAuthority: async (r, signal) => {
      checks.push({ id: r.id, at: Date.now() - startedAt });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const list = answers.get(r.id) ?? [];
        const next = list.length > 1 ? list.shift()! : list[0] ?? ALLOWED();
        return await (typeof next === 'function' ? next(signal) : next);
      } finally {
        inFlight -= 1;
      }
    },
    clear: id => { dormancy.delete(id); },
    capped: (id) => {
      dormancy.set(id, 'activationCap');
      capped.push(id);
    },
    activate: async (r, onChainId, isCurrent) => {
      if (r.coreHosted !== true && !state.capHasRoom) throw new SubscriptionActivationCapacityError();
      if (!isCurrent()) throw new Error('stale');
      subscriptions.set(r.id, { syncMode: 'always-on', subscribed: r.subscribed, synced: r.synced, onChainId });
      saved.set(r.id, { ...r, ...(onChainId === undefined ? {} : { onChainId }) });
      dormancy.delete(r.id);
      activations.push({ id: r.id, onChainId, at: Date.now() - startedAt });
    },
    retire: (id, reason) => {
      dormancy.set(id, reason);
      retired.push({ id, reason });
    },
    track: () => undefined,
    log: {
      info: (message) => { info.push(message); },
      warn: (message) => { warn.push(message); },
    },
  };
  return {
    ports, saved, dormancy, revisions, subscriptions, checks, activations, retired, capped, info, warn,
    controller, state, maxInFlight: () => maxInFlight,
    retry: (opts: { maxRows?: number } = {}) => new PersistedSubscriptionNameBindingRetry(ports, {
      checkTimeoutMs: CHECK_TIMEOUT_MS, ...opts,
    }),
  };
}

/** A read that answers only when the test says so (or when its signal ends it, if it listens). */
function pending(listen = true) {
  let answer!: (decision: ContextGraphReadAuthorityDecision) => void;
  const read = (signal: AbortSignal) => new Promise<ContextGraphReadAuthorityDecision>((resolve, reject) => {
    answer = resolve;
    if (listen) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { read, answer: (decision: ContextGraphReadAuthorityDecision) => answer(decision) };
}

describe('asking again for a row left dormant without its chain name binding', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a cancellation-aware legacy lookup finish after 30 seconds within the recovery deadline', async () => {
    let aborted = false;
    const h = host([row('slow-legacy')], { answers: { 'slow-legacy': [signal => new Promise((resolve, reject) => {
      const onAbort = () => { aborted = true; clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(ALLOWED(77n)); }, 30_000);
      signal.addEventListener('abort', onAbort, { once: true });
    })] } });
    const retry = new PersistedSubscriptionNameBindingRetry(h.ports);
    retry.take(['slow-legacy']);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(aborted).toBe(false);
    expect(h.activations).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_999);
    await retry.whenIdle();
    expect(h.checks).toEqual([{ id: 'slow-legacy', at: 0 }]);
    expect(h.activations).toEqual([{ id: 'slow-legacy', onChainId: '77', at: 30_000 }]);
    expect(aborted).toBe(false);
  });

  it('preserves the original activation error and cause through periodic recovery', async () => {
    const saved = row('failed-activation', { onChainId: '7' }), h = host([saved]);
    const error = new Error('disk write failed', { cause: new Error('device unavailable') });
    h.ports.activate = async () => { throw error; };
    const warn = vi.fn();
    await recoverRows(h.controller.signal, {
      store: { load: h.ports.load, loadAll: async () => [saved], save: async () => {}, delete: async () => {} },
      dormancyById: h.dormancy, row: h.ports, warn,
      getStatus: () => ({ rehydrationEnabled: true, systemExcluded: 0, activationCap: 64, persistedTotal: 1,
        activated: 0, hostedActivated: 0, hostedActivatedIds: [], capDisabled: false, completedAt: 1, updatedAt: 1 }),
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][1]).toBe(error);
    expect(h.dormancy.get(saved.id)).toBe('authorityUnavailable');
  });

  it('retries only the startup answer that says the name binding could not be read', () => {
    expect(isChainNameBindingUnavailable(NO_NAME_BINDING)).toBe(true);
    expect(isChainNameBindingUnavailable(CHAIN_UNKNOWN)).toBe(false);
    expect(isChainNameBindingUnavailable(DENIED)).toBe(false);
    expect(isChainNameBindingUnavailable({ outcome: 'denied', reason: 'chain-name-binding-unavailable' })).toBe(false);
  });

  it('asks a taken row again at once, then 1 s later, and activates it once its lookup answers', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [NO_NAME_BINDING, ALLOWED(77n)] } });
    const retry = h.retry();

    expect(retry.take(['public-graph'])).toEqual(['public-graph']);
    expect(retry.holds('public-graph')).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.checks).toEqual([{ id: 'public-graph', at: 0 }]);
    await vi.advanceTimersByTimeAsync(1);
    await retry.whenIdle();

    expect(h.checks).toEqual([{ id: 'public-graph', at: 0 }, { id: 'public-graph', at: 1_000 }]);
    expect(h.activations).toEqual([{ id: 'public-graph', onChainId: '77', at: 1_000 }]);
    expect(h.dormancy.has('public-graph')).toBe(false);
    expect(retry.holds('public-graph')).toBe(false);
    expect(h.info).toContain(
      'Activated persisted context-graph subscription "public-graph" 1000 ms after its chain name binding could not be read at start (2 check(s))',
    );
  });

  it('keeps the saved binding when the answer names none', async () => {
    const h = host([row('bound-graph', { onChainId: '12' })], { answers: { 'bound-graph': [ALLOWED()] } });
    const retry = h.retry();

    retry.take(['bound-graph']);
    await retry.whenIdle();

    expect(h.activations).toEqual([{ id: 'bound-graph', onChainId: '12', at: 0 }]);
  });

  it('waits 1, 2, 4, 8 and then 10 s after each unanswered check', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [NO_NAME_BINDING] } });
    const retry = h.retry();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(h.checks.map((check) => check.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 25_000, 35_000, 45_000]);
    expect(h.activations).toEqual([]);
    expect(h.dormancy.get('public-graph')).toBe('authorityUnavailable');
    expect(retry.holds('public-graph')).toBe(true);
    h.controller.abort();
    await retry.whenIdle();
  });

  it('activates the row at the first check after its lookup answers again', async () => {
    const h = host([row('public-graph')], {
      answers: { 'public-graph': [NO_NAME_BINDING, NO_NAME_BINDING, NO_NAME_BINDING, NO_NAME_BINDING, ALLOWED(77n)] },
    });
    const retry = h.retry();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(15_000);
    await retry.whenIdle();

    expect(h.checks.map((check) => check.at)).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    expect(h.activations).toEqual([{ id: 'public-graph', onChainId: '77', at: 15_000 }]);
    expect(h.info.join('\n')).toContain('15000 ms after its chain name binding could not be read at start (5 check(s))');
  });

  it('leaves the row to background recovery after ten minutes', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [NO_NAME_BINDING] } });
    const retry = h.retry();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(NAME_BINDING_RETRY_WINDOW_MS + 10_000);
    await retry.whenIdle();

    expect(retry.holds('public-graph')).toBe(false);
    expect(h.dormancy.get('public-graph')).toBe('authorityUnavailable');
    // 0, 1, 3, 7, 15 s, then every 10 s up to the ten minutes.
    expect(h.checks).toHaveLength(5 + Math.floor((NAME_BINDING_RETRY_WINDOW_MS - 15_000) / 10_000));
    expect(h.checks.at(-1)!.at).toBeLessThan(NAME_BINDING_RETRY_WINDOW_MS);
    expect(h.info.at(-1)).toMatch(
      /^Persisted context-graph subscription "public-graph" is still dormant 60\d s after its chain name binding could not be read \(\d+ check\(s\), last: unavailable by registered-chain \(chain-name-binding-unavailable\)\); background authority recovery keeps asking$/,
    );
  });

  it('cuts a pause to 1 s after the last check when the authority source answers again, at most every other check', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [NO_NAME_BINDING] } });
    const retry = h.retry();
    const at = () => h.checks.map((check) => check.at);

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(7_200); // checks at 0, 1, 3 and 7 s; the next is due at 15 s
    retry.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(at()).toEqual([0, 1_000, 3_000, 7_000]);
    await vi.advanceTimersByTimeAsync(800);
    expect(at()).toEqual([0, 1_000, 3_000, 7_000, 8_000]);

    // That woken check went unanswered: the pause after it (10 s, due at
    // 18 s) is neither reset nor cut, however many wake-ups come.
    await vi.advanceTimersByTimeAsync(300);
    retry.wake();
    retry.wake();
    await vi.advanceTimersByTimeAsync(4_000);
    retry.wake();
    await vi.advanceTimersByTimeAsync(5_700);
    expect(at()).toEqual([0, 1_000, 3_000, 7_000, 8_000, 18_000]);

    // The pause after a scheduled check may be cut again.
    await vi.advanceTimersByTimeAsync(500);
    retry.wake();
    retry.wake();
    await vi.advanceTimersByTimeAsync(500);
    expect(at()).toEqual([0, 1_000, 3_000, 7_000, 8_000, 18_000, 19_000]);
    h.controller.abort();
    await retry.whenIdle();
  });

  it('asks the other rows soon after one row is answered', async () => {
    const h = host([row('a-first'), row('b-second')], {
      answers: {
        'a-first': [NO_NAME_BINDING, NO_NAME_BINDING, NO_NAME_BINDING, ALLOWED(1n)],
        'b-second': [NO_NAME_BINDING, NO_NAME_BINDING, NO_NAME_BINDING, ALLOWED(2n)],
      },
    });
    const retry = h.retry();

    retry.take(['a-first']); // checks at 0, 1, 3 and 7 s
    await vi.advanceTimersByTimeAsync(2_000);
    retry.take(['b-second']); // checks at 2, 3 and 5 s; then due at 9 s
    await vi.advanceTimersByTimeAsync(5_000);
    await retry.whenIdle();

    // a is answered at 7 s, and b is asked at once instead of at 9 s.
    expect(h.checks.filter((check) => check.id === 'b-second').map((check) => check.at))
      .toEqual([2_000, 3_000, 5_000, 7_000]);
    expect(h.activations.map((activation) => [activation.id, activation.at]))
      .toEqual([['a-first', 7_000], ['b-second', 7_000]]);
  });

  it('runs two checks at a time, one per row, and a pausing row holds no slot', async () => {
    const reads = new Map<string, ReturnType<typeof pending>>();
    const slow = (id: string): Answer => (signal) => {
      const read = pending();
      reads.set(id, read);
      return read.read(signal);
    };
    const h = host([row('a'), row('b'), row('c')], {
      answers: { a: [slow('a')], b: [slow('b')], c: [slow('c')] },
    });
    const retry = h.retry();

    retry.take(['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.checks.map((check) => check.id)).toEqual(['a', 'b']);
    reads.get('a')!.answer(NO_NAME_BINDING);
    await vi.advanceTimersByTimeAsync(0);
    // a's slot went to c, which was waiting; a now pauses without one.
    expect(h.checks.map((check) => check.id)).toEqual(['a', 'b', 'c']);
    expect(h.maxInFlight()).toBe(2);
    h.controller.abort();
    await retry.whenIdle();
  });

  it('gives up a check at its own deadline, also one whose read never ends', async () => {
    const h = host([row('a'), row('b')], {
      answers: {
        a: [(signal) => pending(true).read(signal), ALLOWED(1n)],
        b: [() => pending(false).read(new AbortController().signal), ALLOWED(2n)],
      },
    });
    const retry = h.retry();

    retry.take(['a', 'b']);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(h.activations).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await retry.whenIdle();
    expect(h.checks.map((check) => [check.id, check.at])).toEqual([
      ['a', 0], ['b', 0], ['a', 21_000], ['b', 21_000],
    ]);
    expect(h.activations.map((activation) => activation.id)).toEqual(['a', 'b']);
  });

  it('releases queued rows at their original window without starting late checks', async () => {
    const h = host([row('a'), row('b'), row('c')], {
      answers: { a: [() => new Promise(() => {})], b: [() => new Promise(() => {})] },
    });
    const retry = new PersistedSubscriptionNameBindingRetry(h.ports, {
      checkTimeoutMs: CHECK_TIMEOUT_MS, windowMs: 50, maxConcurrent: 2,
    });
    retry.take(['a', 'b', 'c']);
    await vi.advanceTimersByTimeAsync(50);
    await retry.whenIdle();
    expect(h.checks.map(check => check.id)).toEqual(['a', 'b']);
    expect(retry.size).toBe(0);
    expect(h.activations).toEqual([]);
    expect([...h.dormancy.values()]).toEqual(['authorityUnavailable', 'authorityUnavailable', 'authorityUnavailable']);
  });

  it('records a denial and a graph the chain does not know as final', async () => {
    const h = host([row('denied'), row('unknown')], {
      answers: { denied: [DENIED], unknown: [CHAIN_UNKNOWN] },
    });
    const retry = h.retry();

    retry.take(['denied', 'unknown']);
    await vi.advanceTimersByTimeAsync(1_000);
    await retry.whenIdle();

    expect(h.retired).toEqual([
      { id: 'denied', reason: 'authorityDenied' },
      { id: 'unknown', reason: 'deactivated' },
    ]);
    expect(h.checks).toHaveLength(2);
    expect(h.activations).toEqual([]);
  });

  it('warns once when the activation keeps failing the same way, and activates at a later check', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [ALLOWED(77n)] } });
    const activate = h.ports.activate;
    let failures = 2;
    h.ports.activate = async (r, onChainId, isCurrent) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('store write failed');
      }
      return activate(r, onChainId, isCurrent);
    };
    const retry = h.retry();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(3_000);
    await retry.whenIdle();

    expect(h.checks.map((check) => check.at)).toEqual([0, 1_000, 3_000]);
    expect(h.activations).toEqual([{ id: 'public-graph', onChainId: '77', at: 3_000 }]);
    expect(h.warn).toEqual([
      'Could not activate persisted context-graph subscription "public-graph" after its chain name binding ' +
        'answered: store write failed; asking again',
    ]);
  });

  it('hands an allowed user row to rolling activation when the cap is full, but not a hosted one', async () => {
    const h = host([row('user'), row('hosted', { subscribed: false, coreHosted: true, onChainId: '5' })], {
      capHasRoom: false,
    });
    const retry = h.retry();

    retry.take(['user', 'hosted']);
    await vi.advanceTimersByTimeAsync(1_000);
    await retry.whenIdle();

    expect(h.capped).toEqual(['user']);
    expect(h.dormancy.get('user')).toBe('activationCap');
    expect(h.activations.map((activation) => activation.id)).toEqual(['hosted']);
  });

  it('asks again without growing the pause when the row moved under the check', async () => {
    const h = host([row('public-graph')]);
    h.ports.resolveAuthority = async (r) => {
      h.checks.push({ id: r.id, at: Date.now() });
      if (h.checks.length === 1) h.revisions.set(r.id, 1); // re-saved while the read was out
      return ALLOWED(77n);
    };
    const retry = h.retry();
    const startedAt = Date.now();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(1_000);
    await retry.whenIdle();

    expect(h.checks.map((check) => check.at - startedAt)).toEqual([0, 1_000]);
    expect(h.activations).toHaveLength(1);
  });

  it('stops for a row another owner activated or the operator removed', async () => {
    const h = host([row('activated'), row('removed')], { answers: { activated: [NO_NAME_BINDING] } });
    const retry = h.retry();

    retry.take(['activated', 'removed']);
    h.saved.delete('removed');
    await vi.advanceTimersByTimeAsync(0); // activated: one unanswered check
    h.dormancy.delete('activated');
    await vi.advanceTimersByTimeAsync(10_000);
    await retry.whenIdle();

    expect(h.checks.map((check) => check.id)).toEqual(['activated']);
    expect(h.activations).toEqual([]);
    expect(retry.size).toBe(0);
  });

  it('takes only rows that are still unavailable, each once, up to its limit', async () => {
    const h = host([row('a'), row('b'), row('c'), row('capped')]);
    h.dormancy.set('capped', 'activationCap');
    const retry = h.retry({ maxRows: 2 });

    expect(retry.take(['capped', 'a', 'a', 'b', 'c', 'missing'])).toEqual(['a', 'b']);
    expect(retry.size).toBe(2);
    h.controller.abort();
    await retry.whenIdle();
  });

  it('stops asking when the node stops', async () => {
    const h = host([row('public-graph')], { answers: { 'public-graph': [NO_NAME_BINDING] } });
    const retry = h.retry();

    retry.take(['public-graph']);
    await vi.advanceTimersByTimeAsync(1_000); // checks at 0 and 1 s
    h.controller.abort();
    await retry.whenIdle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.checks).toHaveLength(2);
    expect(retry.holds('public-graph')).toBe(false);
    expect(retry.take(['public-graph'])).toEqual([]);
    expect(h.warn).toEqual([]);
  });
});

describe('background recovery and the name-binding retry', () => {
  it('leaves a row the retry holds alone, and asks the others as before', async () => {
    const rows = new Map<string, ContextGraphSubscriptionRecord>([
      ['held', row('held')],
      ['other', row('other', { onChainId: '9' })],
    ]);
    const dormancy = new Map<string, ContextGraphDormancyReason>([
      ['held', 'authorityUnavailable'],
      ['other', 'authorityUnavailable'],
    ]);
    const recovery = new SubscriptionRecoveryCoordinator();
    recovery.claim('held', 1, new AbortController().signal);
    const loaded: string[] = [];
    const resolved: string[] = [];
    const activated: string[] = [];
    await recoverDeferredContextGraphSubscriptionAuthorities(new AbortController().signal, {
      store: {
        loadAll: async () => [...rows.values()],
        load: async (id) => { loaded.push(id); return rows.get(id) ?? null; },
        save: async () => undefined,
        delete: async () => undefined,
      },
      dormancyById: dormancy,
      persistRevisions: new Map(),
      subscriptions: new Map(),
      getStatus: () => ({
        rehydrationEnabled: true, systemExcluded: 0, activationCap: 64, persistedTotal: 2, activated: 0,
        hostedActivated: 0, hostedActivatedIds: [], capDisabled: false, completedAt: 1, updatedAt: 1,
      }),
      isCurrent: () => true,
      transitionDormancy: (id, reason) => { if (reason === undefined) dormancy.delete(id); else dormancy.set(id, reason); },
      touchStatus: () => undefined,
      clearStatus: () => undefined,
      resolveAuthority: async (r) => { resolved.push(r.id); return ALLOWED(9n); },
      activate: async (r) => { activated.push(r.id); dormancy.delete(r.id); },
      warn: () => undefined,
      capped: () => undefined,
      recovery,
    });

    expect(loaded).not.toContain('held');
    expect(resolved).toEqual(['other']);
    expect(activated).toEqual(['other']);
    expect(dormancy.get('held')).toBe('authorityUnavailable');
  });
});
