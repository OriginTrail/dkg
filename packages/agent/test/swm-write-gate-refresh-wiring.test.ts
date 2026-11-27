// SPDX-License-Identifier: Apache-2.0

/**
 * Agent -> handler wiring for the shared-memory write gate's second look.
 *
 * The handler-level tests inject the refresh oracle themselves. Production only
 * gets the fix if `getOrCreateSharedMemoryHandler` hands the handler an oracle
 * built on the agent's canonical gate and curator refresh. These tests build the
 * handler through the real accessor and deliver a signed write by a member the
 * agent's local metadata does not list yet: the write applies only if the
 * handler asked the agent's canonical gate, and an unavailable canonical gate
 * must come back as a retryable rejection rather than the old permanent one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  computeGossipSigningPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  DKG_ONTOLOGY,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphAgentGateAuthority } from '../src/internal/context-graph-authority/context-graph-authority.js';
import { encodeRootlessWorkspaceRequest } from '../../publisher/test/_helpers/rootless-workspace.js';

const CG = 'swm-write-gate-refresh-wiring';
const DATA = contextGraphDataUri(CG);
const META = contextGraphMetaUri(CG);
const PEER = '12D3KooWGateRefreshWiringPeer';
const SUBJECT = 'urn:test:gate-refresh-wiring';

interface AgentInternals {
  store: {
    insert(quads: { subject: string; predicate: string; object: string; graph: string }[]): Promise<void>;
    query(sparql: string): Promise<{ type: string; value?: boolean }>;
  };
  localAgents: Map<string, unknown>;
  getOrCreateSharedMemoryHandler(): {
    handle(data: Uint8Array, from: string): Promise<{ applied: boolean; reason?: string; retryable?: boolean }>;
  };
}

interface GateOverrides {
  isContextGraphPublicOnChain: (cgId: string, ctx: unknown) => Promise<boolean>;
  resolveContextGraphAgentGateAuthority: (cgId: string, options: unknown) => Promise<ContextGraphAgentGateAuthority>;
  refreshMetaFromCurator: (cgId: string, options: unknown) => Promise<boolean>;
}

let agent: DKGAgent | undefined;

afterEach(async () => {
  try { await agent?.stop(); } catch { /* not started */ }
  agent = undefined;
});

/** Deliver a signed write by a member the local metadata does not list, through the agent-built handler. */
async function deliverLateMemberWrite(canonicalGate: (localMember: string, writer: string) => ContextGraphAgentGateAuthority) {
  agent = await DKGAgent.create({
    name: 'WriteGateRefreshWiring',
    chainAdapter: new MockChainAdapter(),
    rfc64CatalogActivation: { enabled: false },
  });
  const localMember = ethers.Wallet.createRandom();
  const writer = ethers.Wallet.createRandom();
  const resolveContextGraphAgentGateAuthority = vi.fn(async () => canonicalGate(localMember.address, writer.address));
  const refreshMetaFromCurator = vi.fn(async () => false);
  Object.assign(agent as unknown as GateOverrides, {
    // The gate decides before the encryption requirement; proving the graph
    // public keeps this fixture to a plaintext write.
    isContextGraphPublicOnChain: async () => true,
    resolveContextGraphAgentGateAuthority,
    refreshMetaFromCurator,
  } satisfies GateOverrides);

  const internals = agent as unknown as AgentInternals;
  internals.localAgents.set(localMember.address, {});
  // The projected gate: the local member only. The writer was approved later.
  await internals.store.insert([{
    subject: DATA,
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${localMember.address}"`,
    graph: META,
  }]);

  const handler = internals.getOrCreateSharedMemoryHandler();
  const payload = encodeRootlessWorkspaceRequest({
    contextGraphId: CG,
    nquads: new TextEncoder().encode(`<${SUBJECT}> <http://schema.org/name> "Late Member" <${DATA}> .`),
    publisherPeerId: PEER,
    shareOperationId: 'ws-gate-refresh-wiring',
    timestampMs: Date.now(),
  });
  const timestamp = new Date().toISOString();
  const signature = await writer.signMessage(
    computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, CG, timestamp, payload),
  );
  const wire = encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: CG,
    agentAddress: writer.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });

  const outcome = await handler.handle(wire, PEER);
  const stored = await internals.store.query(`ASK { GRAPH ?g { <${SUBJECT}> ?p ?o } }`);
  return {
    outcome,
    stored: stored.type === 'boolean' && stored.value === true,
    resolveContextGraphAgentGateAuthority,
    refreshMetaFromCurator,
  };
}

describe('agent wires the write gate refresh oracle into SharedMemoryHandler', () => {
  it('a write by a member only the canonical gate lists applies through the agent-built handler', async () => {
    const { outcome, stored, resolveContextGraphAgentGateAuthority, refreshMetaFromCurator } =
      await deliverLateMemberWrite((localMember, writer) => ({ kind: 'available', agentAddresses: [localMember, writer] }));

    expect(outcome.applied, `rejected: ${outcome.reason ?? '<none>'}`).toBe(true);
    expect(stored).toBe(true);
    expect(resolveContextGraphAgentGateAuthority).toHaveBeenCalledTimes(1);
    expect(resolveContextGraphAgentGateAuthority.mock.calls[0]?.[0]).toBe(CG);
    expect(refreshMetaFromCurator).not.toHaveBeenCalled();
  });

  it('a canonical gate that still excludes the writer refreshes from the curator and rejects permanently', async () => {
    const { outcome, stored, refreshMetaFromCurator } =
      await deliverLateMemberWrite((localMember) => ({ kind: 'available', agentAddresses: [localMember] }));

    expect(outcome).toMatchObject({ applied: false, retryable: false });
    expect(stored).toBe(false);
    expect(refreshMetaFromCurator).toHaveBeenCalledTimes(1);
    expect(refreshMetaFromCurator.mock.calls[0]?.[0]).toBe(CG);
  });

  it('an unavailable canonical gate comes back as a retryable rejection', async () => {
    const { outcome, stored } = await deliverLateMemberWrite(() => ({
      kind: 'unavailable',
      reason: 'chain-participant-authority-unavailable',
    }));

    expect(outcome).toMatchObject({ applied: false, retryable: true });
    expect(stored).toBe(false);
  });
});
