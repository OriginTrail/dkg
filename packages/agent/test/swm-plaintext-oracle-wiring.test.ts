/**
 * Agent -> handler wiring for the public-access-policy on-chain oracle.
 *
 * The receiver-side fix for plaintext SWM on public+agent-gated CGs lives in
 * `SharedMemoryHandler`, but it only takes effect in production if
 * `getOrCreateSharedMemoryHandler` (dkg-agent-swm-substrate.ts) actually passes
 * `publicAccessPolicyOnChainOracle` through to the handler. The handler-level
 * tests inject the oracle themselves and the sender-side tests cover the
 * predicate, so before this test the wiring line could be deleted and every
 * suite stayed green while production kept the absent-oracle fail-closed
 * behavior — rejecting exactly the plaintext writes the fix admits.
 *
 * This test builds the handler through the REAL agent accessor, installs a
 * COUNTING `isContextGraphPublicOnChain` on the agent, and delivers a signed
 * plaintext write on an agent-gated CG: the write must apply AND the count must
 * move. Remove the oracle option from `getOrCreateSharedMemoryHandler` and both
 * assertions fail.
 */
import { describe, it, expect, afterAll } from 'vitest';
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

describe('agent wires publicAccessPolicyOnChainOracle into SharedMemoryHandler', () => {
  let agent: DKGAgent | undefined;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* not started */ }
  });

  it('a signed plaintext write on a public+agent-gated CG applies through the agent-built handler, consulting the agent oracle', async () => {
    agent = await DKGAgent.create({
      name: 'PlaintextOracleWiring',
      chainAdapter: new MockChainAdapter(),
    });

    // Counting oracle on the AGENT method the substrate closure delegates to.
    let probeCalls = 0;
    (agent as unknown as {
      isContextGraphPublicOnChain: (cgId: string, ctx: unknown) => Promise<boolean>;
    }).isContextGraphPublicOnChain = async () => {
      probeCalls += 1;
      return true;
    };

    // Agent-gate the CG in the agent's own store: without a live public proof
    // the handler must demand encryption for it, so a PLAINTEXT apply below is
    // possible only if the agent handed its oracle to the handler.
    const writer = ethers.Wallet.createRandom();
    const internals = agent as unknown as {
      store: { insert(quads: { subject: string; predicate: string; object: string; graph: string }[]): Promise<void> };
      localAgents: Map<string, unknown>;
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, from: string): Promise<{ applied: boolean; reason?: string }>;
      };
    };
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
        `<urn:test:oracle-wiring> <http://schema.org/name> "Oracle Wiring" <${DATA}> .`,
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

    expect(outcome.applied, `rejected: ${outcome.reason ?? '<none>'}`).toBe(true);
    expect(probeCalls).toBeGreaterThan(0);
  });
});
