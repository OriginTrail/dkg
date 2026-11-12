// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import type { DKGAgent } from '../src/dkg-agent.js';
import { denyUnheldContextGraphRead } from '../src/unheld-context-graph-read.js';

const ID = '0xab/products';
const ROOT = `did:dkg:context-graph:${ID}`;

const fallback = {
  outcome: 'allowed', grantScope: 'public', source: 'legacy-local', reason: 'local-public', metadataBootstrap: 'eligible',
} as const satisfies ContextGraphReadAuthorityDecision;
const unavailable = (reason: string): ContextGraphReadAuthorityDecision => ({
  outcome: 'unavailable', source: 'registered-chain', reason, metadataBootstrap: 'eligible', dependency: 'chain',
});
const refused = (source: string) => ({
  outcome: 'denied', grantScope: 'none', source, reason: 'context-graph-not-held', metadataBootstrap: 'forbidden',
});

/** An agent that keeps, declares and stores what the test says, and records what was read. */
function agent(held: { kept?: boolean; declared?: boolean; graphs?: readonly string[] } = {}) {
  const graphs = held.graphs ?? [];
  const store = {
    hasGraph: vi.fn(async (graph: string) => graphs.includes(graph)),
    listGraphs: vi.fn(async () => [...graphs]),
    listGraphsByPrefix: vi.fn(async (prefix: string) => graphs.filter((graph) => graph.startsWith(prefix))),
  };
  const node = {
    store,
    keepsContextGraphLocally: vi.fn(() => held.kept === true),
    contextGraphExists: vi.fn(async () => held.declared === true),
  };
  return { node, target: node as unknown as DKGAgent };
}

describe('the read authority for a context graph this node may hold nothing of', () => {
  it.each([
    ['the legacy fallback', fallback, {}],
    ['a proven name absence', unavailable('finalized-name-absence-unaccepted'), {}],
    ['a proven name absence, for a caller who asks for access errors', unavailable('finalized-name-absence-unaccepted'), { accessDenied: 'error' }],
    ['an authority the chain cannot answer now', unavailable('authority-circuit-open'), {}],
  ] as const)('refuses %s as a private context graph would be refused', async (_label, decision, options) => {
    const { node, target } = agent();
    await expect(denyUnheldContextGraphRead(target, ID, decision, options)).resolves.toEqual(refused(decision.source));
    expect(node.keepsContextGraphLocally).toHaveBeenCalledWith(ID);
    expect(node.contextGraphExists).toHaveBeenCalledWith(ID, { signal: undefined });
  });

  it.each([
    ['an allowed registered graph', { outcome: 'allowed', grantScope: 'public', source: 'registered-chain', reason: 'chain-public', metadataBootstrap: 'eligible' }],
    ['another legacy allowance', { ...fallback, reason: 'legacy-peer-allowlist', grantScope: 'node' }],
    ['a denial', { outcome: 'denied', grantScope: 'none', source: 'registered-chain', reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden' }],
    ['another unavailable authority', unavailable('chain-name-binding-unavailable')],
  ] as const)('returns %s as it is, without reading anything', async (_label, decision) => {
    const { node, target } = agent();
    await expect(denyUnheldContextGraphRead(target, ID, decision)).resolves.toBe(decision);
    expect(node.keepsContextGraphLocally).not.toHaveBeenCalled();
    expect(node.contextGraphExists).not.toHaveBeenCalled();
  });

  it('keeps the retryable answer for a caller who asks for access errors while the chain cannot be read', async () => {
    const { node, target } = agent();
    const decision = unavailable('authority-circuit-open');
    await expect(denyUnheldContextGraphRead(target, ID, decision, { accessDenied: 'error' })).resolves.toBe(decision);
    expect(node.contextGraphExists).not.toHaveBeenCalled();
  });

  it.each([
    ['an admitted subscription or a local create', { kept: true }],
    ['a declaration or a well-known graph', { declared: true }],
  ])('keeps the decision for a context graph with %s', async (_label, held) => {
    for (const decision of [fallback, unavailable('finalized-name-absence-unaccepted')]) {
      await expect(denyUnheldContextGraphRead(agent(held).target, ID, decision)).resolves.toBe(decision);
    }
  });

  it('keeps the fallback for an id that holds only an asset graph, and reads with the caller signal', async () => {
    const signal = new AbortController().signal;
    const { node, target } = agent({ graphs: [`${ROOT}/_verifiable_memory/0xaa/1`] });
    await expect(denyUnheldContextGraphRead(target, ID, fallback, { signal })).resolves.toBe(fallback);
    expect(node.contextGraphExists).toHaveBeenCalledWith(ID, { signal });
    expect(node.store.listGraphsByPrefix).toHaveBeenCalledWith(`${ROOT}/_`, { signal });
    // A proven absence is answered from the declaration and the local state alone, as before.
    const absence = unavailable('finalized-name-absence-unaccepted');
    await expect(denyUnheldContextGraphRead(target, ID, absence)).resolves.toEqual(refused('registered-chain'));
  });

  it('never refuses a malformed id, so no answer depends on a read', async () => {
    const { node, target } = agent();
    await expect(denyUnheldContextGraphRead(target, 'bad id', fallback)).resolves.toBe(fallback);
    expect(node.keepsContextGraphLocally).not.toHaveBeenCalled();
    expect(node.contextGraphExists).not.toHaveBeenCalled();
  });
});
