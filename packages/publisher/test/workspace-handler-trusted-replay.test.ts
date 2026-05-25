import { beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  computeGossipSigningPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  DKG_ONTOLOGY,
  decodeWorkspacePublishRequest,
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

// Coverage for the `trustedReplay` option on
// SharedMemoryHandler.handle() — the bypass that lets LU-6
// host-catchup re-apply opaque ciphertext fetched from a relaying
// core whose libp2p peerId is NOT the original publisher.
//
// Codex PR #610 R2 caught that the prior coverage only exercised
// SwmHostModeStore, not the replay path's security envelope. The
// tests below assert:
//   1. A valid host replay (publisher != fromPeerId, but envelope
//      crypto + CG binding all check out) DOES apply under
//      trustedReplay=true.
//   2. The SAME wire bytes WITHOUT trustedReplay are rejected
//      (publisher/from mismatch + allowlist).
//   3. Tampered envelope signatures are still rejected with
//      trustedReplay=true (agent gate verification runs first).
//   4. An encrypted payload bound to a different CG is still
//      rejected with trustedReplay=true (CG binding check runs
//      against the inner decrypted contextGraphId).
//   5. Missing decryptor state (no recipient keys wired) is still
//      rejected with trustedReplay=true (decryption throws,
//      catch-path classifies as retryable). This is the agent-gated
//      analogue of "no sender-key state" — same failure surface,
//      same `applied: false, retryable: true` outcome.

const CONTEXT_GRAPH_ID = 'workspace-handler-trusted-replay';
const OTHER_CG_ID = 'workspace-handler-trusted-replay-other';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const WORKSPACE_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH_ID);
const ENTITY = 'urn:test:workspace-handler-trusted-replay';

// Two distinct libp2p peerIds: the original publisher (whose
// signature + payload all reference PUBLISHER_PEER_ID) and the
// relaying host (a core that stored the gossip envelope and is now
// re-serving it through host-catchup). All trustedReplay tests
// invoke handler.handle(..., HOST_PEER_ID, ..., { trustedReplay: true })
// to simulate the member receiving the replay.
const PUBLISHER_PEER_ID = '12D3KooWPublisherPeer';
const HOST_PEER_ID = '12D3KooWHostPeer';

let store: OxigraphStore;
let workspaceOwned: Map<string, Map<string, string>>;

