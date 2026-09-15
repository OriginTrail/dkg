// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, type CreateOnChainContextGraphResult } from
  '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

type RegistrationAgent = DKGAgent & {
  store: TripleStore;
  registerContextGraphOnChain:
    () => Promise<CreateOnChainContextGraphResult>;
};

function successfulRegistration(id = 42n): CreateOnChainContextGraphResult {
  return {
    hash: `0x${'42'.repeat(32)}`,
    blockNumber: 10,
    txIndex: 0,
    success: true,
    contextGraphId: id,
  };
}

async function registrationStatus(agent: RegistrationAgent, id: string): Promise<string | undefined> {
  const result = await agent.store.query(`
    SELECT ?status WHERE {
      GRAPH <${contextGraphMetaGraphUri(id)}> {
        <did:dkg:context-graph:${id}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status
      }
    } LIMIT 1
  `);
  return result.type === 'bindings'
    ? result.bindings[0]?.['status']?.replace(/^"|"$/g, '')
    : undefined;
}

async function hasOnChainBinding(agent: RegistrationAgent, id: string): Promise<boolean> {
  const result = await agent.store.query(`
    ASK WHERE {
      GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> {
        <did:dkg:context-graph:${id}>
          <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?onChainId
      }
    }
  `);
  return result.type === 'boolean' && result.value;
}

async function fixture(id: string): Promise<{
  agent: RegistrationAgent;
  chain: MockChainAdapter;
  ownerAddress: string;
}> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: `registration-transition-${id}`,
    chainAdapter: chain,
  }) as RegistrationAgent;
  (agent as unknown as { node: unknown }).node = {
    peerId: `12D3KooWRegistrationTransition${id}`,
    libp2p: { getPeers: () => [] },
  };
  (agent as unknown as { gossip: unknown }).gossip = {
    subscribe: vi.fn(),
    onMessage: vi.fn(),
    publish: vi.fn(async () => undefined),
  };
  const ownerAddress = chain.signerAddress;
  await agent.createContextGraph({
    id,
    name: id,
    private: true,
    callerAgentAddress: ownerAddress,
  });
  return { agent, chain, ownerAddress };
}

