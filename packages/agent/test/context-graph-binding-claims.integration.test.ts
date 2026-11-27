// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphBindingState } from '../src/context-graph-binding-state.js';
import type { DurableContextGraphSubscriptionBinding } from '../src/dkg-agent-types.js';
import { finalizedTargetPlan } from '../src/internal/context-graph-authority/finalized-target-projection.js';

const LOCAL_ID = 'argus-vault';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL_ID));
const agents: DKGAgent[] = [];
afterEach(async () => {
  while (agents.length > 0) await agents.pop()!.stop();
});

async function fixture(retainPlaceholder = false, chain = new MockChainAdapter()) {
  const agent = await DKGAgent.create({
    name: 'DuplicateBindingClaims',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
  });
  agents.push(agent);
  await agent.start();
  // Use the actual observation owner to establish both chain-proven slots,
  // then remove its discovery-only placeholder: the caller has durable RDF
  // claims but no admitted subscription, so this exercises the strict fallback.
  for (const id of ['323', '582']) {
    agent.applyOnChainContextGraphObservation({
      contextGraphId: id,
      nameHash: NAME_HASH,
      owner: id === '582' ? `0x${'bb'.repeat(20)}` : `0x${'aa'.repeat(20)}`,
      accessPolicy: 0,
      publishPolicy: 1,
      active: true,
      observedAtBlock: 100,
    }, { source: 'checkpoint' });
  }
  if (!retainPlaceholder) agent.deleteContextGraphSubscription(NAME_HASH.toLowerCase());
  return agent;
}

/** Actual legacy reverse discovery must refuse duplicate native registry slots. */
async function duplicateNameChain(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 323n });
  for (let id = 323n; id <= 582n; id++) {
    const result = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      // The intervening slots opt out of committing a cleartext name.
      nameHash: id === 323n || id === 582n ? NAME_HASH : ethers.ZeroHash,
    });
    expect(result.contextGraphId).toBe(id);
  }
  return chain;
}

function targetPlan(
  agent: DKGAgent,
  requestedId: string,
  hint?: DurableContextGraphSubscriptionBinding,
) {
  // This is the actual canonical owner on the composed agent, not a test
  // reimplementation of numeric authority or indirect-target selection.
  const bindingState = (agent as unknown as {
    contextGraphBindingState: ContextGraphBindingState;
  }).contextGraphBindingState;
  return finalizedTargetPlan(
    agent,
    bindingState.authorityIndexOnChainIdFor.bind(bindingState),
    [requestedId],
    hint === undefined ? undefined : new Map([[requestedId, hint]]),
  );
}

const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const meta = contextGraphMetaGraphUri(LOCAL_ID);

