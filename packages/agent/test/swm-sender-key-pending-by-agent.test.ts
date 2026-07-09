// PR-2 (SWM-fanout plan): soft-success on missing peerId.
//
// Pre-PR-2 a recipient agent with no `dkg:peerId` triple was a HARD
// failure inside `createAndDistributeSwmSenderKeyEpoch`. If EVERY key
// for an agent landed in that branch, the publish threw — one
// never-seen member could block writes for everyone else in the
// context graph.
//
// PR-2 turns the no-peerId branch into a soft success: we durably
// remember the package bytes in `pendingSenderKeyByAgent` (keyed by
// lowercased recipientAgentAddress) and return success up the loop.
// A subsequent `connection:open` event or later publish retry drives
// queued-package drain and replays each queued package via
// `messenger.sendReliable` once a peerId is known.
//
// Three contracts pinned here:
//   1. no-peerId no longer throws (publish proceeds; row enqueued).
//   2. drain replays the queued package once we know the peerId,
//      either through reconnect or later recipient resolution, and
//      removes the row when the Sender Key ACK confirms acceptance.
//   3. enqueuing a newer epoch for the same (sender, recipient)
//      evicts older epochs — they're superseded by definition.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  Logger,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  computeSwmSenderKeyMembershipHash,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeSwmSenderKeyPackageAck,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  workspaceAgentEncryptionKeyId,
  type OperationContext,
  type SwmSenderKeyPackageAckReasonCode,
} from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipients } from '@origintrail-official/dkg-publisher';
import {
  DKGAgent,
  agentFromPrivateKey,
  buildAgentProfile,
  type AgentKeyRecord,
  type DiscoveredAgent,
  type PendingSenderKeyEntry,
} from '../src/index.js';
import { swmSenderStateKey } from '../src/dkg-agent-swm-state.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';

type StubMessenger = {
  sendReliable: (
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: { messageId?: string },
  ) => Promise<ReliableSendResult>;
};

interface PendingInternals {
  messenger: StubMessenger;
  node: { peerId: { toString(): string } };
  config: { dataDir?: string };
  discovery: { findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> };
  store: TripleStore;
  pendingSenderKeyByAgent: Map<string, PendingSenderKeyEntry[]>;
  swmSenderKeyStateLoaded: boolean;
  swmSenderKeySendStates: Map<string, {
    contextGraphId: string;
    subGraphName?: string;
    senderAgentAddress: string;
    epochId: string;
    membershipHash: string;
    createdAtMs: number;
    nextMessageIndex: number;
    chainKey: Uint8Array;
    senderSigningPublicKey: Uint8Array;
    senderSigningSecretKey: Uint8Array;
  }>;
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly FakeRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<unknown>;
  loadSwmSenderKeyState(): Promise<void>;
  saveSwmSenderKeyState(): Promise<void>;
  drainPendingSenderKeyForPeer(peerId: string): Promise<number>;
  drainPendingSenderKeyForRecipients(recipients: readonly FakeRecipient[], ctx?: OperationContext): Promise<number>;
  _resolveCuratedChainKeyContext(
    contextGraphId: string,
    subGraphName: string | undefined,
    authorAgentAddress: string | undefined,
    explicitPolicyTargetContextGraphId: string | undefined,
    logPrefix: string,
    options?: { aeadBindingContextGraphId?: string },
  ): Promise<{ chainKey: Uint8Array; aeadCgId: string; senderAddress: string } | undefined>;
}

type LocalSendState = PendingInternals['swmSenderKeySendStates'] extends Map<string, infer State> ? State : never;

interface FakeRecipient {
  agentAddress: string;
  peerId?: string;
  recipientKeyId: string;
  recipientId: string;
  purpose: typeof WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes: Uint8Array;
}

function makeFakeRecipient(opts: { peerId?: string } = {}): FakeRecipient {
  const wallet = ethers.Wallet.createRandom();
  const agentAddress = wallet.address;
  const recipientId = `did:dkg:agent:${agentAddress.toLowerCase()}`;
  const recipientKeyId = `${recipientId}#x25519-${ethers.id(wallet.privateKey).slice(2, 34)}`;
  const key = generateWorkspaceRecipientEncryptionKey(recipientId, recipientKeyId);
  return {
    agentAddress,
    peerId: opts.peerId, // explicitly undefined for the no-peerId branch
    recipientKeyId,
    recipientId,
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes!,
  };
}

function agentUri(address: string): string {
  return `did:dkg:agent:${ethers.getAddress(address)}`;
}

async function insertAgentGate(store: TripleStore, contextGraphId: string, address: string): Promise<void> {
  await store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${ethers.getAddress(address)}"`,
    graph: contextGraphMetaUri(contextGraphId),
  }]);
}

