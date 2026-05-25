import { beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  computeGossipSigningPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  DKG_ONTOLOGY,
  encodeEncryptedWorkspacePayload,
  encodeGossipEnvelope,
  encodeWorkspacePublishRequest,
  encryptWorkspacePayload,
  generateWorkspaceRecipientEncryptionKey,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '../src/index.js';

// Codex PR #610 R4: coverage for the new public method
// SharedMemoryHandler.verifyHostModeEnvelopeAuthority(), which is
// the cryptographic gate that LU-6 host-mode SWM ingest uses to
// authenticate gossiped ciphertext envelopes BEFORE persisting
// them to SwmHostModeStore. Without this gate, any peer reachable
// on the topic could fill the per-CG FIFO cap with junk and evict
// legitimate ciphertext history once eviction kicked in.
//
// The gate must:
//   1. Accept a valid agent-signed envelope from an allowlisted
//      agent (and an allowlisted peer when the peer-gate is set).
//   2. Reject an envelope signed by an agent that is NOT on the
//      allowlist (even if the bytes structurally parse).
//   3. Reject an envelope whose claimed agent doesn't match the
//      signer recovered from the signature (signature tampering /
//      spoofed sender).
//   4. Reject a peer that is NOT on the peer allowlist when one
//      is set (defense-in-depth — this matches the live-apply
//      path's behavior).
//   5. Reject CGs that have NO agent allowlist at all (host mode
//      should never be active for non-curated CGs; defensive).
//   6. Reject unsigned / structurally-invalid envelopes.

const CONTEXT_GRAPH_ID = 'workspace-handler-host-mode-authority';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const ENTITY = 'urn:test:host-mode-authority';
const PUBLISHER_PEER_ID = '12D3KooWHostModeAuthorityPublisher';
const HOST_PEER_ID = '12D3KooWHostModeAuthorityHost';
const ATTACKER_PEER_ID = '12D3KooWHostModeAuthorityAttacker';

let store: OxigraphStore;

function workspaceMessage(name: string, operationId: string): Uint8Array {
  return encodeWorkspacePublishRequest({
    contextGraphId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "${name}" <${contextGraphDataUri(CONTEXT_GRAPH_ID)}> .`,
    ),
    manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
    publisherPeerId: PUBLISHER_PEER_ID,
    shareOperationId: operationId,
    timestampMs: Date.now(),
  });
}

async function signWorkspaceMessage(
  wallet: ethers.Wallet,
  payload: Uint8Array,
  claimedAgentAddress = wallet.address,
  timestamp = new Date().toISOString(),
): Promise<Uint8Array> {
  const signingPayload = computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    CONTEXT_GRAPH_ID,
    timestamp,
    payload,
  );
  const signature = await wallet.signMessage(signingPayload);
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: CONTEXT_GRAPH_ID,
    agentAddress: claimedAgentAddress,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

function recipientKeyFor(agentAddress: string): WorkspaceRecipientEncryptionKey {
  return generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${agentAddress}`,
    `did:dkg:agent:${agentAddress}#test-x25519`,
  );
}

async function encryptForCg(
  agentAddress: string,
  payload: Uint8Array,
  recipientKey: WorkspaceRecipientEncryptionKey,
): Promise<Uint8Array> {
  return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId: CONTEXT_GRAPH_ID,
    senderIdentity: `did:dkg:agent:${agentAddress}`,
    operationId: 'op-host-mode-auth',
    shareOperationId: 'op-host-mode-auth',
    timestampMs: Date.now(),
    plaintext: payload,
    recipients: [recipientKey],
  }));
}

function makeHandler(): SharedMemoryHandler {
  // Host-mode ingest never has the chain key (cores are not
  // members), so the handler is built with NO recipient keys —
  // verifyHostModeEnvelopeAuthority MUST work on a handler that
  // can't decrypt, since that is the production configuration.
  return new SharedMemoryHandler(store, new TypedEventBus(), {
    sharedMemoryOwnedEntities: new Map(),
  });
}

