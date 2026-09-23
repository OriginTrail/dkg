import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { describe, expect, it } from 'vitest';
import { probeExternalStore } from '../src/daemon/store-reachability.js';

type ProbeAgent = Parameters<typeof probeExternalStore>[0];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function agentAnswering(query: (sparql: string) => Promise<unknown>): {
  agent: ProbeAgent;
  calls: Array<{ sparql: string; options: unknown }>;
} {
  const calls: Array<{ sparql: string; options: unknown }> = [];
  const store = {
    query: (sparql: string, options?: unknown) => {
      calls.push({ sparql, options });
      return query(sparql);
    },
  };
  return { agent: { store } as unknown as ProbeAgent, calls };
}

function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('probeExternalStore', () => {
  it.each([true, false])('reports a store that answers the ASK with %s as reachable', async (answer) => {
    const { agent, calls } = agentAnswering(async () => ({ type: 'boolean', value: answer }));

    await expect(probeExternalStore(agent)).resolves.toBe('reachable');
    // A health-lane ASK with no abort signal: abandoning a dispatched read
    // could make a managed Oxigraph restart itself.
    expect(calls).toEqual([{
      sparql: 'ASK { ?s ?p ?o }',
      options: { priority: 'health', source: 'daemon.status.storeProbe' },
    }]);
  });

  it('reports a store whose query fails as unreachable', async () => {
    const { agent } = agentAnswering(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7880');
    });

    await expect(probeExternalStore(agent)).resolves.toBe('unreachable');
  });

  it('reports a query that throws synchronously as unreachable instead of rejecting', async () => {
    const { agent } = agentAnswering(() => {
      throw new Error('store closed');
    });

    await expect(probeExternalStore(agent)).resolves.toBe('unreachable');
  });

  it.each(['queue_full', 'queue_wait_timeout'] as const)(
    'reports a probe the daemon store scheduler refused (%s) as no answer, not unreachable',
    async (reason) => {
      const { agent } = agentAnswering(async () => {
        throw new StoreSchedulerBusyError(reason, 'health', 'query');
      });

      await expect(probeExternalStore(agent)).resolves.toBe('no-answer');
    },
  );

  it('stops waiting without cancelling the probe, and shares it until it settles', async () => {
    const answer = deferred<unknown>();
    const { agent, calls } = agentAnswering(() => answer.promise);

    await expect(probeExternalStore(agent, 10)).resolves.toBe('no-answer');
    await expect(probeExternalStore(agent, 10)).resolves.toBe('no-answer');
    expect(calls).toHaveLength(1);

    answer.resolve({ type: 'boolean', value: true });
    await expect(probeExternalStore(agent, 10)).resolves.toBe('reachable');
    expect(calls).toHaveLength(1);

    // A settled probe is not reused: the next check asks the store again.
    await nextTick();
    await probeExternalStore(agent, 10);
    expect(calls).toHaveLength(2);
  });

  it('runs one probe for concurrent callers', async () => {
    const answer = deferred<unknown>();
    const { agent, calls } = agentAnswering(() => answer.promise);

    const results = Promise.all([probeExternalStore(agent), probeExternalStore(agent)]);
    answer.resolve({ type: 'boolean', value: true });

    await expect(results).resolves.toEqual(['reachable', 'reachable']);
    expect(calls).toHaveLength(1);
  });
});
