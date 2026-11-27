import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/dkg-agent-types.js';
import {
  partitionSupersededContextGraphNamePlaceholders,
} from '../src/dkg-agent-cg-name-resolution.js';

const CLEARTEXT = 'argus-vault';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT)).toLowerCase();
const MAX_SLOT = ((1n << 256n) - 1n).toString();
const OVERFLOW_SLOT = (1n << 256n).toString();

function persistedPair(
  placeholderSlot: string | undefined,
  cleartextSlot: string | undefined,
): ContextGraphSubscriptionRecord[] {
  return [
    {
      id: NAME_HASH,
      subscribed: true,
      synced: false,
      onChainHash: NAME_HASH,
      ...(placeholderSlot === undefined ? {} : { onChainId: placeholderSlot }),
      syncScoped: true,
    },
    {
      id: CLEARTEXT,
      subscribed: true,
      synced: false,
      onChainHash: NAME_HASH,
      ...(cleartextSlot === undefined ? {} : { onChainId: cleartextSlot }),
      syncScoped: false,
    },
  ];
}

type AliasMethods = Pick<DKGAgent,
  | 'recordPersistedContextGraphIdAliases'
  | 'resolveContextGraphIdAlias'
  | 'rewriteContextGraphSyncScopeAliases'
>;

/** Real composed alias methods, before dormant rows enter the live map. */
function aliasHarness() {
  return Object.assign(Object.create(DKGAgent.prototype) as AliasMethods, {
    subscribedContextGraphs: new Map<string, ContextGraphSub>(),
    wireIdToLocalCgId: new Map<string, string>(),
    config: { syncContextGraphs: [NAME_HASH] },
    log: { info: vi.fn() },
  });
}

