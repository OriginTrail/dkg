import { describe, expect, it } from 'vitest';
import type { ContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import {
  isUnansweredChainReadAuthorityDecision,
  reportUnansweredReadAuthorityDecision,
  reportUnansweredRegisteredAuthority,
  UnansweredAuthorityObservation,
} from '../src/internal/context-graph-authority/unanswered-authority-read.js';
import { isUnansweredVmReconcileReadAuthority } from '../src/internal/vm-reconcile-read-authority.js';
import type { RegisteredContextGraphAuthority } from '../src/registered-context-graph-authority.js';

const GRAPH = 'graph-under-check';

const unavailable = (
  reason: string,
  dependency: 'chain' | 'store' | 'local-state' | 'unknown' = 'chain',
): ContextGraphReadAuthorityDecision => ({
  outcome: 'unavailable', source: 'registered-chain', reason, dependency,
} as ContextGraphReadAuthorityDecision);
const settled = (outcome: 'allowed' | 'denied'): ContextGraphReadAuthorityDecision => ({
  outcome, source: 'registered-chain', reason: 'registered-public',
} as ContextGraphReadAuthorityDecision);

const UNANSWERED_REASONS = [
  'chain-access-policy-timeout',
  'chain-access-policy-unavailable',
  'chain-participant-authority-unavailable',
] as const;

describe('isUnansweredChainReadAuthorityDecision', () => {
  it.each(UNANSWERED_REASONS)('takes %s on the chain for no answer', (reason) => {
    expect(isUnansweredChainReadAuthorityDecision(unavailable(reason))).toBe(true);
    expect(isUnansweredVmReconcileReadAuthority(unavailable(reason))).toBe(true);
  });

  it.each([
    ['an answer the chain gave', unavailable('chain-access-policy-unknown')],
    ['an open authority circuit', unavailable('authority-circuit-open')],
    ['a store that could not answer', unavailable('chain-access-policy-timeout', 'store')],
    ['a refusal', settled('denied')],
    ['a grant', settled('allowed')],
    ['no decision', undefined],
  ])('does not take %s for no answer', (_name, decision) => {
    expect(isUnansweredChainReadAuthorityDecision(decision)).toBe(false);
    expect(isUnansweredVmReconcileReadAuthority(decision)).toBe(false);
  });
});

describe('UnansweredAuthorityObservation', () => {
  it('returns what the check returns and names the read that got no answer', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await expect(observation.run(async () => {
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
      return false;
    })).resolves.toBe(false);
    expect(observation.unanswered).toBe('registered-chain/chain-access-policy-timeout/chain');
  });

  it('hands back the check\'s own promise, so awaiting through it takes no extra turn', () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    const checked = Promise.resolve(true);
    expect(observation.run(() => checked)).toBe(checked);
    // A check that is not asynchronous stays what it is.
    expect(observation.run(() => 7)).toBe(7);
  });

  it('reports nothing when every read was answered', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await observation.run(async () => {
      reportUnansweredReadAuthorityDecision(GRAPH, settled('denied'));
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-unknown'));
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout', 'store'));
    });
    expect(observation.unanswered).toBeUndefined();
  });

  it('keeps the first unanswered read of the check', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await observation.run(async () => {
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-unavailable'));
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
    });
    expect(observation.unanswered).toBe('registered-chain/chain-access-policy-unavailable/chain');
  });

  it('follows the check across awaits', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await observation.run(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
    });
    expect(observation.unanswered).toBeDefined();
  });

  it('ignores a read of another graph', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await observation.run(async () => {
      reportUnansweredReadAuthorityDecision('another-graph', unavailable('chain-access-policy-timeout'));
    });
    expect(observation.unanswered).toBeUndefined();
  });

  it('gives the inner of two nested observations the reads made inside it', async () => {
    const outer = new UnansweredAuthorityObservation(GRAPH);
    const inner = new UnansweredAuthorityObservation(GRAPH);
    await outer.run(() => inner.run(async () => {
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
    }));
    expect(inner.unanswered).toBe('registered-chain/chain-access-policy-timeout/chain');
    expect(outer.unanswered).toBeUndefined();
  });

  it('passes on what the check throws', async () => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await expect(observation.run(async () => {
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
      throw new Error('check failed');
    })).rejects.toThrow('check failed');
  });

  it('lets a report outside any observation go nowhere', () => {
    expect(() => {
      reportUnansweredReadAuthorityDecision(GRAPH, unavailable('chain-access-policy-timeout'));
      reportUnansweredRegisteredAuthority(GRAPH, {
        kind: 'unavailable', reason: 'chain-access-policy-timeout', onChainId: 1n,
      });
    }).not.toThrow();
  });
});

describe('reportUnansweredRegisteredAuthority', () => {
  const observe = async (authority: RegisteredContextGraphAuthority) => {
    const observation = new UnansweredAuthorityObservation(GRAPH);
    await observation.run(async () => { reportUnansweredRegisteredAuthority(GRAPH, authority); });
    return observation.unanswered;
  };

  it.each(UNANSWERED_REASONS)('reports %s', async (reason) => {
    const authority = reason === 'chain-access-policy-timeout'
      ? { kind: 'unavailable' as const, reason, onChainId: 1n }
      : { kind: 'unavailable' as const, reason };
    await expect(observe(authority)).resolves.toBe(`registered-authority/${reason}/chain`);
  });

  it.each<[string, RegisteredContextGraphAuthority]>([
    ['a private roster', { kind: 'private', onChainId: 1n, participantAgents: [] }],
    ['a public registration', { kind: 'public', onChainId: 1n }],
    ['an unregistered graph', { kind: 'unregistered' }],
    ['an answer the chain gave', { kind: 'unavailable', reason: 'chain-access-policy-unknown', onChainId: 1n }],
    ['an open authority circuit', { kind: 'unavailable', reason: 'authority-circuit-open' }],
    ['a local binding that could not be read', { kind: 'unavailable', reason: 'local-chain-binding-unavailable' }],
    [
      'a chain reason whose failed read was the store',
      { kind: 'unavailable', reason: 'chain-access-policy-unavailable', dependency: 'store' },
    ],
  ])('does not report %s', async (_name, authority) => {
    await expect(observe(authority)).resolves.toBeUndefined();
  });
});
