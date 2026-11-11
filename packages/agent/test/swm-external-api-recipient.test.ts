import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY, PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, contextGraphDataUri, contextGraphMetaUri,
  contextGraphSharedMemoryUri, decodeGossipEnvelope, decodeSwmSenderKeyPackageAck,
  decodeSwmSenderKeyMessage, type OperationContext,
} from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipientKeys, type SharedMemoryHandler } from '@origintrail-official/dkg-publisher';
import { DKGAgent, type AgentKeyRecord } from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';

type Recipient = Awaited<ReturnType<typeof resolveWorkspaceAgentRecipientKeys>>[number];
interface Internals {
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  node: { peerId: { toString(): string } };
  gossip: object;
  messenger: { sendReliable(peer: string, protocol: string, payload: Uint8Array): Promise<ReliableSendResult> };
  handleSwmSenderKeyPackage(data: Uint8Array, from: string): Promise<Uint8Array>;
  getOrCreateSharedMemoryHandler(): SharedMemoryHandler;
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string; sender: AgentKeyRecord & { privateKey: string };
    recipients: Recipient[]; membershipHash: string; ctx: OperationContext;
  }): Promise<unknown>;
}
const CG = 'example-private-programs';
const SOURCE = '(strategy example/read-device (version "1.0.0") (scope graph:example-data) (goal read-device) (supervise one-for-one (max-restarts 1) (window-ms 60000) (delegate reader (grant dkg.query) (call dkg/query@1 "device-reading"))))';
const PROGRAM = 'urn:example:program:read-device:1';
const SR = 'https://origintrail.io/semantic-runtime/v1#';
const SENDER_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const REMOTE_PEER = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const agents: DKGAgent[] = [];
afterEach(async () => { for (const agent of agents.splice(0)) await agent.stop(); });