describe('same-name graph binding claims in the real store', () => {
  it.each([
    ['ontology and metadata', ontology, meta],
    ['metadata and ontology', meta, ontology],
    ['two metadata claims', meta, meta],
  ])('refuses conflicting proven slots in %s', async (_label, firstGraph, secondGraph) => {
    const agent = await fixture();
    await agent.store.insert([
      { subject: contextGraphDataGraphUri(LOCAL_ID), predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"323"', graph: firstGraph },
      { subject: contextGraphDataGraphUri(LOCAL_ID), predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: '"582"', graph: secondGraph },
    ]);
    await expect(agent.getContextGraphOnChainId(LOCAL_ID)).rejects.toThrow(/conflicting.*323.*582|conflicting.*582.*323/i);
    expect(agent.getSubscribedContextGraphs().has(LOCAL_ID)).toBe(false);
  });

  it('accepts one exact slot repeated in both graphs', async () => {
    const agent = await fixture();
    await agent.store.insert([ontology, meta].map((graph) => ({
      subject: contextGraphDataGraphUri(LOCAL_ID),
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
      object: '"582"',
      graph,
    })));
    await expect(agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe('582');
  });

  it('does not let an indirect wire placeholder shadow the dormant cleartext metadata binding', async () => {
    const agent = await fixture(true);
    expect(agent.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, '323'))
      .toBe(NAME_HASH.toLowerCase());
    await agent.store.insert([{
      subject: contextGraphDataGraphUri(LOCAL_ID),
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
      object: '"582"',
      graph: meta,
    }]);
    // A dormant persisted row is not installed until read authority permits it.
    expect(agent.getSubscribedContextGraphs().has(LOCAL_ID)).toBe(false);
    await expect(agent.getContextGraphOnChainId(NAME_HASH.toLowerCase())).resolves.toBe('323');
    await expect(agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe('582');
    // An explicit request for the wire row still names its exact numeric slot.
    await expect(agent.getContextGraphOnChainId(NAME_HASH.toLowerCase())).resolves.toBe('323');
    await expect(agent.getContextGraphOnChainId(`0x${NAME_HASH.slice(2).toUpperCase()}`)).resolves.toBe('323');
  });

  it('refuses registration discovery through a foreign wire slot while retaining exact durable authority', async () => {
    const chain = await duplicateNameChain();
    const agent = await fixture(true, chain);
    expect(agent.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, '323'))
      .toBe(NAME_HASH.toLowerCase());
    await agent.store.insert([{
      subject: contextGraphDataGraphUri(LOCAL_ID),
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
      object: '"582"',
      graph: meta,
    }]);
    expect(agent.getSubscribedContextGraphs().has(LOCAL_ID)).toBe(false);
    await expect(agent.getContextGraphOnChainId(LOCAL_ID)).resolves.toBe('582');

    // Without an installed row or its explicit durable hint, registration
    // owns name discovery, not metadata adoption. The real Mock resolver sees
    // both matching slots and must refuse instead of borrowing wire slot323.
    const binding = await agent.resolveContextGraphRegistrationBinding(LOCAL_ID);
    expect(binding).toMatchObject({
      kind: 'unavailable',
      reason: 'chain-name-binding-unavailable',
    });
    expect(binding.kind === 'unavailable' ? binding.detail : undefined).toMatch(/ambiguous/i);

    await expect(agent.resolveContextGraphRegistrationBinding(NAME_HASH.toLowerCase()))
      .resolves.toEqual({ kind: 'registered', onChainId: 323n, provenance: 'authoritative' });
    await expect(agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId: '582',
        onChainHash: NAME_HASH,
      },
    })).resolves.toEqual({ kind: 'registered', onChainId: 582n, provenance: 'authoritative' });
  });

  it('keeps an exact finalized durable582 hint instead of the indirect wire323 subscription', async () => {
    const agent = await fixture(true);
    expect(agent.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, '323'))
      .toBe(NAME_HASH.toLowerCase());
    const plan = targetPlan(agent, LOCAL_ID, {
      contextGraphId: LOCAL_ID,
      onChainId: '582',
      onChainHash: NAME_HASH,
    });

    expect(plan.targets.get(LOCAL_ID)).toEqual({
      kind: 'durable-binding',
      expectedNameHash: NAME_HASH.toLowerCase(),
      expectedOnChainId: 582n,
    });
    expect(plan.reverseBindingTargets).toEqual([]);
    expect(targetPlan(agent, NAME_HASH.toLowerCase()).targets.get(NAME_HASH.toLowerCase()))
      .toEqual({
        kind: 'durable-binding',
        expectedNameHash: NAME_HASH.toLowerCase(),
        expectedOnChainId: 323n,
      });
  });

  it.each([
    { label: 'hint for a different graph', contextGraphId: 'another-graph', onChainId: '582' },
    { label: 'noncanonical numeric hint', contextGraphId: LOCAL_ID, onChainId: '0' },
  ])('does not substitute wire323 for a $label in the finalized plan', async (hint) => {
    const agent = await fixture(true);
    expect(agent.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, '323'))
      .toBe(NAME_HASH.toLowerCase());
    const plan = targetPlan(agent, LOCAL_ID, { ...hint, onChainHash: NAME_HASH });

    expect(plan.targets.has(LOCAL_ID)).toBe(false);
    expect(plan.reverseBindingTargets).toEqual([{
      contextGraphId: LOCAL_ID,
      expectedNameHash: NAME_HASH.toLowerCase(),
    }]);
  });

  it('does not let lexical duplicates with different RDF terms hide a second proven numeric slot', async () => {
    const agent = await fixture();
    await agent.store.insert([
      '"582"',
      '"582"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"582"^^<http://www.w3.org/2001/XMLSchema#decimal>',
      '"582"@en',
      '"323"',
    ].map((object) => ({
      subject: contextGraphDataGraphUri(LOCAL_ID),
      predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
      object,
      graph: meta,
    })));

    await expect(agent.getContextGraphOnChainId(LOCAL_ID))
      .rejects.toThrow(/conflicting.*323.*582|conflicting.*582.*323/i);
    expect(agent.getSubscribedContextGraphs().has(LOCAL_ID)).toBe(false);
  });
});
