// SPDX-License-Identifier: Apache-2.0

// The receiver's second look at the agent gate of a shared-memory write whose
// signer its projected gate lacked (`swm-write-gate-refresh.ts`). The projected
// gate here is the join-time roster of a private graph: the local member and
// the curator. A member approved after that roster was taken writes into the
// graph; the injected refresh oracle stands in for the agent's fresh read of the
// canonical gate after a curator metadata refresh.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  computeGossipSigningPayload,
  contextGraphDataUri,
  contextGraphSharedMemoryUri,
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
import {
  retryAgentEnvelopeWithRefreshedGate,
  type SwmAgentGateRefreshOracle,
  type SwmAgentGateRefreshResult,
} from '../src/swm-write-gate-refresh.js';
import { encodeRootlessWorkspaceRequest } from './_helpers/rootless-workspace.js';

const CONTEXT_GRAPH_ID = 'workspace-handler-agent-gate-refresh';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const WORKSPACE_GRAPH = contextGraphSharedMemoryUri(CONTEXT_GRAPH_ID);
const PEER_ID = '12D3KooWAgentGateRefreshPeer';
const ENTITY = 'urn:test:workspace-handler-agent-gate-refresh';

const localMember = ethers.Wallet.createRandom();
const curator = ethers.Wallet.createRandom();
const newMember = ethers.Wallet.createRandom();
const PROJECTED_GATE = [localMember.address, curator.address];
const FRESH_GATE = [...PROJECTED_GATE, newMember.address];

let store: OxigraphStore;
let recipientKey: WorkspaceRecipientEncryptionKey;

function workspaceMessage(name: string, operationId: string): Uint8Array {
  return encodeRootlessWorkspaceRequest({
    contextGraphId: CONTEXT_GRAPH_ID,
    nquads: new TextEncoder().encode(
      `<${ENTITY}> <http://schema.org/name> "${name}" <${DATA_GRAPH}> .`,
    ),
    publisherPeerId: PEER_ID,
    shareOperationId: operationId,
    timestampMs: Date.now(),
  });
}

async function signWorkspaceMessage(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  payload: Uint8Array,
  claimedAgentAddress = wallet.address,
): Promise<Uint8Array> {
  const timestamp = new Date().toISOString();
  const signature = await wallet.signMessage(
    computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, CONTEXT_GRAPH_ID, timestamp, payload),
  );
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

async function encryptWorkspaceMessage(senderAddress: string, payload: Uint8Array): Promise<Uint8Array> {
  const request = decodeWorkspacePublishRequest(payload);
  return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId: request.contextGraphId,
    senderIdentity: `did:dkg:agent:${senderAddress}`,
    operationId: request.operationId || request.shareOperationId,
    shareOperationId: request.shareOperationId,
    timestampMs: request.timestampMs,
    subGraphName: request.subGraphName,
    plaintext: payload,
    recipients: [recipientKey],
  }));
}

/** A signed, encrypted write by `writer` (claimed as `claimedAgentAddress`). */
async function writeBy(
  writer: ethers.HDNodeWallet,
  name: string,
  claimedAgentAddress = writer.address,
): Promise<Uint8Array> {
  const encrypted = await encryptWorkspaceMessage(writer.address, workspaceMessage(name, `ws-gate-refresh-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`));
  return signWorkspaceMessage(writer, encrypted, claimedAgentAddress);
}

/** A receiving member of a private graph whose projected gate is the join-time roster. */
function createHandler(agentGateRefreshOracle?: SwmAgentGateRefreshOracle): SharedMemoryHandler {
  return new SharedMemoryHandler(store, new TypedEventBus(), {
    sharedMemoryOwnedEntities: new Map(),
    localAgentAddresses: () => [localMember.address],
    workspaceRecipientPrivateKeys: () => [recipientKey],
    contextGraphMetaOracle: async () => ({
      accessPolicy: 'private',
      allowedAgents: PROJECTED_GATE,
      participantAgents: [],
      revokedAgents: [],
    }),
    ...(agentGateRefreshOracle === undefined ? {} : { agentGateRefreshOracle }),
  });
}

async function storedName(): Promise<string | undefined> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH ?g { <${ENTITY}> <http://schema.org/name> ?o } ` +
      `FILTER(STRSTARTS(STR(?g), "${WORKSPACE_GRAPH}/")) }`,
  );
  if (result.type !== 'bindings') return undefined;
  return result.bindings[0]?.['o'];
}