function makeHandlerWithChainOracle(
  oracle: (contextGraphId: string) => Promise<string[] | null>,
): SharedMemoryHandler {
  return new SharedMemoryHandler(store, new TypedEventBus(), {
    sharedMemoryOwnedEntities: new Map(),
    chainAgentGateOracle: oracle,
  });
}

async function insertAgentGate(predicate: string, agentAddress: string): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate,
    object: `"${agentAddress}"`,
    graph: META_GRAPH,
  }]);
}

async function insertPeerGate(peerId: string): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
    object: `"${peerId}"`,
    graph: META_GRAPH,
  }]);
}

async function insertPrivateAccessPolicy(): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    object: '"private"',
    graph: META_GRAPH,
  }]);
}

describe('SharedMemoryHandler.verifyHostModeEnvelopeAuthority (LU-6 host-mode gate)', () => {
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('accepts an agent-signed envelope from an allowlisted agent and allowlisted peer', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Host Auth Valid', 'op-host-auth-valid');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, PUBLISHER_PEER_ID);

    expect(verdict.accepted).toBe(true);
  });

  it('accepts when there is no peer allowlist (agent gate is the only requirement)', async () => {
    // Curated CGs with an agent gate but no peer-gate are valid;
    // any libp2p peer may relay as long as the signing agent is
    // allowlisted.
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Host Auth No Peer Gate', 'op-host-auth-no-peer');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

    expect(verdict.accepted).toBe(true);
  });

  it('rejects an envelope signed by a non-allowlisted agent', async () => {
    // The CRITICAL DoS-resistance case. Without this rejection
    // any peer with a fresh wallet could spam the host's
    // SwmHostModeStore for any CG it could reach on the topic.
    const allowed = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const attackerRecipientKey = recipientKeyFor(attacker.address);
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Spam', 'op-host-auth-spam');
    const encrypted = await encryptForCg(attacker.address, raw, attackerRecipientKey);
    const wire = await signWorkspaceMessage(attacker, encrypted);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toMatch(/agent envelope verification failed/i);
    }
  });

  it('rejects a tampered signature (claimedAgent != recovered signer)', async () => {
    const allowed = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Tampered', 'op-host-auth-tampered');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    // Sign with attacker but claim allowed's address in the envelope.
    const wire = await signWorkspaceMessage(attacker, encrypted, allowed.address);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

    expect(verdict.accepted).toBe(false);
  });

  it('rejects a peer not in the peer allowlist when one is set', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Wrong Peer', 'op-host-auth-wrong-peer');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, ATTACKER_PEER_ID);

    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toMatch(/peer .* not in peer allowlist/i);
    }
  });

  it('rejects a CG that has no agent allowlist at all (defensive — host mode should never be active for non-curated CGs)', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    // NOTE: no insertAgentGate() — store has no allowlist for this CG.

    const raw = workspaceMessage('No Gate', 'op-host-auth-no-gate');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toMatch(/no agent allowlist/i);
    }
  });

  it('rejects structurally invalid bytes', async () => {
    const handler = makeHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]),
      CONTEXT_GRAPH_ID,
      HOST_PEER_ID,
    );

    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) {
      expect(verdict.reason).toMatch(/decode failed/i);
    }
  });

  // OT-RFC-38 / LU-6 Phase B — chain-backed agent-allowlist fallback.
  //
  // The whole point of LU-6 is "cores host curated CGs they are NOT
  // members of" (sharding-table-driven, hosting decoupled from
  // membership). Such cores have NO local meta-graph for those CGs,
  // so the local SPARQL probe in `getContextGraphAgentGateAddresses`
  // returns no bindings, and the host-mode gate would defensively
  // reject every envelope as `"no agent allowlist on context graph"`.
  //
  // The fix wires a chain-backed oracle that maps CG id → on-chain
  // `ContextGraphStorage.getParticipantAgents` result. These tests
  // exercise the three meaningful outcomes:
  describe('chain-backed agent-gate fallback (LU-6 Phase B)', () => {
    it('uses the chain oracle when the local store has no allowlist triples', async () => {
      const allowed = ethers.Wallet.createRandom();
      const recipientKey = recipientKeyFor(allowed.address);
      // NOTE: no insertAgentGate() — the local store has NO allowlist
      // (mirrors a hosting core that never joined the CG).
      let oracleCalls = 0;
      const oracle = async (cgId: string) => {
        oracleCalls++;
        expect(cgId).toBe(CONTEXT_GRAPH_ID);
        return [allowed.address];
      };

      const raw = workspaceMessage('Chain Fallback Accept', 'op-host-auth-chain-accept');
      const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
      const wire = await signWorkspaceMessage(allowed, encrypted);

      const handler = makeHandlerWithChainOracle(oracle);
      const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

      expect(verdict.accepted).toBe(true);
      expect(oracleCalls).toBe(1);
    });

    it('prefers the local store when allowlist triples are present (chain oracle not consulted)', async () => {
      const allowed = ethers.Wallet.createRandom();
      const recipientKey = recipientKeyFor(allowed.address);
      await insertPrivateAccessPolicy();
      await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

      let oracleCalls = 0;
      const oracle = async () => {
        oracleCalls++;
        return [allowed.address];
      };

      const raw = workspaceMessage('Local Preferred', 'op-host-auth-local-preferred');
      const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
      const wire = await signWorkspaceMessage(allowed, encrypted);

      const handler = makeHandlerWithChainOracle(oracle);
      const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

      expect(verdict.accepted).toBe(true);
      expect(oracleCalls).toBe(0);
    });

    it('falls back to reject when the chain oracle returns null (unregistered / unknown CG)', async () => {
      const allowed = ethers.Wallet.createRandom();
      const recipientKey = recipientKeyFor(allowed.address);
      const oracle = async () => null;

      const raw = workspaceMessage('Chain Null', 'op-host-auth-chain-null');
      const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
      const wire = await signWorkspaceMessage(allowed, encrypted);

      const handler = makeHandlerWithChainOracle(oracle);
      const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

      expect(verdict.accepted).toBe(false);
      if (!verdict.accepted) {
        expect(verdict.reason).toMatch(/no agent allowlist/i);
      }
    });

    it('rejects when the chain oracle returns a list that does NOT include the signer (DoS-resistance)', async () => {
      const allowed = ethers.Wallet.createRandom();
      const attacker = ethers.Wallet.createRandom();
      const attackerRecipientKey = recipientKeyFor(attacker.address);
      const oracle = async () => [allowed.address];

      const raw = workspaceMessage('Chain Reject Attacker', 'op-host-auth-chain-reject');
      const encrypted = await encryptForCg(attacker.address, raw, attackerRecipientKey);
      const wire = await signWorkspaceMessage(attacker, encrypted);

      const handler = makeHandlerWithChainOracle(oracle);
      const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

      expect(verdict.accepted).toBe(false);
      if (!verdict.accepted) {
        expect(verdict.reason).toMatch(/agent envelope verification failed/i);
      }
    });

    it('treats a thrown oracle as no-allowlist (fail-closed)', async () => {
      const allowed = ethers.Wallet.createRandom();
      const recipientKey = recipientKeyFor(allowed.address);
      const oracle = async () => { throw new Error('rpc unreachable'); };

      const raw = workspaceMessage('Chain Throws', 'op-host-auth-chain-throws');
      const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
      const wire = await signWorkspaceMessage(allowed, encrypted);

      const handler = makeHandlerWithChainOracle(oracle);
      const verdict = await handler.verifyHostModeEnvelopeAuthority(wire, CONTEXT_GRAPH_ID, HOST_PEER_ID);

      expect(verdict.accepted).toBe(false);
      if (!verdict.accepted) {
        expect(verdict.reason).toMatch(/no agent allowlist/i);
      }
    });
  });
});