describe('Context Graph registration durability transition', () => {
  it('does not scan historical name bindings for a fresh local-first registration', async () => {
    const id = 'registration-fresh-local-first';
    const { agent, chain, ownerAddress } = await fixture(id);
    const resolveNameHash = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
    agent.registerContextGraphOnChain = vi.fn(async () => {
      const duringRegistration = await agent.resolveContextGraphRegistrationBinding(id);
      expect(duringRegistration).toMatchObject({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
      });
      return successfulRegistration();
    });

    await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(resolveNameHash).not.toHaveBeenCalled();
  });

  it('flushes pending before chain submission and bindings before registered', async () => {
    const id = 'registration-order';
    const { agent, ownerAddress } = await fixture(id);
    const events: string[] = [];
    const originalFlush = agent.store.flush?.bind(agent.store);
    agent.store.flush = async () => {
      events.push(
        `flush:${await registrationStatus(agent, id)}:${await hasOnChainBinding(agent, id)}`,
      );
      await originalFlush?.();
    };
    agent.registerContextGraphOnChain = vi.fn(async () => {
      events.push('chain');
      return successfulRegistration();
    });

    await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(events.slice(0, 4)).toEqual([
      'flush:pending:false',
      'chain',
      'flush:pending:true',
      'flush:registered:true',
    ]);
  });

  it('rejects a duplicate registration while the first attempt owns the transition', async () => {
    const id = 'registration-duplicate-in-flight';
    const { agent, ownerAddress } = await fixture(id);
    agent.registerContextGraphOnChain = vi.fn(async () => successfulRegistration());
    agent.contextGraphRegistrationsInFlight.add(id);

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toThrow(`Context graph "${id}" registration is already in flight`);

    expect(agent.registerContextGraphOnChain).not.toHaveBeenCalled();
    agent.contextGraphRegistrationsInFlight.delete(id);
  });

  it('restores pending when the final registered marker cannot be committed', async () => {
    const id = 'registration-final-marker-failure';
    const { agent, ownerAddress } = await fixture(id);
    agent.registerContextGraphOnChain = vi.fn(async () => successfulRegistration());
    const originalUpdate = agent.store.update?.bind(agent.store);
    expect(originalUpdate).toBeTypeOf('function');
    agent.store.update = async (sparql, options) => {
      if (
        options?.source === 'agent.contextGraph.registrationStatus.persist'
        && sparql.includes('"registered"')
      ) {
        throw new Error('registered status commit unavailable');
      }
      await originalUpdate!(sparql, options);
    };

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toThrow('registered status commit unavailable');

    expect(await registrationStatus(agent, id)).toBe('pending');
    expect(await hasOnChainBinding(agent, id)).toBe(true);
  });

  it('restores unregistered after a definitive mined revert', async () => {
    const id = 'registration-revert';
    const { agent, ownerAddress } = await fixture(id);
    const events: string[] = [];
    const originalFlush = agent.store.flush?.bind(agent.store);
    agent.store.flush = async () => {
      events.push(`flush:${await registrationStatus(agent, id)}`);
      await originalFlush?.();
    };
    const revert = Object.assign(new Error('registration reverted'), {
      code: 'CALL_EXCEPTION',
      receipt: { status: 0 },
    });
    agent.registerContextGraphOnChain = vi.fn(async () => {
      events.push('chain');
      throw revert;
    });

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toBe(revert);

    expect(events).toEqual(['flush:pending', 'chain', 'flush:unregistered']);
    expect(await registrationStatus(agent, id)).toBe('unregistered');
  });

  it('retains pending after an ambiguous submission failure', async () => {
    const id = 'registration-ambiguous';
    const { agent, ownerAddress } = await fixture(id);
    const ambiguous = new Error('submission outcome unavailable');
    agent.registerContextGraphOnChain = vi.fn(async () => { throw ambiguous; });

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toBe(ambiguous);

    expect(await registrationStatus(agent, id)).toBe('pending');

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toThrow(`Context graph "${id}" has a pending registration outcome`);
    expect(agent.registerContextGraphOnChain).toHaveBeenCalledOnce();
  });

  it('restores unregistered when only a preparatory transaction is ambiguous', async () => {
    const id = 'registration-preparatory-ambiguous';
    const { agent, ownerAddress } = await fixture(id);
    const approvalFailure = Object.assign(new Error('approval receipt unavailable'), {
      code: 'RPC_RECEIPT_LOOKUP_FAILED',
      txHash: `0x${'ab'.repeat(32)}`,
      contextGraphRegistrationSubmitted: false,
    });
    agent.registerContextGraphOnChain = vi.fn(async () => { throw approvalFailure; });

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toBe(approvalFailure);

    expect(await registrationStatus(agent, id)).toBe('unregistered');
  });

  it('retains pending when a definitive-failure recovery write is rejected', async () => {
    const id = 'registration-recovery-failure';
    const { agent, ownerAddress } = await fixture(id);
    const revert = Object.assign(new Error('registration reverted'), {
      code: 'CALL_EXCEPTION',
      receipt: { status: 0 },
    });
    agent.registerContextGraphOnChain = vi.fn(async () => { throw revert; });
    const originalUpdate = agent.store.update?.bind(agent.store);
    expect(originalUpdate).toBeTypeOf('function');
    agent.store.update = async (sparql, options) => {
      if (sparql.includes('"unregistered"')) {
        throw new Error('registration status store unavailable');
      }
      await originalUpdate!(sparql, options);
    };

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toBe(revert);

    expect(await registrationStatus(agent, id)).toBe('pending');
  });

  it('retains pending when recovery bindings cannot be stored after success', async () => {
    const id = 'registration-binding-failure';
    const { agent, ownerAddress } = await fixture(id);
    agent.registerContextGraphOnChain = vi.fn(async () => successfulRegistration());
    const originalInsert = agent.store.insert.bind(agent.store);
    agent.store.insert = async (quads: Quad[]) => {
      if (quads.some((quad) => (
        quad.predicate === `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`
      ))) {
        throw new Error('binding store unavailable');
      }
      await originalInsert(quads);
    };

    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toThrow('binding store unavailable');

    expect(await registrationStatus(agent, id)).toBe('pending');
  });

  it('installs and flushes compatibility-store fences before retiring old values', async () => {
    const id = 'registration-compatibility-order';
    const { agent, ownerAddress } = await fixture(id);
    const events: string[] = [];
    Reflect.set(agent.store, 'update', undefined);
    const originalInsert = agent.store.insert.bind(agent.store);
    const originalDelete = agent.store.delete.bind(agent.store);
    const originalFlush = agent.store.flush?.bind(agent.store);
    agent.store.insert = async (quads, options) => {
      if (options?.source?.includes('registrationStatus')) {
        events.push(`insert:${quads[0]?.object}`);
      }
      await originalInsert(quads, options);
    };
    agent.store.delete = async (quads, options) => {
      if (options?.source?.includes('registrationStatus')) {
        events.push(`delete:${quads[0]?.object}`);
      }
      await originalDelete(quads, options);
    };
    agent.store.flush = async () => {
      events.push(`flush:${await agent.readLocalContextGraphRegistrationStatus(id)}`);
      await originalFlush?.();
    };
    agent.registerContextGraphOnChain = vi.fn(async () => successfulRegistration());

    await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(events.slice(0, 4)).toEqual([
      'insert:"pending"',
      'flush:pending',
      'delete:"unregistered"',
      'flush:pending',
    ]);
    expect(events).toContain('insert:"registered"');
    expect(events.indexOf('insert:"registered"'))
      .toBeLessThan(events.indexOf('delete:"pending"'));
    expect(await agent.readLocalContextGraphRegistrationStatus(id)).toBe('registered');
  });

  it('treats an interrupted compatibility transition as pending, not local-first', async () => {
    const id = 'registration-compatibility-interrupted';
    const { agent, ownerAddress } = await fixture(id);
    Reflect.set(agent.store, 'update', undefined);
    const originalDelete = agent.store.delete.bind(agent.store);
    agent.store.delete = async (quads, options) => {
      if (options?.source === 'agent.contextGraph.registrationStatus.retirePrevious') {
        throw new Error('compatibility status retirement interrupted');
      }
      await originalDelete(quads, options);
    };
    await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress }))
      .rejects.toThrow('compatibility status retirement interrupted');

    expect(await agent.readLocalContextGraphRegistrationStatus(id)).toBe('pending');
    await expect(agent.isLocalFirstUnregisteredContextGraph(id)).resolves.toBe(false);
  });
});
