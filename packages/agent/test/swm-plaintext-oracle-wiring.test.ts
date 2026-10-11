/**
 * Agent -> handler wiring for the public-access-policy oracle.
 *
 * The receiver-side fix for plaintext SWM on public+agent-gated CGs lives in
 * `SharedMemoryHandler`, but it only takes effect in production if
 * `getOrCreateSharedMemoryHandler` (dkg-agent-swm-substrate.ts) actually passes
 * `publicAccessPolicyOracle` through to the handler. The handler-level tests
 * inject the oracle themselves and the sender-side tests cover the predicate,
 * so before this test the wiring line could be deleted and every suite stayed
 * green while production kept the absent-oracle fail-closed behavior —
 * rejecting exactly the plaintext writes the fix admits.
 *
 * These tests build the handler through the REAL agent accessor and deliver a
 * signed plaintext write on an agent-gated CG. The positive case must apply
 * AND consult the agent's probe; remove the oracle option from
 * `getOrCreateSharedMemoryHandler` and both assertions fail. The negative
 * cases pin the other direction (#2827 review): without a public proof — or
 * with an accepted owner-signed public snapshot for a name the finalized index
 * now shows registered private — the same write is rejected and nothing is
 * stored.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import { encodeRootlessWorkspaceRequest } from '../../publisher/test/_helpers/rootless-workspace.js';

const CG = 'swm-plaintext-oracle-wiring';
const DATA = contextGraphDataUri(CG);
const META = contextGraphMetaUri(CG);
const PEER = '12D3KooWOracleWiringPeer';
const SUBJECT = 'urn:test:oracle-wiring';

interface AgentInternals {
  store: {
    insert(quads: { subject: string; predicate: string; object: string; graph: string }[]): Promise<void>;
    query(sparql: string): Promise<{ type: string; value?: boolean }>;
  };
  localAgents: Map<string, unknown>;
  getOrCreateSharedMemoryHandler(): {
    handle(data: Uint8Array, from: string): Promise<{ applied: boolean; reason?: string }>;
  };
}

type ProbeOverrides = {
  isContextGraphPublicOnChain?: (cgId: string, ctx: unknown) => Promise<boolean>;
  hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1?: (cgId: string) => boolean;
  resolveRegisteredContextGraphAuthority?: (cgId: string, options: unknown) => Promise<
    | { kind: 'unregistered' }
    | { kind: 'public'; onChainId: bigint }
    | { kind: 'private'; onChainId: bigint; participantAgents: string[] }
  >;
};

let agent: DKGAgent | undefined;

afterEach(async () => {
  try { await agent?.stop(); } catch { /* not started */ }
  agent = undefined;
});

/** Deliver a signed plaintext write on an agent-gated CG through the agent-built handler. */
async function deliverSignedPlaintext(overrides: ProbeOverrides) {
  agent = await DKGAgent.create({
    name: 'PlaintextOracleWiring',
    chainAdapter: new MockChainAdapter(),
    rfc64CatalogActivation: { enabled: false },
  });
  Object.assign(agent as unknown as ProbeOverrides, overrides);

  // Agent-gate the CG in the agent's own store: without a public proof the
  // handler must demand encryption for it, so a PLAINTEXT apply is possible
  // only if the agent handed its oracle to the handler and the oracle said
  // public.
  const writer = ethers.Wallet.createRandom();
  const internals = agent as unknown as AgentInternals;
  // The receiver applies gated writes only when the local node itself holds
  // an allowed agent for the CG (the member/curator case the fix restores).
  internals.localAgents.set(writer.address, {});
  await internals.store.insert([{
    subject: DATA,
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${writer.address}"`,
    graph: META,
  }]);

  const handler = internals.getOrCreateSharedMemoryHandler();

  const payload = encodeRootlessWorkspaceRequest({
    contextGraphId: CG,
    nquads: new TextEncoder().encode(
      `<${SUBJECT}> <http://schema.org/name> "Oracle Wiring" <${DATA}> .`,
    ),
    publisherPeerId: PEER,
    shareOperationId: 'ws-oracle-wiring',
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
  return { outcome, stored: stored.type === 'boolean' && stored.value === true };
}

describe('agent wires publicAccessPolicyOracle into SharedMemoryHandler', () => {
  it('a signed plaintext write on a public+agent-gated CG applies through the agent-built handler, consulting the agent probe', async () => {
    let probeCalls = 0;
    const { outcome, stored } = await deliverSignedPlaintext({
      isContextGraphPublicOnChain: async () => {
        probeCalls += 1;
        return true;
      },
    });

    expect(outcome.applied, `rejected: ${outcome.reason ?? '<none>'}`).toBe(true);
    expect(stored).toBe(true);
    expect(probeCalls).toBeGreaterThan(0);
  });

  it('rejects the plaintext write and stores nothing when neither the chain nor an accepted owner-signed policy proves public', async () => {
    const { outcome, stored } = await deliverSignedPlaintext({
      isContextGraphPublicOnChain: async () => false,
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => false,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toMatch(/Sender Key encrypted workspace payload required/);
    expect(stored).toBe(false);
  });

  it('rejects the plaintext write when an accepted owner-signed public snapshot is outlived by a private registration', async () => {
    // The catalog has not reconciled yet, so the old public snapshot is still
    // accepted, but the finalized index already shows the name registered
    // private: the registry's answer wins.
    const { outcome, stored } = await deliverSignedPlaintext({
      hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => true,
      resolveRegisteredContextGraphAuthority: async () => ({
        kind: 'private',
        onChainId: 7n,
        participantAgents: [],
      }),
      isContextGraphPublicOnChain: async () => false,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toMatch(/Sender Key encrypted workspace payload required/);
    expect(stored).toBe(false);
  });
});