async function insertVerifiedAgentEncryptionKey(
  store: TripleStore,
  wallet: ethers.Wallet,
  opts: { peerId?: string } = {},
): Promise<FakeRecipient> {
  const recipientId = agentUri(wallet.address);
  const key = generateWorkspaceRecipientEncryptionKey(
    recipientId,
    `${recipientId}#test-x25519-${ethers.id(wallet.address).slice(2, 10)}`,
  );
  const publicKeyBytes = key.publicKeyBytes!;
  const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const proof = wallet.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;
  const quads = [
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
      object: `"${encodeWorkspaceEncryptionKey(publicKeyBytes)}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph: 'did:dkg:system/agents',
    },
  ];
  if (opts.peerId) {
    quads.push({
      subject: recipientId,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: `"${opts.peerId}"`,
      graph: 'did:dkg:system/agents',
    });
  }
  await store.insert(quads);
  return {
    agentAddress: ethers.getAddress(wallet.address),
    peerId: opts.peerId,
    recipientId,
    recipientKeyId: workspaceAgentEncryptionKeyId(wallet.address, publicKeyBytes),
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  };
}

function installStubMessenger(
  internals: PendingInternals,
  sendReliable: StubMessenger['sendReliable'],
): void {
  internals.messenger = { sendReliable };
  if (!internals.node) {
    (internals as { node: { peerId: { toString(): string } } }).node = {
      peerId: { toString: () => '12D3KooWStubLocalPeerForPendingTest' },
    };
  }
}

function installStubDiscovery(
  internals: PendingInternals,
  byPeerId: (peerId: string) => DiscoveredAgent | null,
): void {
  (internals as { discovery: PendingInternals['discovery'] }).discovery = {
    findAgentByPeerId: async (peerId: string) => byPeerId(peerId),
  };
}

function senderKeyAck(
  accepted: boolean,
  reason?: string,
  reasonCode?: SwmSenderKeyPackageAckReasonCode,
): Uint8Array {
  return encodeSwmSenderKeyPackageAck({
    version: SWM_SENDER_KEY_PACKAGE_VERSION,
    type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
    accepted,
    reason,
    reasonCode,
  });
}

async function bootAgent(opts: { dataDir?: string } = {}): Promise<{ agent: DKGAgent; internals: PendingInternals }> {
  const agent = await DKGAgent.create({
    name: 'PendingSenderKeyTest',
    chainAdapter: new MockChainAdapter(),
    dataDir: opts.dataDir,
  });
  const internals = agent as unknown as PendingInternals;
  return { agent, internals };
}

describe('createAndDistributeSwmSenderKeyEpoch: missing-peerId soft success', () => {
  let agent: DKGAgent | null = null;
  const tempDirs: string[] = [];
  afterEach(async () => {
    Logger.setSink(null);
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('does not throw when every recipient has no peerId; enqueues each', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // No messenger.sendReliable should be invoked when peerId is absent;
    // install a stub that throws so a regression that calls it would
    // fail loudly.
    installStubMessenger(internals, async () => {
      throw new Error('sendReliable must not be called on no-peerId branch');
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const recipients = [makeFakeRecipient(), makeFakeRecipient()];

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/no-peerid',
        sender,
        recipients,
        membershipHash: 'sha256:no-peerid',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).resolves.toBeDefined();

    // Two distinct recipient agents → two queue entries (one per agent).
    expect(internals.pendingSenderKeyByAgent.size).toBe(2);
    for (const recipient of recipients) {
      const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
      expect(queue).toBeDefined();
      expect(queue!).toHaveLength(1);
      expect(queue![0].recipientKeyId).toBe(recipient.recipientKeyId);
      expect(queue![0].packageBytes.byteLength).toBeGreaterThan(0);
    }
  });

  it('persists pending sender-key packages across state reload', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-pending-'));
    tempDirs.push(dataDir);
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    internals.config.dataDir = dataDir;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/pending-persist',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:pending-persist',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    await internals.saveSwmSenderKeyState();

    const state = JSON.parse(await readFile(join(dataDir, 'swm-sender-keys.json'), 'utf-8')) as {
      pending?: Array<Record<string, unknown>>;
    };
    expect(state.pending).toHaveLength(1);

    internals.pendingSenderKeyByAgent.clear();
    internals.swmSenderKeyStateLoaded = false;
    await internals.loadSwmSenderKeyState();

    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(1);
    expect(queue![0].recipientKeyId).toBe(recipient.recipientKeyId);
    expect(queue![0].contextGraphId).toBe('test-cg/pending-persist');
    expect(queue![0].packageBytes.length).toBeGreaterThan(0);
  });

  it('persists queued sender-key retries before throwing aggregated setup failures', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-pending-fatal-'));
    tempDirs.push(dataDir);
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    internals.config.dataDir = dataDir;

    const malformedAckRecipient = makeFakeRecipient({ peerId: 'peer-malformed-ack' });
    const fatalRecipient = makeFakeRecipient({ peerId: 'peer-fatal-rejection' });
    installStubMessenger(internals, async (peerId) => {
      if (peerId === malformedAckRecipient.peerId) {
        return {
          delivered: true,
          response: new Uint8Array([0xff, 0x01, 0x02]),
          attempts: 1,
          messageId: 'm-persist-before-fatal-malformed',
        };
      }
      return {
        delivered: true,
        response: senderKeyAck(false, 'package signature could not be verified', 'bad-signature'),
        attempts: 1,
        messageId: 'm-persist-before-fatal-terminal',
      };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/pending-persist-before-fatal',
        sender,
        recipients: [malformedAckRecipient, fatalRecipient],
        membershipHash: 'sha256:pending-persist-before-fatal',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow('SWM Sender Key setup rejected by 1 agent(s)');

    const state = JSON.parse(await readFile(join(dataDir, 'swm-sender-keys.json'), 'utf-8')) as {
      pending?: Array<{ recipientAgentAddress?: string; recipientKeyId?: string }>;
    };
    expect(state.pending).toHaveLength(1);
    expect(state.pending![0].recipientAgentAddress).toBe(malformedAckRecipient.agentAddress.toLowerCase());
    expect(state.pending![0].recipientKeyId).toBe(malformedAckRecipient.recipientKeyId);
  });

  it('skips malformed pending rows without clearing valid sender state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-pending-corrupt-'));
    tempDirs.push(dataDir);
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    internals.config.dataDir = dataDir;

    installStubMessenger(internals, async () => ({
      delivered: true,
      response: senderKeyAck(true),
      attempts: 1,
      messageId: 'm-pending-corrupt-preserve-send',
    }));

    const recipient = makeFakeRecipient({ peerId: 'peer-accepted' });
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const sendState = await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/pending-corrupt',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:pending-corrupt',
      ctx: { operationId: 'test-op', operationName: 'share' },
    }) as LocalSendState;
    const stateKey = swmSenderStateKey(
      sendState.contextGraphId,
      sendState.subGraphName,
      sendState.senderAgentAddress,
    );
    internals.swmSenderKeySendStates.set(stateKey, sendState);
    await internals.saveSwmSenderKeyState();

    const path = join(dataDir, 'swm-sender-keys.json');
    const state = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    state.pending = [{
      senderAgentAddress: sender.agentAddress,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: recipient.recipientKeyId,
      epochId: sendState.epochId,
      contextGraphId: sendState.contextGraphId,
      packageBytes: '%%%not-base64%%%',
      createdAtMs: Date.now(),
    }];
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });

    internals.swmSenderKeySendStates.clear();
    internals.pendingSenderKeyByAgent.clear();
    internals.swmSenderKeyStateLoaded = false;
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push({ level: entry.level, message: entry.message }));
    await internals.loadSwmSenderKeyState();

    expect(internals.swmSenderKeySendStates.get(stateKey)?.epochId).toBe(sendState.epochId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('Skipped malformed SWM sender-key pending row #1'),
    }));
    const skippedLog = logs.find((entry) => entry.message.includes('Skipped malformed SWM sender-key pending row #1'));
    expect(skippedLog?.message).toContain(sendState.contextGraphId);
    expect(skippedLog?.message).toContain(recipient.agentAddress);
  });

  it('delivers pending package once the recipient peer connects', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sendCalls: { peerId: string; payload: Uint8Array }[] = [];
    installStubMessenger(internals, async (peerId, _protocolId, payload) => {
      sendCalls.push({ peerId, payload });
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-drain' };
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // Now simulate connection:open by stubbing the discovery resolver
    // and calling the drain helper directly.
    const knownPeerId = '12D3KooWFinallyOnlineForDrainTest';
    installStubDiscovery(internals, (peerId) => {
      if (peerId !== knownPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'drain-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    const drained = await internals.drainPendingSenderKeyForPeer(knownPeerId);
    expect(drained).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].peerId).toBe(knownPeerId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('uses a stable messageId for repeated pending retry sends', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/stable-message-id',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:stable-message-id',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    const knownPeerId = '12D3KooWStableMessageIdPeer';
    installStubDiscovery(internals, (peerId) => {
      if (peerId !== knownPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'stable-message-id-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    const messageIds: Array<string | undefined> = [];
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => {
      messageIds.push(opts?.messageId);
      return {
        delivered: false,
        queued: true,
        attempts: 1,
        messageId: opts?.messageId ?? 'missing-message-id',
        error: 'recipient still offline',
      };
    });

    expect(await internals.drainPendingSenderKeyForPeer(knownPeerId)).toBe(0);
    expect(await internals.drainPendingSenderKeyForPeer(knownPeerId)).toBe(0);

    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toMatch(/^swm-sender-key:[0-9a-f]{64}$/);
    expect(messageIds[1]).toBe(messageIds[0]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('keeps transport-undelivered setup in local pending queue for ACK-aware retry', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const peerId = '12D3KooWInitialTransportUndeliveredPeer';
    const recipient = makeFakeRecipient({ peerId });
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const messageIds: Array<string | undefined> = [];
    let call = 0;
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => {
      call += 1;
      messageIds.push(opts?.messageId);
      if (call === 1) {
        return {
          delivered: false,
          queued: true,
          attempts: 1,
          messageId: opts?.messageId ?? 'missing-message-id',
          error: 'recipient temporarily offline',
        };
      }
      return {
        delivered: true,
        response: new Uint8Array([0xff, 0x01, 0x02]),
        attempts: 1,
        messageId: opts?.messageId ?? 'missing-message-id',
      };
    });

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/initial-transport-undelivered',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:initial-transport-undelivered',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    const initialQueue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(initialQueue).toHaveLength(1);
    expect(messageIds).toHaveLength(1);
    expect(messageIds[0]).toMatch(/^swm-sender-key:[0-9a-f]{64}$/);
    expect(initialQueue![0].messageId).toBe(messageIds[0]);

    installStubDiscovery(internals, (seenPeerId) => {
      if (seenPeerId !== peerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'initial-transport-undelivered-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    expect(await internals.drainPendingSenderKeyForPeer(peerId)).toBe(0);

    const retryQueue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(messageIds).toHaveLength(2);
    expect(messageIds[1]).toBe(messageIds[0]);
    expect(retryQueue).toHaveLength(1);
    expect(retryQueue![0].messageId).toMatch(/^swm-sender-key:[0-9a-f]{64}:[0-9a-f-]{36}$/);
    expect(retryQueue![0].messageId).not.toBe(messageIds[0]);
  });

  it('rotates pending retry messageId after incompatible ACK version', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/incompatible-ack-message-id',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:incompatible-ack-message-id',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    const knownPeerId = '12D3KooWIncompatibleAckMessageIdPeer';
    installStubDiscovery(internals, (peerId) => {
      if (peerId !== knownPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'incompatible-ack-message-id-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    const messageIds: Array<string | undefined> = [];
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => {
      messageIds.push(opts?.messageId);
      return {
        delivered: true,
        response: encodeSwmSenderKeyPackageAck({
          version: 'future-swm-sender-key-version',
          type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
          accepted: false,
          reason: 'future ACK version',
        }),
        attempts: 1,
        messageId: opts?.messageId ?? 'missing-message-id',
      };
    });

    expect(await internals.drainPendingSenderKeyForPeer(knownPeerId)).toBe(0);
    expect(await internals.drainPendingSenderKeyForPeer(knownPeerId)).toBe(0);

    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toMatch(/^swm-sender-key:[0-9a-f]{64}$/);
    expect(messageIds[1]).toMatch(/^swm-sender-key:[0-9a-f]{64}:[0-9a-f-]{36}$/);
    expect(messageIds[1]).not.toBe(messageIds[0]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('retries pending packages during later publishes without waiting for reconnect', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sendCalls: { peerId: string; payload: Uint8Array }[] = [];
    installStubMessenger(internals, async (peerId, _protocolId, payload) => {
      sendCalls.push({ peerId, payload });
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-publish-drain' };
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/publish-drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:publish-drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    const reachableRecipient: FakeRecipient = {
      ...recipient,
      peerId: '12D3KooWAlreadyConnectedPublishDrain',
    };
    const drained = await internals.drainPendingSenderKeyForRecipients(
      [reachableRecipient],
      { operationId: 'test-op', operationName: 'share' },
    );

    expect(drained).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].peerId).toBe(reachableRecipient.peerId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('keeps the row queued when messenger soft-queues (delivered=false)', async () => {
    // Verifies that delivered=false leaves the row in place for the next
    // drain attempt — the connection happened but the recipient still
    // couldn't be reached synchronously (e.g. they accepted the
    // connection then dropped before processing the protocol).
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: 'm-soft',
      error: 'stream reset mid-protocol',
      nextAttemptAtMs: Date.now() + 60_000,
    }));

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-soft',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-soft',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-target',
      peerId: '12D3KooWSoftDrainTest',
      agentAddress: recipient.agentAddress,
    }));

    const drained = await internals.drainPendingSenderKeyForPeer('12D3KooWSoftDrainTest');
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('serializes concurrent pending drains for the same recipient', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-serialized',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-serialized',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    const peerId = '12D3KooWSerializedDrainPeer';
    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-serialized-target',
      peerId,
      agentAddress: recipient.agentAddress,
    }));

    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    let sendCalls = 0;
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts): Promise<ReliableSendResult> => {
      sendCalls += 1;
      markSendStarted();
      await sendReleased;
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: opts?.messageId ?? 'm-drain-serialized',
      };
    });

    const firstDrain = internals.drainPendingSenderKeyForPeer(peerId);
    await sendStarted;
    const secondDrain = internals.drainPendingSenderKeyForPeer(peerId);
    releaseSend();

    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([1, 0]);
    expect(sendCalls).toBe(1);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('retries a waiting drain with its own peer when the first peer leaves the row queued', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-peer-race',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-peer-race',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    const stalePeerId = '12D3KooWStaleDrainPeer';
    const freshPeerId = '12D3KooWFreshDrainPeer';
    installStubDiscovery(internals, (peerId) => {
      if (peerId !== stalePeerId && peerId !== freshPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'drain-peer-race-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });

    let releaseStalePeer!: () => void;
    let markStalePeerStarted!: () => void;
    const stalePeerReleased = new Promise<void>((resolve) => { releaseStalePeer = resolve; });
    const stalePeerStarted = new Promise<void>((resolve) => { markStalePeerStarted = resolve; });
    const sendCalls: string[] = [];
    installStubMessenger(internals, async (peerId, _protocolId, _payload, opts): Promise<ReliableSendResult> => {
      sendCalls.push(peerId);
      if (peerId === stalePeerId) {
        markStalePeerStarted();
        await stalePeerReleased;
        return {
          delivered: false,
          queued: true,
          attempts: 1,
          messageId: opts?.messageId ?? 'm-drain-peer-race',
          error: 'stale peer did not accept the stream',
          nextAttemptAtMs: Date.now() + 60_000,
        };
      }
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: opts?.messageId ?? 'm-drain-peer-race',
      };
    });

    const staleDrain = internals.drainPendingSenderKeyForPeer(stalePeerId);
    await stalePeerStarted;
    const freshDrain = internals.drainPendingSenderKeyForPeer(freshPeerId);
    releaseStalePeer();

    await expect(Promise.all([staleDrain, freshDrain])).resolves.toEqual([0, 1]);
    expect(sendCalls).toEqual([stalePeerId, freshPeerId]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('surfaces non-recoverable pending drain send failures instead of re-queuing silently', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-nonrecoverable',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-nonrecoverable',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-nonrecoverable-target',
      peerId: '12D3KooWNonRecoverableDrainPeer',
      agentAddress: recipient.agentAddress,
    }));
    installStubMessenger(internals, async () => {
      throw new Error('messenger substrate misconfigured');
    });

    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push({ level: entry.level, message: entry.message }));

    await expect(
      internals.drainPendingSenderKeyForPeer('12D3KooWNonRecoverableDrainPeer'),
    ).rejects.toThrow('messenger substrate misconfigured');
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('failed before the Messenger substrate queued a retry'),
    }));
  });

  it('loads persisted pending rows before reconnect drain after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-pending-reconnect-'));
    tempDirs.push(dataDir);

    const firstBoot = await bootAgent({ dataDir });
    agent = firstBoot.agent;
    const firstInternals = firstBoot.internals;
    installStubMessenger(firstInternals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    await firstInternals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/persisted-reconnect-drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:persisted-reconnect-drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(firstInternals.pendingSenderKeyByAgent.size).toBe(1);
    await firstInternals.saveSwmSenderKeyState();
    await agent.stop();
    agent = null;

    const secondBoot = await bootAgent({ dataDir });
    agent = secondBoot.agent;
    const secondInternals = secondBoot.internals;
    const peerId = '12D3KooWPersistedReconnectDrainPeer';
    installStubDiscovery(secondInternals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'persisted-reconnect-drain-target',
      peerId,
      agentAddress: recipient.agentAddress,
    }));
    let sendCalls = 0;
    installStubMessenger(secondInternals, async (): Promise<ReliableSendResult> => {
      sendCalls += 1;
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: 'm-persisted-reconnect-drain',
      };
    });

    const drained = await secondInternals.drainPendingSenderKeyForPeer(peerId);
    expect(drained).toBe(1);
    expect(sendCalls).toBe(1);
    expect(secondInternals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('keeps delivered stale-target rejections fatal because the package targets an obsolete key ID', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const staleTarget = makeFakeRecipient({ peerId: '12D3KooWStaleTargetFatalPeer' });

    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(
        false,
        `No local X25519 private key for DKG agent ${staleTarget.agentAddress} key ${staleTarget.recipientKeyId}`,
        'stale-target',
      ),
      attempts: 1,
      messageId: `m-stale-target-${peerId.slice(-6)}`,
    }));

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/joined',
        sender,
        recipients: [staleTarget],
        membershipHash: 'sha256:joined-stale-target-rejection',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow('stale-target');

    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('keeps unknown future negative ACK codes fatal', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const futureReason = makeFakeRecipient({ peerId: '12D3KooWFutureReasonFatalPeer' });

    const rejectionByPeer = new Map<string, { reason?: string; reasonCode?: SwmSenderKeyPackageAckReasonCode }>([
      [
        futureReason.peerId!,
        {
          reason: 'newer receiver returned an unknown permanent rejection code',
          reasonCode: 'future-permanent-rejection',
        },
      ],
    ]);
    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      const rejection = rejectionByPeer.get(peerId);
      return {
        delivered: true,
        response: senderKeyAck(false, rejection?.reason, rejection?.reasonCode),
        attempts: 1,
        messageId: `m-fatal-${peerId.slice(-6)}`,
      };
    });

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/joined',
        sender,
        recipients: [futureReason],
        membershipHash: 'sha256:joined-future-rejection',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow('future-permanent-rejection');

    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('queues delivered malformed setup ACKs instead of failing initial setup', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const recipient = makeFakeRecipient({ peerId: '12D3KooWMalformedInitialAckPeer' });
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: new Uint8Array([0xff, 0x01, 0x02]),
      attempts: 1,
      messageId: 'm-malformed-initial-ack',
    }));

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/malformed-initial-ack',
        sender,
        recipients: [recipient],
        membershipHash: 'sha256:malformed-initial-ack',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).resolves.toBeTruthy();

    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(1);
    expect(queue![0].messageId).toMatch(/^swm-sender-key:[0-9a-f]{64}:[0-9a-f-]{36}$/);
  });

  it('keeps structured known failures and legacy code-less hard failures fatal', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const activeKeyMissing = makeFakeRecipient({ peerId: '12D3KooWActiveMissingFatalPeer' });
    const senderNotAllowed = makeFakeRecipient({ peerId: '12D3KooWSenderNotAllowedFatalPeer' });
    const recipientNotAllowed = makeFakeRecipient({ peerId: '12D3KooWRecipientNotAllowedFatalPeer' });
    const recipientNotLocal = makeFakeRecipient({ peerId: '12D3KooWRecipientNotLocalFatalPeer' });
    const notAgentGated = makeFakeRecipient({ peerId: '12D3KooWNotAgentGatedFatalPeer' });
    const unknownReason = makeFakeRecipient({ peerId: '12D3KooWUnknownFatalPeer' });
    const legacyNoCode = makeFakeRecipient({ peerId: '12D3KooWLegacyNoCodeFatalPeer' });

    const rejectionByPeer = new Map<string, { reason: string; reasonCode?: SwmSenderKeyPackageAckReasonCode }>([
      [
        activeKeyMissing.peerId!,
        {
          reason: `No local X25519 private key for DKG agent ${activeKeyMissing.agentAddress} key ${activeKeyMissing.recipientKeyId}`,
          reasonCode: 'active-private-key-missing',
        },
      ],
      [
        senderNotAllowed.peerId!,
        {
          reason: `Sender agent ${sender.agentAddress} is not allowed for context graph "test-cg/joined"`,
          reasonCode: 'sender-not-allowed',
        },
      ],
      [
        recipientNotAllowed.peerId!,
        {
          reason: `Recipient agent ${recipientNotAllowed.agentAddress} is not allowed for context graph "test-cg/joined"`,
          reasonCode: 'recipient-not-allowed',
        },
      ],
      [
        recipientNotLocal.peerId!,
        {
          reason: `Recipient agent ${recipientNotLocal.agentAddress} is not local to this node`,
          reasonCode: 'recipient-not-local',
        },
      ],
      [
        notAgentGated.peerId!,
        {
          reason: 'Context graph "test-cg/joined" is not DKG-agent gated',
          reasonCode: 'not-agent-gated',
        },
      ],
      [
        unknownReason.peerId!,
        {
          reason: 'malformed package or unexpected receiver failure',
          reasonCode: 'unknown',
        },
      ],
      [
        legacyNoCode.peerId!,
        {
          reason: 'bad signature: legacy receiver rejection without a reason code',
        },
      ],
    ]);
    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      const rejection = rejectionByPeer.get(peerId)!;
      return {
        delivered: true,
        response: senderKeyAck(false, rejection.reason, rejection.reasonCode),
        attempts: 1,
        messageId: `m-terminal-${peerId.slice(-6)}`,
      };
    });

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/joined',
        sender,
        recipients: [
          activeKeyMissing,
          senderNotAllowed,
          recipientNotAllowed,
          recipientNotLocal,
          notAgentGated,
          unknownReason,
          legacyNoCode,
        ],
        membershipHash: 'sha256:joined-terminal-rejections',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow('SWM Sender Key setup rejected by 7 agent(s)');

    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('drops unknown future delivered rejections during pending drain', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-transient-reject',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-transient-reject',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-future-reject-target',
      peerId: '12D3KooWDrainFutureRejectPeer',
      agentAddress: recipient.agentAddress,
    }));
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(
        false,
        'receiver returned an unknown permanent rejection code',
        'future-permanent-rejection',
      ),
      attempts: 1,
      messageId: 'm-drain-transient-reject',
    }));

    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push({ level: entry.level, message: entry.message }));

    const drained = await internals.drainPendingSenderKeyForPeer('12D3KooWDrainFutureRejectPeer');
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('dropped after terminal rejection (future-permanent-rejection)'),
    }));
  });

  it('drains pending sender keys when curated publish reuses an existing epoch', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const contextGraphId = 'test-cg/curated-reuse-drain';
    const senderWallet = ethers.Wallet.createRandom();
    const recipientWallet = ethers.Wallet.createRandom();
    const sender = agentFromPrivateKey(
      senderWallet.privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const recipientPeerId = '12D3KooWCuratedReuseDrainPeer';

    await insertAgentGate(internals.store, contextGraphId, senderWallet.address);
    await insertAgentGate(internals.store, contextGraphId, recipientWallet.address);
    await insertVerifiedAgentEncryptionKey(internals.store, senderWallet);
    const recipient = await insertVerifiedAgentEncryptionKey(internals.store, recipientWallet, {
      peerId: recipientPeerId,
    });

    const resolution = await resolveWorkspaceAgentRecipients(internals.store, { contextGraphId });
    const membershipHash = computeSwmSenderKeyMembershipHash({
      contextGraphId,
      members: resolution.recipients.map((r) => ({
        agentAddress: r.agentAddress,
        recipientKeyId: r.recipientKeyId,
      })),
    });
    const chainKey = new Uint8Array(32).fill(9);
    const stateKey = swmSenderStateKey(contextGraphId, undefined, sender.agentAddress);
    internals.swmSenderKeySendStates.set(stateKey, {
      contextGraphId,
      senderAgentAddress: sender.agentAddress,
      epochId: 'epoch-existing',
      membershipHash,
      createdAtMs: Date.now(),
      nextMessageIndex: 0,
      chainKey,
      senderSigningPublicKey: new Uint8Array(32).fill(8),
      senderSigningSecretKey: new Uint8Array(32).fill(7),
    });
    internals.pendingSenderKeyByAgent.set(recipient.agentAddress.toLowerCase(), [{
      senderAgentAddress: sender.agentAddress.toLowerCase(),
      recipientAgentAddress: recipient.agentAddress.toLowerCase(),
      recipientKeyId: recipient.recipientKeyId,
      epochId: 'epoch-existing',
      contextGraphId,
      packageBytes: new Uint8Array([1, 2, 3]),
      createdAtMs: Date.now(),
    }]);

    const sendCalls: Array<{ peerId: string; payload: Uint8Array }> = [];
    installStubMessenger(internals, async (peerId, _protocolId, payload): Promise<ReliableSendResult> => {
      sendCalls.push({ peerId, payload });
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-curated-drain' };
    });
    (internals as any).isPrivateContextGraph = async () => true;
    (internals as any).loadSwmSenderKeyState = async () => {};
    (internals as any).getLocalSigningAgentForAddress = () => sender;
    (internals as any).createAndDistributeSwmSenderKeyEpoch = async () => {
      throw new Error('existing membership must reuse state instead of rotating');
    };

    const resolved = await internals._resolveCuratedChainKeyContext(
      contextGraphId,
      undefined,
      sender.agentAddress,
      undefined,
      'LU-5',
      { aeadBindingContextGraphId: '2' },
    );

    expect(resolved?.chainKey).toEqual(chainKey);
    expect(resolved?.aeadCgId).toBe('2');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].peerId).toBe(recipientPeerId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('removes delivered terminal rejections during pending drain without counting them as drained', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-retryable',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-retryable',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-hard-reject-target',
      peerId: '12D3KooWDrainHardRejectPeer',
      agentAddress: recipient.agentAddress,
    }));
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(
        false,
        `No local X25519 private key for DKG agent ${recipient.agentAddress} key ${recipient.recipientKeyId}`,
        'stale-target',
      ),
      attempts: 1,
      messageId: 'm-drain-hard-reject',
    }));

    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push({ level: entry.level, message: entry.message }));

    const drained = await internals.drainPendingSenderKeyForPeer('12D3KooWDrainHardRejectPeer');
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('dropped after terminal rejection (stale-target)'),
    }));
    expect(logs[0].message).toContain(recipient.recipientKeyId);
  });

  it('keeps malformed delivered ACKs queued during pending drain', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(internals, async () => {
      throw new Error('initial no-peerId branch must not call sendReliable');
    });
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/drain-malformed-ack',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:drain-malformed-ack',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-malformed-ack-target',
      peerId: '12D3KooWDrainMalformedAckPeer',
      agentAddress: recipient.agentAddress,
    }));
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: new Uint8Array([0xff, 0x01, 0x02]),
      attempts: 1,
      messageId: 'm-drain-malformed-ack',
    }));

    const drained = await internals.drainPendingSenderKeyForPeer('12D3KooWDrainMalformedAckPeer');
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
    expect(
      internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase())?.[0].recipientKeyId,
    ).toBe(recipient.recipientKeyId);
  });

  it('supersedes older epochs for the same (sender, recipient) pair', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('sendReliable must not be called on no-peerId branch');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    // First publish — enqueues epoch-1.
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/super',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:super-1',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const queueAfterFirst = internals.pendingSenderKeyByAgent.get(
      recipient.agentAddress.toLowerCase(),
    )!;
    expect(queueAfterFirst).toHaveLength(1);
    const firstEpochId = queueAfterFirst[0].epochId;

    // Second publish with a NEW membership hash — forces a new epoch.
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/super',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:super-2',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const queueAfterSecond = internals.pendingSenderKeyByAgent.get(
      recipient.agentAddress.toLowerCase(),
    )!;
    expect(queueAfterSecond).toHaveLength(1);
    expect(queueAfterSecond[0].epochId).not.toBe(firstEpochId);
  });

  it('prunes stale pending rows for a sender when membership rotates', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const otherSender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'other',
    ) as AgentKeyRecord & { privateKey: string };
    const removedRecipient = makeFakeRecipient();
    const otherRecipient = makeFakeRecipient();

    internals.pendingSenderKeyByAgent.set(removedRecipient.agentAddress.toLowerCase(), [{
      senderAgentAddress: sender.agentAddress.toLowerCase(),
      recipientAgentAddress: removedRecipient.agentAddress.toLowerCase(),
      recipientKeyId: removedRecipient.recipientKeyId,
      epochId: 'old-epoch',
      contextGraphId: 'test-cg/prune',
      packageBytes: new Uint8Array([1, 2, 3]),
      createdAtMs: Date.now(),
    }]);
    internals.pendingSenderKeyByAgent.set(otherRecipient.agentAddress.toLowerCase(), [{
      senderAgentAddress: otherSender.agentAddress.toLowerCase(),
      recipientAgentAddress: otherRecipient.agentAddress.toLowerCase(),
      recipientKeyId: otherRecipient.recipientKeyId,
      epochId: 'other-epoch',
      contextGraphId: 'test-cg/prune',
      packageBytes: new Uint8Array([4, 5, 6]),
      createdAtMs: Date.now(),
    }]);

    const removed = (internals as unknown as {
      prunePendingSenderKeysForEpochRotation(input: {
        contextGraphId: string;
        senderAgentAddress: string;
      }): number;
    }).prunePendingSenderKeysForEpochRotation({
      contextGraphId: 'test-cg/prune',
      senderAgentAddress: sender.agentAddress,
    });

    expect(removed).toBe(1);
    expect(internals.pendingSenderKeyByAgent.has(removedRecipient.agentAddress.toLowerCase())).toBe(false);
    expect(internals.pendingSenderKeyByAgent.get(otherRecipient.agentAddress.toLowerCase())).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// PR #700 regression — drain must work with the agent's *real* DiscoveryClient,
// not just the stubs used above. The original implementation was a silent
// no-op in production because `DiscoveryClient.findAgentByPeerId` selected
// every other column EXCEPT `?agentAddress`, while
// `drainPendingSenderKeyForPeer` gates on exactly that field. The stub-based
// tests above (`installStubDiscovery`) inject the field explicitly and so
// masked the bug. This block exercises the path end-to-end against the
// agent's actual store + discovery so we'd catch this kind of regression on
// CI rather than on mainnet.
// -----------------------------------------------------------------------------
describe('drainPendingSenderKeyForPeer: real discovery + agent registry CG', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it("drains queued sender keys when the recipient's agent profile is published with peerId+agentAddress (no stubbed discovery)", async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sendCalls: { peerId: string; payload: Uint8Array }[] = [];
    installStubMessenger(internals, async (peerId, _protocolId, payload) => {
      sendCalls.push({ peerId, payload });
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-real-drain' };
    });

    // Build a recipient and seed the queue via the no-peerId path — same
    // shape as production: publisher emits the encrypted package, the
    // fan-out can't find a peerId, the row lands in
    // `pendingSenderKeyByAgent` keyed by lowercased recipientAgentAddress.
    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/real-drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:real-drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // Now the recipient publishes its profile to the agent registry CG.
    // In production this lands via gossip + `SyncManager` ingest from a
    // remote agent's `publishProfile()`. The shape we care about for
    // drain is identical either way: a `dkg:Agent` triple-bundle with
    // `dkg:peerId`, `schema:name`, and crucially `dkg:agentAddress`.
    const recipientPeerId = '12D3KooWRealDrainTestRecipient';
    const { quads } = buildAgentProfile({
      peerId: recipientPeerId,
      name: 'RealDrainRecipient',
      agentAddress: recipient.agentAddress,
      skills: [],
    });
    await internals.store.insert(quads);

    // No `installStubDiscovery` call — the agent's real `DiscoveryClient`
    // (built in `DKGAgent.create` at `dkg-agent.ts:1054`) resolves the
    // profile from the freshly-inserted triples.
    const drained = await internals.drainPendingSenderKeyForPeer(recipientPeerId);

    // The bug we're regression-testing was: `agentAddress` came back
    // `undefined`, drain early-returned 0, queue was never emptied, no
    // messenger send ever happened. With the fix in place all three
    // observables flip:
    expect(drained).toBe(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].peerId).toBe(recipientPeerId);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('treats a profile published without `dkg:agentAddress` as not-found — legacy profiles do not crash drain', async () => {
    // Defensive boundary: legacy nodes pre-#700 don't emit
    // `dkg:agentAddress` at all (the triple is optional in
    // `buildAgentProfile`). In that case drain must safely no-op for that
    // peerId — the queue stays in place for a future re-publish — rather
    // than throwing or proceeding with a wrong/empty address.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async () => {
      throw new Error('sendReliable must not be called when agentAddress is absent');
    });

    const recipient = makeFakeRecipient();
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/legacy-profile',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:legacy-profile',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    const legacyPeerId = '12D3KooWLegacyProfileNoAgentAddr';
    const { quads } = buildAgentProfile({
      peerId: legacyPeerId,
      name: 'LegacyAgent',
      // NB: no `agentAddress` field — the triple is omitted from the
      // emitted quads (see `profile.ts:203-205`).
      skills: [],
    });
    await internals.store.insert(quads);

    const drained = await internals.drainPendingSenderKeyForPeer(legacyPeerId);
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });
});
