// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type {
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
} from '../src/dkg-agent-types.js';
import { LocalContextGraphProvenance } from
  '../src/local-context-graph-provenance.js';
import {
  LOCAL_ID,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

type DurableMembershipRow = ContextGraphMembershipRecord & {
  firstSeenAt?: number;
  updatedAt: number;
};

function membershipStore(
  rows: readonly DurableMembershipRow[],
): ContextGraphMembershipStore {
  return {
    loadAll: async () => rows.map((row) => ({ ...row })),
    upsert: async () => undefined,
    delete: async () => undefined,
  };
}

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

    await expect(provenance.restoreFromDurableSources({
      membershipStore: membershipStore(records),
      warn: vi.fn(),
    })).resolves.toHaveLength(records.length);

    expect(provenance.hasLocalCreate('explicit-local')).toBe(true);
    expect(provenance.hasLocalCreate('implicit-local')).toBe(true);
    for (const rejected of records.slice(2)) {
      expect(provenance.hasLocalCreate(rejected.contextGraphId)).toBe(false);
    }
  });

  it.each([
    [
      'loadAll is unavailable',
      {
        upsert: async () => undefined,
        delete: async () => undefined,
      } satisfies ContextGraphMembershipStore,
    ],
    [
      'loadAll rejects',
      {
        loadAll: async () => { throw new Error('journal unavailable'); },
        upsert: async () => undefined,
        delete: async () => undefined,
      } satisfies ContextGraphMembershipStore,
    ],
  ])('fails closed when the node-local journal %s', async (_label, store) => {
    const provenance = new LocalContextGraphProvenance();
    const warn = vi.fn();

    await expect(provenance.restoreFromDurableSources({
      membershipStore: store,
      warn,
    })).resolves.toBeNull();

    expect(provenance.hasLocalCreate(LOCAL_ID)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
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
    // Keep the legacy RDF-shaped properties present so this regression fails
    // if restoration ever starts consulting synchronized graph state again.
    const restoreInput = {
      membershipStore: {
        upsert: async () => undefined,
        delete: async () => undefined,
      } satisfies ContextGraphMembershipStore,
      warn: vi.fn(),
      store: { query: untrustedRdfQuery },
      peerId: 'victim-peer',
    };

    await provenance.restoreFromDurableSources(restoreInput);
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