describe('SharedMemoryHandler: second look at the agent gate for a signer the projected gate lacked', () => {
  beforeEach(() => {
    store = new OxigraphStore();
    recipientKey = generateWorkspaceRecipientEncryptionKey(
      `did:dkg:agent:${localMember.address}`,
      `did:dkg:agent:${localMember.address}#test-x25519`,
    );
  });

  it('applies a write by a member the refreshed gate contains, asking the oracle once for that signer', async () => {
    const oracle = vi.fn<SwmAgentGateRefreshOracle>(async () => ({ kind: 'available', agentAddresses: FRESH_GATE }));
    const handler = createHandler(oracle);

    const outcome = await handler.handle(await writeBy(newMember, 'Late Member'), PEER_ID);

    expect(outcome).toMatchObject({ applied: true });
    expect(oracle).toHaveBeenCalledTimes(1);
    expect(oracle).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, ethers.getAddress(newMember.address));
    await expect(storedName()).resolves.toBe('"Late Member"');
  });

  it('answers a retryable rejection when the fresh gate authority is unavailable but can heal', async () => {
    const handler = createHandler(async () => ({
      kind: 'unavailable',
      reason: 'chain-participant-authority-unavailable',
      retryable: true,
    }));

    const outcome = await handler.handle(await writeBy(newMember, 'Gate Unavailable'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: true, reason: 'agent envelope verification failed' });
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('keeps the rejection permanent when the fresh gate authority is unavailable for good', async () => {
    const handler = createHandler(async () => ({
      kind: 'unavailable',
      reason: 'chain-participant-authority-unsupported',
      retryable: false,
    }));

    const outcome = await handler.handle(await writeBy(newMember, 'Gate Unsupported'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: false });
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('rejects permanently when the fresh gate still excludes the signer', async () => {
    const oracle = vi.fn<SwmAgentGateRefreshOracle>(async () => ({ kind: 'available', agentAddresses: PROJECTED_GATE }));
    const handler = createHandler(oracle);

    const outcome = await handler.handle(await writeBy(newMember, 'Still Excluded'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: false, reason: 'agent envelope verification failed' });
    expect(oracle).toHaveBeenCalledTimes(1);
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('rejects permanently when the refreshed gate has no agent roster at all', async () => {
    const handler = createHandler(async () => ({ kind: 'ungated' }));

    const outcome = await handler.handle(await writeBy(newMember, 'Ungated'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: false });
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('answers a retryable rejection when the oracle itself throws', async () => {
    const handler = createHandler(async () => { throw new Error('refresh exploded'); });

    const outcome = await handler.handle(await writeBy(newMember, 'Oracle Threw'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: true });
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('does not consult the oracle for an envelope whose signature does not verify', async () => {
    const oracle = vi.fn<SwmAgentGateRefreshOracle>(async () => ({ kind: 'available', agentAddresses: FRESH_GATE }));
    const handler = createHandler(oracle);

    // Signed by the new member but claiming the curator: the recovered signer
    // does not match the envelope agent, which no fresh gate can repair.
    const outcome = await handler.handle(await writeBy(newMember, 'Spoofed', curator.address), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: false });
    expect(oracle).not.toHaveBeenCalled();
    await expect(storedName()).resolves.toBeUndefined();
  });

  it('does not consult the oracle for a writer the projected gate already contains', async () => {
    const oracle = vi.fn<SwmAgentGateRefreshOracle>(async () => ({ kind: 'available', agentAddresses: FRESH_GATE }));
    const handler = createHandler(oracle);

    const outcome = await handler.handle(await writeBy(curator, 'Known Writer'), PEER_ID);

    expect(outcome).toMatchObject({ applied: true });
    expect(oracle).not.toHaveBeenCalled();
    await expect(storedName()).resolves.toBe('"Known Writer"');
  });

  it('without an oracle a signer outside the projected gate is rejected permanently, as before', async () => {
    const handler = createHandler();

    const outcome = await handler.handle(await writeBy(newMember, 'No Oracle'), PEER_ID);

    expect(outcome).toMatchObject({ applied: false, retryable: false, reason: 'agent envelope verification failed' });
    await expect(storedName()).resolves.toBeUndefined();
  });
});

describe('retryAgentEnvelopeWithRefreshedGate', () => {
  const base = {
    contextGraphId: CONTEXT_GRAPH_ID,
    signerAddress: newMember.address,
    logWarn: () => {},
    logInfo: () => {},
  };

  it('verifies again against the fresh gate and reports its answer', async () => {
    const verify = vi.fn(async (gate: string[]) => gate.includes(newMember.address));
    const info = vi.fn();
    await expect(retryAgentEnvelopeWithRefreshedGate({
      ...base,
      logInfo: info,
      oracle: async () => ({ kind: 'available', agentAddresses: FRESH_GATE }),
      verify,
    })).resolves.toEqual({ accepted: true });
    expect(verify).toHaveBeenCalledWith(FRESH_GATE);
    expect(info).toHaveBeenCalledTimes(1);

    await expect(retryAgentEnvelopeWithRefreshedGate({
      ...base,
      oracle: async () => ({ kind: 'available', agentAddresses: PROJECTED_GATE }),
      verify,
    })).resolves.toEqual({ accepted: false, retryable: false });
  });

  it('does nothing without an oracle or without a gate miss', async () => {
    const verify = vi.fn(async () => true);
    const oracle = vi.fn<SwmAgentGateRefreshOracle>(async () => ({ kind: 'ungated' }));
    await expect(retryAgentEnvelopeWithRefreshedGate({ ...base, oracle: undefined, verify }))
      .resolves.toEqual({ accepted: false, retryable: false });
    await expect(retryAgentEnvelopeWithRefreshedGate({ ...base, oracle, signerAddress: undefined, verify }))
      .resolves.toEqual({ accepted: false, retryable: false });
    expect(verify).not.toHaveBeenCalled();
    expect(oracle).not.toHaveBeenCalled();
  });

  it.each<[string, SwmAgentGateRefreshResult, boolean]>([
    ['a healing unavailable authority is retryable', { kind: 'unavailable', reason: 'chain-access-policy-timeout', retryable: true }, true],
    ['a terminal unavailable authority is permanent', { kind: 'unavailable', reason: 'chain-participant-authority-invalid', retryable: false }, false],
    ['no roster at all is permanent', { kind: 'ungated' }, false],
  ])('%s', async (_label, fresh, retryable) => {
    const verify = vi.fn(async () => true);
    const warn = vi.fn();
    await expect(retryAgentEnvelopeWithRefreshedGate({ ...base, logWarn: warn, oracle: async () => fresh, verify }))
      .resolves.toEqual({ accepted: false, retryable });
    expect(verify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
