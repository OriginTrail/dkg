// #2858: the agent keeps a private graph's root-scope SWM on the legacy member
// lane while its RFC-64 authority is not active, by answering `true` from the
// handler's legacy-apply oracle for that graph's root scope. This pins the
// handler side of that contract with a real member share: signed by an
// allowed agent and encrypted to the member's recipient key. The share is
// applied when the oracle admits the root scope and declined, with nothing
// stored, when it does not.
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
  encryptWorkspacePayload,
  generateWorkspaceRecipientEncryptionKey,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '../src/index.js';
import { encodeRootlessWorkspaceRequest } from './_helpers/rootless-workspace.js';

const CONTEXT_GRAPH_ID = 'workspace-handler-private-root-legacy-lane';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const WORKSPACE_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH_ID);
const ENTITY = 'urn:test:workspace-handler-private-root-legacy-lane';
const CURATOR_PEER_ID = '12D3KooWPrivateRootLaneCurator';

let store: OxigraphStore;

async function memberShare(
  curator: ethers.Wallet,
  recipientKey: WorkspaceRecipientEncryptionKey,
  operationId: string,
): Promise<Uint8Array> {
  const raw = encodeRootlessWorkspaceRequest({
    contextGraphId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "Curator root write" <${DATA_GRAPH}> .`,
    ),
    publisherPeerId: CURATOR_PEER_ID,
    shareOperationId: operationId,
    timestampMs: Date.now(),
  });
  const request = decodeWorkspacePublishRequest(raw);
  const encrypted = encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId: CONTEXT_GRAPH_ID,
    senderIdentity: `did:dkg:agent:${curator.address}`,
    operationId: request.operationId || request.shareOperationId,
    shareOperationId: request.shareOperationId,
    timestampMs: request.timestampMs,
    subGraphName: request.subGraphName,
    plaintext: raw,
    recipients: [recipientKey],
  }));
  const timestamp = new Date().toISOString();
  const signature = await curator.signMessage(computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    CONTEXT_GRAPH_ID,
    timestamp,
    encrypted,
  ));
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: CONTEXT_GRAPH_ID,
    agentAddress: curator.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload: encrypted,
  });
}

async function storedRootWrites(): Promise<number> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH ?g { <${ENTITY}> <http://schema.org/name> ?o } `
      + `FILTER(STRSTARTS(STR(?g), "${WORKSPACE_GRAPH}/")) }`,
  );
  return result.type === 'bindings' ? result.bindings.length : -1;
}

describe('SharedMemoryHandler private root scope on the legacy member lane (#2858)', () => {
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it.each([
    [true, true],
    [false, false],
  ])('applies a member private root SHARE only when the oracle admits the root scope: %s', async (
    admitRoot,
    applied,
  ) => {
    const curator = ethers.Wallet.createRandom();
    const member = ethers.Wallet.createRandom();
    const recipientKey = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${member.address}`,
      `did:dkg:agent:${member.address}#test-x25519`,
    );
    await store.insert([
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: META_GRAPH },
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${curator.address}"`, graph: META_GRAPH },
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${member.address}"`, graph: META_GRAPH },
    ]);
    const oracleCalls: Array<string | null> = [];
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: new Map(),
      localAgentAddresses: () => [member.address],
      workspaceRecipientPrivateKeys: () => [recipientKey],
      legacyApplyAllowedOracle: (_contextGraphId, subGraphName) => {
        oracleCalls.push(subGraphName);
        return subGraphName === null ? admitRoot : true;
      },
    });

    const outcome = await handler.handle(
      await memberShare(curator, recipientKey, `private-root-lane-${String(admitRoot)}`),
      CURATOR_PEER_ID,
    );

    expect(oracleCalls).toContain(null);
    expect(outcome.applied).toBe(applied);
    if (!applied) expect(outcome).toMatchObject({ reason: expect.stringContaining('not authoritative') });
    expect(await storedRootWrites()).toBe(applied ? 1 : 0);
  });
});
