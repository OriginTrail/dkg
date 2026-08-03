import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphRegistryMethods } from '../src/dkg-agent-cg-registry.js';

const LOCAL_ID = 'selected-public-cg';
const NAME_HASH = `0x${'ab'.repeat(32)}`;

function selectedFixture(resolved: bigint | null = 42n) {
  const query = vi.fn<TripleStore['query']>(async () => ({
    type: 'bindings',
    bindings: [],
  }));
  const resolveContextGraphIdByNameHash = vi.fn(async () => resolved);
  const bindOnChainContextGraphIdFromNameHash = vi.fn(() => LOCAL_ID);
  const subscription = {
    subscribed: true,
    synced: false,
    syncMode: 'always-on',
    onChainHash: NAME_HASH,
  };
  return {
    query,
    resolveContextGraphIdByNameHash,
    bindOnChainContextGraphIdFromNameHash,
    agent: {
      store: { query } as unknown as TripleStore,
      chain: { resolveContextGraphIdByNameHash },
      subscribedContextGraphs: new Map([[LOCAL_ID, subscription]]),
      contextGraphWireId: (id: string) => id === LOCAL_ID ? NAME_HASH : id.toLowerCase(),
      contextGraphNameCommitment: (id: string) => id === LOCAL_ID ? NAME_HASH : id.toLowerCase(),
      localCgIdForWireId: (id: string) => id.toLowerCase() === NAME_HASH ? LOCAL_ID : id,
      bindOnChainContextGraphIdFromNameHash,
    },
  };
}

describe('cold historical Context Graph name binding', () => {
  it('resolves and binds an explicit cleartext selection without ontology data', async () => {
    const fixture = selectedFixture();
    const signal = new AbortController().signal;

    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        LOCAL_ID,
        { signal },
      ),
    ).resolves.toBe('42');

    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(
      NAME_HASH,
      { signal },
    );
    expect(fixture.bindOnChainContextGraphIdFromNameHash).toHaveBeenCalledWith(
      NAME_HASH,
      '42',
    );
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('uses the same binding for a selected wire-hash request', async () => {
    const fixture = selectedFixture();
    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        NAME_HASH,
      ),
    ).resolves.toBe('42');
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledWith(
      NAME_HASH,
    );
  });

  it('never lets an arbitrary unselected id trigger a historical chain scan', async () => {
    const fixture = selectedFixture();
    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        'unselected-remote-cg',
      ),
    ).resolves.toBeNull();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  it('does not let a passive non-admitted local record trigger a historical chain scan', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.get(LOCAL_ID)!.subscribed = false;
    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        LOCAL_ID,
      ),
    ).resolves.toBeNull();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });

  it('retains the legacy ontology fallback for a selected pre-name-hash miss', async () => {
    const fixture = selectedFixture(null);
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ id: '"7"' }],
    });
    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        LOCAL_ID,
      ),
    ).resolves.toBe('7');
    expect(fixture.bindOnChainContextGraphIdFromNameHash).not.toHaveBeenCalled();
  });

  it('propagates ambiguous or failed chain resolution instead of trusting local metadata', async () => {
    const fixture = selectedFixture();
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('ambiguous name hash'),
    );
    await expect(
      ContextGraphRegistryMethods.prototype.getContextGraphOnChainId.call(
        fixture.agent as never,
        LOCAL_ID,
      ),
    ).rejects.toThrow('ambiguous name hash');
    expect(fixture.query).not.toHaveBeenCalled();
  });
});