function assertNotAdopted(rows: readonly ContextGraphSubscriptionRecord[]): void {
  const before = rows.map((row) => ({ ...row }));
  const agent = aliasHarness();
  agent.recordPersistedContextGraphIdAliases(rows);
  expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
  agent.rewriteContextGraphSyncScopeAliases();
  expect(agent.config.syncContextGraphs).toEqual([NAME_HASH]);

  const partition = partitionSupersededContextGraphNamePlaceholders(rows);
  expect(partition.superseded).toEqual([]);
  expect(partition.active).toEqual(rows);
  expect(rows).toEqual(before);
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function dormantRestart(rows: readonly ContextGraphSubscriptionRecord[]) {
  const retained = new Map(rows.map((row) => [row.id, { ...row }]));
  const deleted: string[] = [];
  const store: ContextGraphSubscriptionStore = {
    loadAll: async () => [...retained.values()].map((row) => ({ ...row })),
    save: async (row) => { retained.set(row.id, { ...row }); },
    delete: async (id) => { deleted.push(id); retained.delete(id); },
  };
  // Keep authority outside this identity test: the real restart path runs
  // aliases and cleanup, then a typed denial leaves every row dormant.
  // The agent is never started and no chain discovery is performed.
  const agent = await DKGAgent.create({
    name: 'PersistedAliasBinding',
    chainAdapter: new MockChainAdapter('mock:31337'),
    contextGraphSubscriptionStore: store,
    contextGraphSubscriptionRehydrationEnabled: true,
    syncContextGraphs: [NAME_HASH],
  });
  agents.push(agent);
  const authority = vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority')
    .mockResolvedValue({
      outcome: 'denied',
      source: 'registered-chain',
      reason: 'fixture-authority-denied',
      metadataBootstrap: 'forbidden',
    });
  await agent.rehydrateContextGraphSubscriptions(null);
  const state = agent as unknown as { config: { syncContextGraphs?: string[] } };
  return { agent, retained, deleted, authority, selection: state.config.syncContextGraphs };
}

describe('persisted aliases preserve the exact numeric Context Graph slot', () => {
  it.each(['placeholder-first', 'cleartext-first'] as const)(
    'does not alias or supersede saved slot323 with cleartext slot582 (%s)',
    (order) => {
      const rows = persistedPair('323', '582');
      assertNotAdopted(order === 'placeholder-first' ? rows : rows.reverse());
    },
  );

  it('does not delete the distinct-slot placeholder in the native restart path', async () => {
    const rows = persistedPair('323', '582');
    const { agent, retained, deleted, authority, selection } = await dormantRestart(rows);
    expect(authority).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual([]);
    expect([...retained.values()]).toEqual(rows);
    expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
    expect(selection).toEqual([NAME_HASH]);
  });

  it.each(['582', MAX_SLOT])(
    'retains verified equal-slot adoption for canonical slot%s',
    (slot) => {
      const rows = persistedPair(slot, slot);
      const agent = aliasHarness();
      agent.recordPersistedContextGraphIdAliases(rows);
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
      agent.rewriteContextGraphSyncScopeAliases();
      expect(agent.config.syncContextGraphs).toEqual([CLEARTEXT]);
      const partition = partitionSupersededContextGraphNamePlaceholders(rows);
      expect(partition.superseded).toEqual([rows[0]]);
      expect(partition.active).toEqual([rows[1]]);
    },
  );

  it('deletes only the equal-slot placeholder in the native restart path', async () => {
    const rows = persistedPair('582', '582');
    const { agent, retained, deleted, authority, selection } = await dormantRestart(rows);
    expect(authority).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual([NAME_HASH]);
    expect([...retained.values()]).toEqual([rows[1]]);
    expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    expect(selection).toEqual([CLEARTEXT]);
  });

  it.each([
    { label: 'missing placeholder slot', placeholder: undefined, cleartext: '582' },
    { label: 'missing cleartext slot', placeholder: '582', cleartext: undefined },
    { label: 'both slots missing', placeholder: undefined, cleartext: undefined },
    { label: 'zero slots', placeholder: '0', cleartext: '0' },
    { label: 'malformed slots', placeholder: 'not-a-slot', cleartext: 'not-a-slot' },
    { label: 'leading-zero slots', placeholder: '0582', cleartext: '0582' },
    { label: 'hex slots', placeholder: '0x246', cleartext: '0x246' },
    { label: 'negative slots', placeholder: '-1', cleartext: '-1' },
    { label: 'uint256 overflow', placeholder: OVERFLOW_SLOT, cleartext: OVERFLOW_SLOT },
  ])('does not adopt a bound/competing placeholder with $label', ({ placeholder, cleartext }) => {
    assertNotAdopted(persistedPair(placeholder, cleartext));
  });


  it.each([
    { label: 'different-slot', rows: persistedPair('323', '582') },
    { label: 'absent', rows: [] as ContextGraphSubscriptionRecord[] },
  ])('forgets an earlier equal-slot alias after a $label full snapshot', ({ rows }) => {
    const agent = aliasHarness();
    agent.recordPersistedContextGraphIdAliases(persistedPair('582', '582'));
    expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    agent.rewriteContextGraphSyncScopeAliases();
    expect(agent.config.syncContextGraphs).toEqual([CLEARTEXT]);

    // Re-select the saved hash against the new full durable snapshot. A prior
    // alias must not redirect this selection after its slot proof disappears.
    agent.config.syncContextGraphs = [NAME_HASH];
    agent.recordPersistedContextGraphIdAliases(rows);
    expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
    agent.rewriteContextGraphSyncScopeAliases();
    expect(agent.config.syncContextGraphs).toEqual([NAME_HASH]);
  });

  it.each(['wire-placeholder', 'hash-shaped-cleartext'] as const)(
    'keeps a live literal row ahead of persisted aliases (%s)',
    (kind) => {
      const agent = aliasHarness();
      agent.recordPersistedContextGraphIdAliases(persistedPair('582', '582'));
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);

      const literal: ContextGraphSub = {
        subscribed: true,
        synced: false,
        syncMode: 'always-on',
        onChainId: '323',
        onChainHash: kind === 'wire-placeholder'
          ? NAME_HASH
          : ethers.keccak256(ethers.toUtf8Bytes(NAME_HASH)).toLowerCase(),
      };
      agent.subscribedContextGraphs.set(NAME_HASH, literal);
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
      agent.rewriteContextGraphSyncScopeAliases();
      expect(agent.config.syncContextGraphs).toEqual([NAME_HASH]);

      agent.recordPersistedContextGraphIdAliases([]);
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
      expect(agent.subscribedContextGraphs.get(NAME_HASH)).toBe(literal);
      agent.subscribedContextGraphs.delete(NAME_HASH);
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBeNull();
    },
  );

  it.each(['lowercase-first', 'uppercase-first'] as const)(
    'does not alias or delete any case-folded placeholder when one owns a different slot (%s)',
    (order) => {
      const [lowercase, cleartext] = persistedPair('323', '582');
      const upperHash = `0x${NAME_HASH.slice(2).toUpperCase()}`;
      const uppercase = { ...lowercase, id: upperHash, onChainHash: upperHash, onChainId: '582' };
      const placeholders = order === 'lowercase-first' ? [lowercase, uppercase] : [uppercase, lowercase];
      assertNotAdopted([...placeholders, cleartext]);
    },
  );

  it.each(['lowercase-first', 'uppercase-first'] as const)(
    'retains equal-slot adoption and cleanup for every case-folded placeholder (%s)',
    (order) => {
      const [lowercase, cleartext] = persistedPair('582', '582');
      const upperHash = `0x${NAME_HASH.slice(2).toUpperCase()}`;
      const uppercase = { ...lowercase, id: upperHash, onChainHash: upperHash };
      const placeholders = order === 'lowercase-first' ? [lowercase, uppercase] : [uppercase, lowercase];
      const rows = [...placeholders, cleartext];
      const before = rows.map((row) => ({ ...row }));
      const agent = aliasHarness();

      agent.recordPersistedContextGraphIdAliases(rows);
      expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
      agent.rewriteContextGraphSyncScopeAliases();
      expect(agent.config.syncContextGraphs).toEqual([CLEARTEXT]);
      expect(partitionSupersededContextGraphNamePlaceholders(rows)).toEqual({
        active: [cleartext],
        superseded: placeholders,
      });
      expect(rows).toEqual(before);
    },
  );

  it('preserves a cleartext-only alias when no competing placeholder exists', () => {
    const [, cleartext] = persistedPair(undefined, '582');
    const agent = aliasHarness();
    agent.recordPersistedContextGraphIdAliases([cleartext]);
    expect(agent.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT);
    agent.rewriteContextGraphSyncScopeAliases();
    expect(agent.config.syncContextGraphs).toEqual([CLEARTEXT]);
    expect(partitionSupersededContextGraphNamePlaceholders([cleartext])).toEqual({
      active: [cleartext],
      superseded: [],
    });
  });
});