async function makeAgent(name: string, peer: string) {
  const agent = await DKGAgent.create({ name, kaNumberAllocator: makeTestKaNumberAllocator(), chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  const internal = agent as unknown as Internals;
  Object.defineProperty(internal.node, 'peerId', { value: { toString: () => peer }, configurable: true });
  return { agent, internal };
}

async function fixture(withPublicEncryptionKey = false) {
  const sender = await makeAgent('ProgramSender', SENDER_PEER);
  const remote = await makeAgent('ProgramRecipient', REMOTE_PEER);
  const owner = await sender.agent.registerAgent('owner');
  const recipient = await remote.agent.registerAgent('remote-reader');
  sender.internal.defaultAgentAddress = owner.agentAddress;
  remote.internal.defaultAgentAddress = recipient.agentAddress;
  const external = await sender.agent.registerAgent('external-api-reader', {
    publicKey: recipient.publicKey,
    ...(withPublicEncryptionKey ? {
      publicEncryptionKey: recipient.workspaceEncryptionKeys[0]!.publicEncryptionKey,
      encryptionKeyProof: recipient.workspaceEncryptionKeys[0]!.encryptionKeyProof,
    } : {}),
  });
  // Agent-signed encryption key with the remote custodian's peer ID. No
  // private key or API token is copied into the sender's store.
  const key = recipient.workspaceEncryptionKeys[0]!;
  await sender.agent.store.insert([
    ['publicEncryptionKey', key.publicEncryptionKey],
    ['encryptionKeyAlgorithm', key.encryptionKeyAlgorithm],
    ['encryptionKeyProof', key.encryptionKeyProof],
    ['peerId', REMOTE_PEER],
  ].map(([predicate, value]) => ({
    subject: `did:dkg:agent:${recipient.agentAddress}`,
    predicate: `https://dkg.network/ontology#${predicate}`,
    object: JSON.stringify(value), graph: 'urn:example:remote-profile',
  })));
  // When the API record also has public key metadata, give that profile the
  // same resolved remote peer; a missing or self peer is tested separately.
  if (withPublicEncryptionKey) await sender.agent.store.insert([{
    subject: `did:dkg:agent:${recipient.agentAddress}`, predicate: DKG_ONTOLOGY.DKG_PEER_ID,
    object: JSON.stringify(REMOTE_PEER), graph: 'did:dkg:system/agents',
  }]);
  for (const node of [sender, remote]) {
    await node.agent.store.insert([owner, recipient].map(record => ({
      subject: contextGraphDataUri(CG), predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: JSON.stringify(record.agentAddress), graph: contextGraphMetaUri(CG),
    })));
  }
  const updates: Uint8Array[] = [];
  const applied: unknown[] = [];
  const send = vi.fn(async (peer: string, protocol: string, payload: Uint8Array): Promise<ReliableSendResult> => {
    expect(peer).toBe(REMOTE_PEER);
    if (protocol === PROTOCOL_SWM_UPDATE) {
      updates.push(payload);
      const outcome = await remote.internal.getOrCreateSharedMemoryHandler().handle(payload, SENDER_PEER);
      applied.push(outcome);
      return { delivered: true, response: new Uint8Array(outcome.applied ? [] : [1]), attempts: 1, messageId: 'test-share' };
    }
    expect(protocol).toBe(PROTOCOL_SWM_SENDER_KEY);
    const response = await remote.internal.handleSwmSenderKeyPackage(payload, SENDER_PEER);
    expect(decodeSwmSenderKeyPackageAck(response).accepted).toBe(true);
    return { delivered: true, response, attempts: 1, messageId: 'test-sender-key' };
  });
  sender.internal.messenger = { sendReliable: send };
  const recipients = await resolveWorkspaceAgentRecipientKeys(sender.agent.store, recipient.agentAddress);
  const distribute = (targets = recipients) => sender.internal.createAndDistributeSwmSenderKeyEpoch({
    contextGraphId: CG, sender: owner as AgentKeyRecord & { privateKey: string }, recipients: targets,
    membershipHash: 'sha256:offline-custody-test', ctx: { operationId: 'test', operationName: 'share' },
  });
  return { sender, remote, owner, recipient, external, send, recipients, distribute, updates, applied };
}

describe('SWM sender-key delivery with external API registrations', () => {
  it.each([false, true])('shares an encrypted Program with its remote custodian (API encryption metadata: %s)', async (publicMetadata) => {
    const f = await fixture(publicMetadata);
    const messages: Uint8Array[] = [];
    f.sender.internal.gossip = {
      subscribe() {}, unsubscribe() {}, onMessage() {}, getSubscribers: () => [],
      publish: async (_topic: string, data: Uint8Array) => { messages.push(data); },
    };
    expect(f.external.mode).toBe('self-sovereign');
    expect(f.external.privateKey).toBeUndefined();
    expect(f.external.workspaceEncryptionKeys.every(key => !key.privateEncryptionKey)).toBe(true);
    const lane = { agentAddress: f.owner.agentAddress };
    await f.sender.agent.assertion.create(CG, 'read-device', lane);
    await f.sender.agent.assertion.write(CG, 'read-device', [
      { subject: PROGRAM, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${SR}Program`, graph: '' },
      { subject: PROGRAM, predicate: `${SR}language`, object: '"sexpr-v1"', graph: '' },
      { subject: PROGRAM, predicate: `${SR}version`, object: '"1.0.0"', graph: '' },
      { subject: PROGRAM, predicate: `${SR}requiresTool`, object: 'urn:example:tool:device-reading', graph: '' },
      { subject: PROGRAM, predicate: `${SR}source`, object: JSON.stringify(SOURCE), graph: '' },
    ], lane);
    await f.sender.agent.assertion.finalize(CG, 'read-device', { ...lane, authorAgentAddress: f.owner.agentAddress });
    const promoted = await f.sender.agent.assertion.promote(CG, 'read-device', { ...lane, authorAgentAddress: f.owner.agentAddress });
    expect(promoted).toMatchObject({ sealed: true, promotedCount: 5 });
    await f.sender.agent.awaitInFlightSubstrateFanOuts();
    expect(f.send.mock.calls.filter(([, protocol]) => protocol === PROTOCOL_SWM_SENDER_KEY)).toHaveLength(1);
    // Small recipient sets use reliable SWM fan-out; the real receive handler
    // verifies the signed envelope, decrypts and materializes the Program.
    expect(f.updates).toHaveLength(1);
    expect(f.applied).toEqual([expect.objectContaining({ applied: true })]);
    const envelope = decodeGossipEnvelope(f.updates[0]!);
    expect(decodeSwmSenderKeyMessage(envelope.payload).ciphertext.length).toBeGreaterThan(0);
    expect(Buffer.from(f.updates[0]!).toString('utf8')).not.toContain(SOURCE);
    const readback = await f.remote.agent.store.query(`SELECT ?source WHERE { GRAPH ?g { <${PROGRAM}> <${SR}source> ?source } FILTER(STRSTARTS(STR(?g), "${contextGraphSharedMemoryUri(CG)}/")) }`);
    expect(readback.type).toBe('bindings');
    if (readback.type !== 'bindings') throw new Error('Expected Program source bindings');
    expect(readback.bindings).toHaveLength(1);
    expect(readback.bindings[0]!.source).toContain(JSON.stringify(SOURCE));
    expect(f.sender.agent.resolveAgentByToken(f.external.authToken)).toBe(f.recipient.agentAddress);
    expect(f.external.workspaceEncryptionKeys.every(key => !key.privateEncryptionKey)).toBe(true);
  });

  it('does not mistake a different private key for custody of the requested key', async () => {
    const f = await fixture();
    const otherKeyRecord = await f.sender.agent.registerAgent('unrelated-key');
    f.external.workspaceEncryptionKeys.push({ ...otherKeyRecord.workspaceEncryptionKeys[0]! });
    await f.distribute();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact active owned key locally without requiring a remote peer', async () => {
    const f = await fixture();
    // Model a self-sovereign signing identity with an explicitly provisioned
    // local encryption key; the Ethereum signing key is still external.
    f.external.workspaceEncryptionKeys = [{ ...f.recipient.workspaceEncryptionKeys[0]! }];
    await f.distribute(f.recipients.map(recipient => ({ ...recipient, peerId: undefined })));
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['missing', 'revoked'] as const)('keeps %s custodial keys fail-closed even with a remote profile', async (state) => {
    const f = await fixture();
    f.external.mode = 'custodial';
    // Corrupt or retired local custody must not become remote delegation.
    f.external.workspaceEncryptionKeys = [{ ...f.recipient.workspaceEncryptionKeys[0]! }];
    if (state === 'missing') delete f.external.workspaceEncryptionKeys[0]!.privateEncryptionKey;
    else f.external.workspaceEncryptionKeys[0]!.revokedAt = new Date().toISOString();
    await expect(f.distribute()).rejects.toThrow('SWM Sender Key setup rejected');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('does not route around a revoked key of a self-sovereign identity', async () => {
    const f = await fixture();
    f.external.workspaceEncryptionKeys = [{ ...f.recipient.workspaceEncryptionKeys[0]!, revokedAt: new Date().toISOString() }];
    await expect(f.distribute()).rejects.toThrow('SWM Sender Key setup rejected');
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([undefined, SENDER_PEER])('rejects an external API record without a usable remote destination (%s)', async (peerId) => {
    const f = await fixture();
    await expect(f.distribute(f.recipients.map(recipient => ({ ...recipient, peerId })))).rejects.toThrow('SWM Sender Key setup rejected');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('honors a remote custody rejection instead of treating delivery as acceptance', async () => {
    const f = await fixture();
    f.remote.internal.localAgents.clear();
    f.sender.internal.messenger.sendReliable = vi.fn(async (_peer, _protocol, payload) => ({
      delivered: true, attempts: 1, messageId: 'wrong-custodian',
      response: await f.remote.internal.handleSwmSenderKeyPackage(payload, SENDER_PEER),
    }));
    await expect(f.distribute()).rejects.toThrow('SWM Sender Key setup rejected');
    expect(f.sender.internal.messenger.sendReliable).toHaveBeenCalledTimes(1);
  });
});
