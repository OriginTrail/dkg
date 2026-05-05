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
  encodeGossipEnvelope,
  encodeWorkspacePublishRequest,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '../src/index.js';

const CONTEXT_GRAPH_ID = 'workspace-handler-agent-gate';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const WORKSPACE_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH_ID);
const PEER_ID = '12D3KooWAgentGatePeer';
const ENTITY = 'urn:test:workspace-handler-agent-gate';

let store: OxigraphStore;
let workspaceOwned: Map<string, Map<string, string>>;
let handler: SharedMemoryHandler;

function workspaceMessage(name: string, operationId: string): Uint8Array {
  return encodeWorkspacePublishRequest({
    paranetId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "${name}" <${DATA_GRAPH}> .`,
    ),
    manifest: [{ rootEntity: ENTITY, privateTripleCount: 0 }],
    publisherPeerId: PEER_ID,
    workspaceOperationId: operationId,
    timestampMs: Date.now(),
  });
}

async function signWorkspaceMessage(wallet: ethers.Wallet, payload: Uint8Array): Promise<Uint8Array> {
  const timestamp = new Date().toISOString();
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
    agentAddress: wallet.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
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

  it('accepts legacy raw SWM gossip for non-agent-gated context graphs', async () => {
    await handler.handle(workspaceMessage('Raw Open', 'ws-agent-gate-raw-open'), PEER_ID);

    await expectStoredName('Raw Open');
    expect(workspaceOwned.get(CONTEXT_GRAPH_ID)?.get(ENTITY)).toBe(PEER_ID);
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

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('accepts signed SWM gossip from a %s writer', async (label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
    });
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage(`${label} Signed`, `ws-agent-gate-signed-${label}`);
    await handler.handle(await signWorkspaceMessage(allowed, raw), PEER_ID);

    await expectStoredName(`${label} Signed`);
  });

  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('rejects signed SWM gossip from an unauthorized %s writer', async (_label, predicate) => {
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
    });
    await insertAgentGate(predicate, allowed.address);

    const raw = workspaceMessage('Denied Signed', `ws-agent-gate-denied-${_label}`);
    await handler.handle(await signWorkspaceMessage(denied, raw), PEER_ID);

    await expectWorkspaceEmpty();
  });
});
