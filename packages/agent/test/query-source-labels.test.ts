import { describe, expect, it, vi } from 'vitest';
import {
  GraphManager,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { QueryMethods } from '../src/dkg-agent-query.js';

describe('query caller-provided store labels', () => {
  it('attributes the unscoped private-graph access-policy lookup', async () => {
    const query = vi.fn<TripleStore['query']>(async () => ({
      type: 'bindings',
      bindings: [],
    }));
    const store = { query } as unknown as TripleStore;

    await expect(
      QueryMethods.prototype.getDisallowedGraphPrefixes.call(
        { store } as never,
      ),
    ).resolves.toEqual([]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.source).toBe(
      'agent.query.privateGraphAccessPolicy',
    );
  });

  it('forwards caller attribution through context-graph enumeration', async () => {
    const listGraphsByPrefix = vi.fn(async () => []);
    const store = {
      listGraphsByPrefix,
    } as unknown as TripleStore;

    await expect(
      new GraphManager(store).listContextGraphs({
        source: 'agent.swmHostMode.listContextGraphs',
      }),
    ).resolves.toEqual([]);

    expect(listGraphsByPrefix).toHaveBeenCalledWith(
      'did:dkg:context-graph:',
      { source: 'agent.swmHostMode.listContextGraphs' },
    );
  });
});
