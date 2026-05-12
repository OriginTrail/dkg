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
  SYSTEM_CONTEXT_GRAPHS,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '../src/index.js';

const CONTEXT_GRAPH_ID = 'workspace-handler-agent-gate';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const ONTOLOGY_GRAPH = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const WORKSPACE_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH_ID);
const PEER_ID = '12D3KooWAgentGatePeer';
const ENTITY = 'urn:test:workspace-handler-agent-gate';

let store: OxigraphStore;
let workspaceOwned: Map<string, Map<string, string>>;
let handler: SharedMemoryHandler;

function workspaceMessage(name: string, operationId: string): Uint8Array {
  return encodeWorkspacePublishRequest({
    contextGraphId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "${name}" <${DATA_GRAPH}> .`,
    ),
    manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
    publisherPeerId: PEER_ID,
    workspaceOperationId: operationId,
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

async function encryptWorkspaceMessage(
  agentAddress: string,
  payload: Uint8Array,
  recipientKey: WorkspaceRecipientEncryptionKey,
): Promise<Uint8Array> {
  const request = decodeWorkspacePublishRequest(payload);
  return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId: request.contextGraphId,
    senderIdentity: `did:dkg:agent:${agentAddress}`,
    operationId: request.operationId || request.workspaceOperationId,
    workspaceOperationId: request.workspaceOperationId,
    timestampMs: request.timestampMs,
    subGraphName: request.subGraphName,
    plaintext: payload,
    recipients: [recipientKey],
  }));
}

function createEncryptedHandler(
  allowedAddress: string,
  recipientKey: WorkspaceRecipientEncryptionKey,
): SharedMemoryHandler {
  return new SharedMemoryHandler(store, new TypedEventBus(), {
    sharedMemoryOwnedEntities: workspaceOwned,
    localAgentAddresses: () => [allowedAddress],
    workspaceRecipientPrivateKeys: () => [recipientKey],
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

async function insertPrivateAccessPolicy(graph: string): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    object: '"private"',
    graph,
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

describe('SharedMemoryHandler agent-gated gossip', () => {
  beforeEach(() => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('accepts legacy raw SWM gossip for open context graphs with no policy or allowlist', async () => {
    await handler.handle(workspaceMessage('Raw Open', 'ws-agent-gate-raw-open'), PEER_ID);

    await expectStoredName('Raw Open');
    expect(workspaceOwned.get(CONTEXT_GRAPH_ID)?.get(ENTITY)).toBe(PEER_ID);
  });

  it.each([
    ['_meta', META_GRAPH],
    ['ontology', ONTOLOGY_GRAPH],
  ])('rejects legacy raw SWM gossip for explicit private accessPolicy in the %s with no gossip allowlist', async (_label, graph) => {
    await insertPrivateAccessPolicy(graph);

    await handler.handle(workspaceMessage('Private Raw', `ws-agent-gate-private-raw-${_label}`), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it('rejects legacy raw SWM gossip for explicit private accessPolicy with only DKG_ALLOWED_AGENT', async () => {
    const allowed = ethers.Wallet.createRandom();
    await insertPrivateAccessPolicy(META_GRAPH);
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    await handler.handle(workspaceMessage('Private Agent Raw', 'ws-agent-gate-private-agent-raw'), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it('accepts signed SWM gossip for explicit private accessPolicy from a DKG_ALLOWED_AGENT writer', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    handler = createEncryptedHandler(allowed.address, recipientKey);
    await insertPrivateAccessPolicy(META_GRAPH);
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Private Agent Signed', 'ws-agent-gate-private-agent-signed');
    const encrypted = await encryptWorkspaceMessage(allowed.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(allowed, encrypted), PEER_ID);

    await expectStoredName('Private Agent Signed');
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('rejects legacy raw SWM gossip for %s-gated context graphs', async (_label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    await insertAgentGate(predicate, allowed.address);

    await handler.handle(workspaceMessage('Unsigned Gated', `ws-agent-gate-raw-${_label}`), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it('rejects signed plaintext envelopes for agent-gated context graphs', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    let recipientLookups = 0;
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
      workspaceRecipientPrivateKeys: () => {
        recipientLookups += 1;
        return [recipientKey];
      },
    });
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Signed Plaintext', 'ws-agent-gate-signed-plaintext');
    await handler.handle(await signWorkspaceMessage(allowed, raw), PEER_ID);

    await expectWorkspaceEmpty();
    expect(recipientLookups).toBe(0);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('accepts signed SWM gossip from a %s writer', async (label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    handler = createEncryptedHandler(allowed.address, recipientKey);
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage(`${label} Signed`, `ws-agent-gate-signed-${label}`);
    const encrypted = await encryptWorkspaceMessage(allowed.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(allowed, encrypted), PEER_ID);

    await expectStoredName(`${label} Signed`);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('rejects signed SWM gossip from an unauthorized %s writer', async (_label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    handler = createEncryptedHandler(allowed.address, recipientKey);
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage('Denied Signed', `ws-agent-gate-denied-${_label}`);
    const encrypted = await encryptWorkspaceMessage(denied.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(denied, encrypted), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it('does not look up recipient keys or decrypt before rejecting an unauthorized signature', async () => {
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    let recipientLookups = 0;
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
      workspaceRecipientPrivateKeys: () => {
        recipientLookups += 1;
        return [recipientKey];
      },
    });
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Denied Before Decrypt', 'ws-agent-gate-denied-before-decrypt');
    const encrypted = await encryptWorkspaceMessage(denied.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(denied, encrypted), PEER_ID);

    await expectWorkspaceEmpty();
    expect(recipientLookups).toBe(0);
  });

  it('does not look up recipient keys or decrypt before rejecting stale signatures', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    let recipientLookups = 0;
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
      workspaceRecipientPrivateKeys: () => {
        recipientLookups += 1;
        return [recipientKey];
      },
      now: () => Date.parse('2026-05-07T12:00:00.000Z'),
    });
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Stale Before Decrypt', 'ws-agent-gate-stale-before-decrypt');
    const encrypted = await encryptWorkspaceMessage(allowed.address, raw, recipientKey);
    await handler.handle(
      await signWorkspaceMessage(allowed, encrypted, allowed.address, '2026-05-07T11:00:00.000Z'),
      PEER_ID,
    );

    await expectWorkspaceEmpty();
    expect(recipientLookups).toBe(0);
  });

  it('rejects encrypted envelopes whose encrypted context binding differs from the signed envelope', async () => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    let recipientLookups = 0;
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
      workspaceRecipientPrivateKeys: () => {
        recipientLookups += 1;
        return [recipientKey];
      },
    });
    await insertAgentGate(DKG_ONTOLOGY.DKG_ALLOWED_AGENT, allowed.address);

    const raw = workspaceMessage('Cross Context', 'ws-agent-gate-cross-context');
    const encrypted = encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
      contextGraphId: 'other-context-graph',
      senderIdentity: `did:dkg:agent:${allowed.address}`,
      operationId: 'ws-agent-gate-cross-context',
      workspaceOperationId: 'ws-agent-gate-cross-context',
      timestampMs: Date.now(),
      plaintext: raw,
      recipients: [recipientKey],
    }));
    await handler.handle(await signWorkspaceMessage(allowed, encrypted), PEER_ID);

    await expectWorkspaceEmpty();
    expect(recipientLookups).toBe(0);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('rejects legacy raw SWM gossip when DKG_ALLOWED_PEER is combined with %s', async (_label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    await insertPeerGate(PEER_ID);
    await insertAgentGate(predicate, allowed.address);

    await handler.handle(workspaceMessage('Mixed Raw', `ws-agent-gate-mixed-raw-${_label}`), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('rejects signed SWM gossip with a forged %s envelope claim even when DKG_ALLOWED_PEER passes', async (_label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    handler = createEncryptedHandler(allowed.address, recipientKey);
    await insertPeerGate(PEER_ID);
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage('Mixed Forged', `ws-agent-gate-mixed-forged-${_label}`);
    const encrypted = await encryptWorkspaceMessage(denied.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(denied, encrypted, allowed.address), PEER_ID);

    await expectWorkspaceEmpty();
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('accepts signed SWM gossip only when DKG_ALLOWED_PEER and %s both pass', async (label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(allowed.address);
    handler = createEncryptedHandler(allowed.address, recipientKey);
    await insertPeerGate(PEER_ID);
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage(`${label} Mixed Signed`, `ws-agent-gate-mixed-signed-${label}`);
    const encrypted = await encryptWorkspaceMessage(allowed.address, raw, recipientKey);
    await handler.handle(await signWorkspaceMessage(allowed, encrypted), PEER_ID);

    await expectStoredName(`${label} Mixed Signed`);
  });
});