function workspaceMessage(name: string, operationId: string, cgId = CONTEXT_GRAPH_ID): Uint8Array {
  return encodeWorkspacePublishRequest({
    contextGraphId: cgId,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "${name}" <${contextGraphDataUri(cgId)}> .`,
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
  cgId = CONTEXT_GRAPH_ID,
): Promise<Uint8Array> {
  const signingPayload = computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    cgId,
    timestamp,
    payload,
  );
  const signature = await wallet.signMessage(signingPayload);
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: cgId,
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
  cgIdOverride?: string,
): Promise<Uint8Array> {
  const request = decodeWorkspacePublishRequest(payload);
  return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId: cgIdOverride ?? request.contextGraphId,
    senderIdentity: `did:dkg:agent:${agentAddress}`,
    operationId: request.operationId || request.shareOperationId,
    shareOperationId: request.shareOperationId,
    timestampMs: request.timestampMs,
    subGraphName: request.subGraphName,
    plaintext: payload,
    recipients: [recipientKey],
  }));
}

function makeHandler(opts: {
  allowedAgentAddress: string;
  recipientKey?: WorkspaceRecipientEncryptionKey;
}): SharedMemoryHandler {
  return new SharedMemoryHandler(store, new TypedEventBus(), {
    sharedMemoryOwnedEntities: workspaceOwned,
    localAgentAddresses: () => [opts.allowedAgentAddress],
    ...(opts.recipientKey
      ? { workspaceRecipientPrivateKeys: () => [opts.recipientKey!] }
      : {}),
  });
}

async function insertPeerGate(peerId: string): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
    object: `"${peerId}"`,
    graph: META_GRAPH,
  }]);
}

async function insertAgentGate(predicate: string, agentAddress: string): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate,
    object: `"${agentAddress}"`,
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

async function expectStoredName(name: string): Promise<void> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
  );
  expect(result.type).toBe('bindings');
  if (result.type === 'bindings') {
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.['o']).toBe(`"${name}"`);
  }
}

async function expectWorkspaceEmpty(): Promise<void> {
  const result = await store.query(
    `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> ?p ?o } }`,
  );
  expect(result.type).toBe('boolean');
  if (result.type === 'boolean') {
    expect(result.value).toBe(false);
  }
}

describe('SharedMemoryHandler trustedReplay (LU-6 host-catchup)', () => {
  beforeEach(() => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
  });

  it('applies a valid host replay (publisher peer ≠ fromPeerId, signature + CG binding valid)', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    // Allowlist only includes the original publisher peer, NOT the
    // relaying host. trustedReplay must let the replay through
    // anyway because the cryptographic identity is established by
    // the envelope signature + the publisher's peerId is bound
    // inside the encrypted payload.
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Trusted Replay Valid', 'ws-trusted-replay-valid');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      // Codex PR #610 R2 also requires `insertedTriples` to be set
      // on the apply outcome so the host-catchup endpoint can
      // report triples (not envelope counts) in its total.
      expect(outcome.insertedTriples).toBe(1);
      expect(outcome.cgId).toBe(CONTEXT_GRAPH_ID);
      expect(outcome.publisherPeerId).toBe(PUBLISHER_PEER_ID);
    }
    await expectStoredName('Trusted Replay Valid');
  });

  it('rejects the same wire bytes without trustedReplay (publisher mismatch + allowlist)', async () => {
    // Control: the identical envelope from the test above MUST be
    // rejected when handle() is invoked without `trustedReplay`.
    // This proves the bypass is the only thing letting (1) through
    // and that no other change has silently relaxed the gate.
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Trusted Replay Control', 'ws-trusted-replay-control');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const outcome = await handler.handle(wire, HOST_PEER_ID);

    expect(outcome.applied).toBe(false);
    await expectWorkspaceEmpty();
  });

  it('still rejects a tampered envelope signature even under trustedReplay', async () => {
    // Sign with `denied`, but claim `allowed.address` in the
    // envelope's agentAddress field. The agent-gate verification
    // path catches this before any decrypt happens — trustedReplay
    // MUST NOT bypass that check.
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Tampered Sig', 'ws-trusted-replay-tampered-sig');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(denied, encrypted, allowed.address);

    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.reason).toMatch(/agent envelope/i);
      expect(outcome.retryable).toBe(false);
    }
    await expectWorkspaceEmpty();
  });

  it('still rejects a payload whose inner contextGraphId differs from the envelope under trustedReplay', async () => {
    // The encrypted payload is bound to `OTHER_CG_ID` but the outer
    // gossip envelope and signing payload reference
    // `CONTEXT_GRAPH_ID`. The handler checks
    // `decoded.encryptedPayload.contextGraphId === contextGraphId`
    // BEFORE attempting decryption — trustedReplay MUST NOT bypass
    // that cross-CG binding either.
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Wrong CG', 'ws-trusted-replay-wrong-cg');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey, OTHER_CG_ID);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.reason).toMatch(/contextGraphId|does not match/i);
      expect(outcome.retryable).toBe(false);
    }
    await expectWorkspaceEmpty();
  });

  it('still rejects when local decryptor state is missing under trustedReplay', async () => {
    // Handler is built WITHOUT workspaceRecipientPrivateKeys, so
    // decryptEncryptedWorkspacePayload throws inside the inner try
    // and the catch-path classifies the outcome as retryable. This
    // is the agent-gated analogue of "sender-key state hasn't
    // arrived yet" — same failure surface. trustedReplay MUST NOT
    // turn that failure into a silent apply.
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address /* no recipientKey */ });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Missing Decryptor', 'ws-trusted-replay-missing-decryptor');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted);

    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.retryable).toBe(true);
    }
    await expectWorkspaceEmpty();
  });

  it('applies an OLD envelope under trustedReplay (PR #610 round-2 #1 — host-catchup recovery beyond 5-minute freshness window)', async () => {
    // Codex finding: `verifyHostModeEnvelopeAuthority` / `handle()`
    // shared `verifyAgentEnvelope`, which enforced
    // GOSSIP_ENVELOPE_FRESHNESS_MS (5 min). Members replaying
    // legitimate envelopes pulled from a core's host store hours/
    // days after the original write hit `stale or invalid gossip
    // timestamp` and the off-line member could never catch up.
    // The fix: skip the freshness check under trustedReplay, where
    // the cryptographic chain (signature + AEAD) still verifies.
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Aged Replay', 'ws-trusted-replay-aged');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    // Sign with a timestamp 1 hour in the past (well beyond the
    // 5-minute freshness window).
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const wire = await signWorkspaceMessage(allowed, encrypted, allowed.address, oneHourAgoIso);

    // Without trustedReplay this would reject as `stale or invalid
    // gossip timestamp`. With trustedReplay the apply succeeds.
    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(true);
    if (outcome.applied) {
      expect(outcome.insertedTriples).toBe(1);
      expect(outcome.cgId).toBe(CONTEXT_GRAPH_ID);
    }
    await expectStoredName('Aged Replay');
  });

  it('still rejects truly invalid timestamps under trustedReplay (skipFreshness only relaxes the staleness window, not malformed values)', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    const handler = makeHandler({ allowedAgentAddress: allowed.address, recipientKey });
    await insertPrivateAccessPolicy();
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);
    await insertPeerGate(PUBLISHER_PEER_ID);

    const raw = workspaceMessage('Bad TS', 'ws-trusted-replay-bad-ts');
    const encrypted = await encryptForCg(allowed.address, raw, recipientKey);
    const wire = await signWorkspaceMessage(allowed, encrypted, allowed.address, 'not-a-date');

    const outcome = await handler.handle(wire, HOST_PEER_ID, undefined, { trustedReplay: true });

    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.retryable).toBe(false);
    }
    await expectWorkspaceEmpty();
  });
});
