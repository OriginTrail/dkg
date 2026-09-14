// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  CONTEXT_GRAPH_MEMBERSHIP_SOURCES,
  isContextGraphMembershipSource,
  type ContextGraphMembershipRecord,
} from '../src/dkg-agent-types.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  createLocalContextGraphOriginMembershipRecord,
  LocalContextGraphProvenance,
} from
  '../src/local-context-graph-provenance.js';
import {
  LOCAL_ID,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';
import { DKGAgent } from '../src/index.js';

type DurableMembershipRow = ContextGraphMembershipRecord & {
  firstSeenAt?: number;
  updatedAt: number;
};

function row(
  contextGraphId: string,
  input: Omit<ContextGraphMembershipRecord, 'contextGraphId' | 'principalId'>,
): DurableMembershipRow {
  return {
    contextGraphId,
    principalId: `did:test:${contextGraphId}`,
    ...input,
    updatedAt: 1,
  };
}

describe('LocalContextGraphProvenance durable restoration', () => {
  it('preserves zero-argument subscription rehydration for public callers', async () => {
    const loadAll = vi.fn(async () => [row('public-api-origin', {
      principalType: 'agent',
      status: 'active',
      source: 'local-create',
    })]);
    const agent = await DKGAgent.create({
      name: 'rehydration-public-api',
      chainAdapter: new NoChainAdapter(),
      contextGraphMembershipStore: {
        loadAll,
        upsert: async () => undefined,
        delete: async () => undefined,
      },
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async () => undefined,
        delete: async () => undefined,
      },
    });

    await agent.rehydrateContextGraphSubscriptions();

    expect(loadAll).toHaveBeenCalledOnce();
    expect(agent.localContextGraphProvenance.hasLocalCreate('public-api-origin')).toBe(true);
  });

  it('decodes only the closed durable membership-source vocabulary', () => {
    for (const source of CONTEXT_GRAPH_MEMBERSHIP_SOURCES) {
      expect(isContextGraphMembershipSource(source)).toBe(true);
    }
    expect(isContextGraphMembershipSource('seed-import')).toBe(false);
    expect(isContextGraphMembershipSource(null)).toBe(false);
  });

  it('keeps arbitrary custom-store sources compatible but never trusts them as local origin', () => {
    const custom: ContextGraphMembershipRecord = row('custom-source', {
      principalType: 'agent',
      status: 'active',
      source: 'migration-v2',
    });
    const provenance = new LocalContextGraphProvenance();

    provenance.restoreMembershipRecords([custom]);

    expect(custom.source).toBe('migration-v2');
    expect(isContextGraphMembershipSource(custom.source)).toBe(false);
    expect(provenance.hasLocalCreate(custom.contextGraphId)).toBe(false);
  });

  it.each(['local-create', 'implicit-swm-write'] as const)(
    'constructs and restores the typed %s origin fact',
    (source) => {
      const record = createLocalContextGraphOriginMembershipRecord({
        contextGraphId: `typed-${source}`,
        principalId: `did:test:${source}`,
        role: 'curator',
        source,
      });
      const provenance = new LocalContextGraphProvenance();

      provenance.restoreMembershipRecords([record]);

      expect(record).toMatchObject({
        principalType: 'agent',
        status: 'active',
        source,
      });
      expect(provenance.hasLocalCreate(`typed-${source}`)).toBe(true);
    },
  );

  it('restores only active agent rows with a node-local origin source', async () => {
    const records = [
      row('explicit-local', {
        principalType: 'agent',
        status: 'active',
        source: 'local-create',
      }),
      row('implicit-local', {
        principalType: 'agent',
        status: 'active',
        source: 'implicit-swm-write',
      }),
      row('join-approved', {
        principalType: 'agent',
        status: 'active',
        source: 'join-approved',
      }),
      row('inactive-local', {
        principalType: 'agent',
        status: 'removed',
        source: 'local-create',
      }),
      row('pending-local', {
        principalType: 'agent',
        status: 'pending',
        source: 'implicit-swm-write',
      }),
      row('node-local', {
        principalType: 'node',
        status: 'active',
        source: 'local-create',
      }),
      row('identity-local', {
        principalType: 'identity',
        status: 'active',
        source: 'implicit-swm-write',
      }),
    ] as const;
    const provenance = new LocalContextGraphProvenance();

    provenance.restoreMembershipRecords(records);

    expect(provenance.hasLocalCreate('explicit-local')).toBe(true);
    expect(provenance.hasLocalCreate('implicit-local')).toBe(true);
    for (const rejected of records.slice(2)) {
      expect(provenance.hasLocalCreate(rejected.contextGraphId)).toBe(false);
    }
  });

  it('loads the lifecycle journal once and distributes one snapshot to both projections', async () => {
    const records = [row('startup-local', {
      principalType: 'agent',
      status: 'active',
      source: 'local-create',
    })];
    const loadAll = vi.fn(async () => records.map((record) => ({ ...record })));
    const provenance = new LocalContextGraphProvenance();
    const rehydrateSubscriptions = vi.fn(async () => undefined);
    const fakeAgent = {
      config: {
        contextGraphMembershipStore: {
          loadAll,
          upsert: async () => undefined,
          delete: async () => undefined,
        },
      },
      localContextGraphProvenance: provenance,
      log: { warn: vi.fn() },
      rehydrateContextGraphSubscriptions: rehydrateSubscriptions,
    };

    await (LifecycleSyncMethods.prototype as any)
      .rehydrateContextGraphsFromDurableState.call(fakeAgent);

    expect(loadAll).toHaveBeenCalledOnce();
    expect(provenance.hasLocalCreate('startup-local')).toBe(true);
    expect(rehydrateSubscriptions).toHaveBeenCalledOnce();
    expect(rehydrateSubscriptions).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ contextGraphId: 'startup-local' }),
    ]));
  });

  it('prefers graph-level origin after the matching membership source is overwritten', async () => {
    const records = [row('stable-origin', {
      principalType: 'agent',
      status: 'active',
      source: 'allowed-agent',
    })];
    const provenance = new LocalContextGraphProvenance();
    const loadLocalOrigins = vi.fn(async () => [{
      contextGraphId: 'stable-origin',
      source: 'local-create' as const,
      createdAt: 1,
    }]);
    const fakeAgent = {
      config: {
        contextGraphMembershipStore: {
          loadAll: async () => records,
          loadLocalOrigins,
          recordLocalOrigin: async () => undefined,
          upsert: async () => undefined,
          delete: async () => undefined,
        },
      },
      localContextGraphProvenance: provenance,
      log: { warn: vi.fn() },
      rehydrateContextGraphSubscriptions: vi.fn(async () => undefined),
    };

    await (LifecycleSyncMethods.prototype as any)
      .rehydrateContextGraphsFromDurableState.call(fakeAgent);

    expect(loadLocalOrigins).toHaveBeenCalledOnce();
    expect(provenance.hasLocalCreate('stable-origin')).toBe(true);
  });

  it.each([
    [
      'loadAll is unavailable',
      {
        upsert: async () => undefined,
        delete: async () => undefined,
      },
    ],
    [
      'loadAll rejects',
      {
        loadAll: async () => { throw new Error('journal unavailable'); },
        upsert: async () => undefined,
        delete: async () => undefined,
      },
    ],
  ])('startup fails closed when the node-local journal %s', async (_label, store) => {
    const provenance = new LocalContextGraphProvenance();
    const warn = vi.fn();
    const rehydrateSubscriptions = vi.fn(async () => undefined);
    const fakeAgent = {
      config: { contextGraphMembershipStore: store },
      localContextGraphProvenance: provenance,
      log: { warn },
      rehydrateContextGraphSubscriptions: rehydrateSubscriptions,
    };

    await (LifecycleSyncMethods.prototype as any)
      .rehydrateContextGraphsFromDurableState.call(fakeAgent);

    expect(provenance.hasLocalCreate(LOCAL_ID)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(rehydrateSubscriptions).toHaveBeenCalledOnce();
    expect(rehydrateSubscriptions).toHaveBeenCalledWith(null);
  });

  it.each([
    [
      'a forged exact local creator claim',
      {
        contextGraph: `<did:dkg:context-graph:${LOCAL_ID}>`,
        registrationGraph: `<${contextGraphMetaGraphUri(LOCAL_ID)}>`,
        status: '"unregistered"',
      },
    ],
    [
      'a creator claim in the wrong registration graph',
      {
        contextGraph: `<did:dkg:context-graph:${LOCAL_ID}>`,
        registrationGraph: `<${contextGraphMetaGraphUri('remote')}>`,
        status: '"unregistered"',
      },
    ],
    [
      'a creator claim carrying registered status',
      {
        contextGraph: `<did:dkg:context-graph:${LOCAL_ID}>`,
        registrationGraph: `<${contextGraphMetaGraphUri(LOCAL_ID)}>`,
        status: '"registered"',
      },
    ],
  ])('ignores replicated RDF candidate: %s', async (_label, candidate) => {
    const fixture = selectedFixture();
    const provenance = new LocalContextGraphProvenance();
    const untrustedRdfQuery = vi.fn(async () => ({
      type: 'bindings' as const,
      bindings: [candidate],
    }));
    provenance.restoreMembershipRecords([]);
    (fixture.agent as any).localContextGraphProvenance = provenance;
    fixture.query.mockImplementation(untrustedRdfQuery as typeof fixture.query);

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toMatchObject({
        kind: 'registered',
        onChainId: 42n,
      });
    expect(untrustedRdfQuery).not.toHaveBeenCalled();
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });
});
