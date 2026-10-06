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
// A subsequent `connection:open` event, later publish, or connected-peer
// retry tick drives queued-package drain and replays each queued package via
// `messenger.sendReliable` once current CG authority binds its exact key to a
// peer route.
//
// Three contracts pinned here:
//   1. no-peerId no longer throws (publish proceeds; row enqueued).
//   2. drain replays the queued package once we know its authorized key route,
//      either through reconnect or later recipient resolution, and
//      removes the row when the Sender Key ACK confirms acceptance.
//   3. enqueuing a newer epoch for the same (sender, recipient)
//      evicts older epochs — they're superseded by definition.

import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  resolveWorkspaceAgentRecipientKeys,
  resolveWorkspaceAgentRecipients,
} from '@origintrail-official/dkg-publisher';
import {
  DKGAgent,
  agentFromPrivateKey,
  buildAgentProfile,
  type AgentKeyRecord,
  type DiscoveredAgent,
  type PendingSenderKeyEntry,
} from '../src/index.js';
import {
  computeSwmSenderKeyRecipientRouteHash,
  swmSenderStateKey,
} from '../src/dkg-agent-swm-state.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';

const senderKeyStateWriteBarrier = vi.hoisted(() => ({
  targetDir: null as string | null,
  targetPath: null as string | null,
  writes: [] as string[],
  onFirstWrite: null as (() => void) | null,
  releaseFirstWrite: null as Promise<void> | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (senderKeyStateWriteBarrier.targetDir === String(args[0])) return undefined;
      return Reflect.apply(actual.mkdir, undefined, args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (senderKeyStateWriteBarrier.targetPath === String(args[0])) {
        const contents = typeof args[1] === 'string'
          ? args[1]
          : Buffer.from(args[1] as Uint8Array).toString('utf8');
        senderKeyStateWriteBarrier.writes.push(contents);
        if (senderKeyStateWriteBarrier.writes.length === 1) {
          senderKeyStateWriteBarrier.onFirstWrite?.();
          if (senderKeyStateWriteBarrier.releaseFirstWrite) {
            await senderKeyStateWriteBarrier.releaseFirstWrite;
          }
        }
      }
      return Reflect.apply(actual.writeFile, undefined, args);
    },
  };
});

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
  enqueuePendingSenderKey(entry: PendingSenderKeyEntry): void;
  resolveWorkspaceAgentRecipientsForCurrentAuthority(input: { contextGraphId: string }): Promise<
    | { requiresEncryption: false; recipients: [] }
    | { requiresEncryption: true; recipients: readonly [FakeRecipient, ...FakeRecipient[]] }
  >;
  drainPendingSenderKeyForPeer(peerId: string): Promise<number>;
  drainPendingSenderKeyForRecipients(
    recipients: readonly FakeRecipient[],
    ctx: OperationContext | undefined,
    scope: {
      contextGraphId: string;
      subGraphName?: string;
      senderAgentAddress: string;
      epochId: string;
    },
  ): Promise<number>;
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

function installCurrentRecipientAuthority(
  internals: PendingInternals,
  recipients: readonly [FakeRecipient, ...FakeRecipient[]],
): void {
  internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async () => ({
    requiresEncryption: true,
    recipients,
  });
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

function pendingDrainScope(
  internals: PendingInternals,
  recipientAgentAddress: string,
  contextGraphId: string,
  subGraphName?: string,
): {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
} {
  const entry = internals.pendingSenderKeyByAgent
    .get(recipientAgentAddress.toLowerCase())
    ?.find((candidate) => (
      candidate.contextGraphId === contextGraphId
      && (candidate.subGraphName ?? undefined) === (subGraphName ?? undefined)
    ));
  if (!entry) throw new Error(`Missing pending Sender Key row for ${contextGraphId}`);
  return {
    contextGraphId,
    subGraphName,
    senderAgentAddress: entry.senderAgentAddress,
    epochId: entry.epochId,
  };
}

describe('createAndDistributeSwmSenderKeyEpoch: missing-peerId soft success', () => {
  let agent: DKGAgent | null = null;
  const tempDirs: string[] = [];
  afterEach(async () => {
    Logger.setSink(null);
    senderKeyStateWriteBarrier.targetDir = null;
    senderKeyStateWriteBarrier.targetPath = null;
    senderKeyStateWriteBarrier.writes = [];
    senderKeyStateWriteBarrier.onFirstWrite = null;
    senderKeyStateWriteBarrier.releaseFirstWrite = null;
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

  it('does not supersede pending epochs from another context graph or subgraph', async () => {
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
    const enqueueScope = async (contextGraphId: string, subGraphName?: string) => {
      await internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId,
        subGraphName,
        sender,
        recipients: [recipient],
        membershipHash: `sha256:${contextGraphId}:${subGraphName ?? 'root'}`,
        ctx: { operationId: 'test-op', operationName: 'share' },
      });
    };

    await enqueueScope('test-cg/pending-scope-a');
    await enqueueScope('test-cg/pending-scope-b');
    await enqueueScope('test-cg/pending-scope-a', 'child');

    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(3);
    expect(queue?.map(({ contextGraphId, subGraphName }) => (
      `${contextGraphId}/${subGraphName ?? ''}`
    )).sort()).toEqual([
      'test-cg/pending-scope-a/',
      'test-cg/pending-scope-a/child',
      'test-cg/pending-scope-b/',
    ]);
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

  it('serializes full-state saves so a delayed older write cannot overwrite a newer snapshot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-save-queue-'));
    tempDirs.push(dataDir);
    // This exercises sender-key writes, not boot persistence. Attaching the
    // directory after create avoids unrelated constructor writes racing its
    // teardown (the agent is intentionally never started in this suite).
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    internals.config.dataDir = dataDir;
    const path = join(dataDir, 'swm-sender-keys.json');

    let markFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWrite = resolve; });
    let releaseFirstWrite!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    senderKeyStateWriteBarrier.targetDir = dataDir;
    senderKeyStateWriteBarrier.targetPath = path;
    senderKeyStateWriteBarrier.onFirstWrite = markFirstWrite;
    senderKeyStateWriteBarrier.releaseFirstWrite = firstWriteReleased;

    const recipient = makeFakeRecipient();
    const recipientAgentAddress = recipient.agentAddress.toLowerCase();
    const senderAgentAddress = ethers.Wallet.createRandom().address.toLowerCase();
    const pending = (marker: number): PendingSenderKeyEntry => ({
      senderAgentAddress,
      recipientAgentAddress,
      recipientKeyId: recipient.recipientKeyId,
      epochId: `epoch-${marker}`,
      contextGraphId: 'test-cg/save-queue',
      packageBytes: new Uint8Array([marker]),
      createdAtMs: marker,
    });

    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [pending(1)]);
    const olderSave = internals.saveSwmSenderKeyState();
    await firstWriteStarted;

    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [pending(2)]);
    const newerSave = internals.saveSwmSenderKeyState();
    // The mocked mkdir is synchronous for this dataDir. One event-loop turn
    // lets an unqueued second writer reach writeFile while the first is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const writesBeforeRelease = senderKeyStateWriteBarrier.writes.length;

    releaseFirstWrite();
    await Promise.all([olderSave, newerSave]);

    expect(writesBeforeRelease).toBe(1);
    expect(senderKeyStateWriteBarrier.writes).toHaveLength(2);
    const state = JSON.parse(await readFile(path, 'utf-8')) as {
      pending?: Array<{ epochId?: string; packageBytes?: string }>;
    };
    expect(state.pending).toEqual([expect.objectContaining({
      epochId: 'epoch-2',
      packageBytes: Buffer.from([2]).toString('base64'),
    })]);
  });

  it('continues the sender-key save queue after a failed write', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-save-recovery-'));
    tempDirs.push(dataDir);
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const blockedParent = join(dataDir, 'not-a-directory');
    await writeFile(blockedParent, 'blocked');
    internals.config.dataDir = join(blockedParent, 'child');

    await expect(internals.saveSwmSenderKeyState()).rejects.toThrow();

    internals.config.dataDir = dataDir;
    await expect(internals.saveSwmSenderKeyState()).resolves.toBeUndefined();
    const state = JSON.parse(
      await readFile(join(dataDir, 'swm-sender-keys.json'), 'utf-8'),
    ) as { version?: number };
    expect(state.version).toBe(1);
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

  it('defers an unbound reconnect drain until an exact key-to-peer route is known', async () => {
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

    // Agent/peer discovery alone is not enough: another daemon for the same
    // agent may own a different key. The reconnect path leaves the row queued.
    expect(await internals.drainPendingSenderKeyForPeer(knownPeerId)).toBe(0);
    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // A current recipient snapshot proves the exact key route and may bind it.
    installCurrentRecipientAuthority(internals, [{ ...recipient, peerId: knownPeerId }]);
    const drained = await internals.drainPendingSenderKeyForRecipients([{
      ...recipient,
      peerId: knownPeerId,
    }], undefined, pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/drain',
    ));
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

    const reachableRecipient = { ...recipient, peerId: knownPeerId };
    installCurrentRecipientAuthority(internals, [reachableRecipient]);
    const scope = pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/stable-message-id',
    );
    expect(await internals.drainPendingSenderKeyForRecipients([reachableRecipient], undefined, scope)).toBe(0);
    expect(await internals.drainPendingSenderKeyForRecipients([reachableRecipient], undefined, scope)).toBe(0);

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
    installCurrentRecipientAuthority(internals, [recipient]);

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

    const reachableRecipient = { ...recipient, peerId: knownPeerId };
    installCurrentRecipientAuthority(internals, [reachableRecipient]);
    const scope = pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/incompatible-ack-message-id',
    );
    expect(await internals.drainPendingSenderKeyForRecipients([reachableRecipient], undefined, scope)).toBe(0);
    expect(await internals.drainPendingSenderKeyForRecipients([reachableRecipient], undefined, scope)).toBe(0);

    expect(messageIds).toHaveLength(2);
    expect(messageIds[0]).toMatch(/^swm-sender-key:[0-9a-f]{64}$/);
    expect(messageIds[1]).toMatch(/^swm-sender-key:[0-9a-f]{64}:[0-9a-f-]{36}$/);
    expect(messageIds[1]).not.toBe(messageIds[0]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('keeps pending setup obligations separate for peers sharing the same agent key', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const peerA = '12D3KooWPendingRoutePeerA';
    const peerB = '12D3KooWPendingRoutePeerB';
    const recipient = makeFakeRecipient();
    const recipientAtA = { ...recipient, peerId: peerA };
    const recipientAtB = { ...recipient, peerId: peerB };
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(false, 'recipient authority is still converging', 'agent-gate-pending'),
      attempts: 1,
      messageId: 'm-peer-route-pending',
    }));

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/pending-peer-routes',
      sender,
      recipients: [recipientAtA, recipientAtB],
      membershipHash: 'sha256:pending-peer-routes',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(2);
    expect(queue?.map((entry) => entry.recipientPeerId).sort()).toEqual([peerA, peerB].sort());
  });

  it('retries a pending peer B route at B after peer A already accepted', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const peerA = '12D3KooWAcceptedRoutePeerA';
    const peerB = '12D3KooWRetryRoutePeerB';
    const recipient = makeFakeRecipient();
    const recipientAtA = { ...recipient, peerId: peerA };
    const recipientAtB = { ...recipient, peerId: peerB };
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const sendPeers: string[] = [];
    let peerBAttempts = 0;

    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      sendPeers.push(peerId);
      if (peerId === peerB && peerBAttempts++ === 0) {
        return {
          delivered: true,
          response: senderKeyAck(false, 'recipient authority is still converging', 'agent-gate-pending'),
          attempts: 1,
          messageId: 'm-peer-b-retryable',
        };
      }
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: `m-peer-route-accepted-${peerId}`,
      };
    });

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/pending-peer-b-retry',
      sender,
      recipients: [recipientAtA, recipientAtB],
      membershipHash: 'sha256:pending-peer-b-retry',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });

    // Setup fans out to all recipients concurrently, so the sends to A and B
    // may reach the messenger in either order.
    expect([...sendPeers].sort()).toEqual([peerA, peerB].sort());
    const queued = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queued).toHaveLength(1);
    expect(queued?.[0].recipientPeerId).toBe(peerB);
    installCurrentRecipientAuthority(internals, [recipientAtA, recipientAtB]);

    const drained = await internals.drainPendingSenderKeyForRecipients(
      [recipientAtA, recipientAtB],
      { operationId: 'test-op', operationName: 'share' },
      pendingDrainScope(
        internals,
        recipient.agentAddress,
        'test-cg/pending-peer-b-retry',
      ),
    );

    expect(drained).toBe(1);
    // The drain sends only the retry owed to B; A already accepted.
    expect(sendPeers.slice(2)).toEqual([peerB]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('retries a transiently denied setup while the recipient remains connected', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWAlreadyConnectedSenderKeyRecipient';
    const recipient = makeFakeRecipient({ peerId });
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const sendPeers: string[] = [];

    installStubMessenger(internals, async (target): Promise<ReliableSendResult> => {
      sendPeers.push(target);
      return {
        delivered: true,
        response: senderKeyAck(
          sendPeers.length > 1,
          sendPeers.length === 1 ? 'authority is still converging' : undefined,
          sendPeers.length === 1 ? 'agent-gate-pending' : undefined,
        ),
        attempts: 1,
        messageId: `sender-key-attempt-${sendPeers.length}`,
      };
    });
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/connected-retry',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:connected-retry',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase()))
      .toHaveLength(1);
    installCurrentRecipientAuthority(internals, [recipient]);

    const node = internals.node as unknown as object;
    const beforeStarted = Object.getOwnPropertyDescriptor(node, 'isStarted');
    const beforeLibp2p = Object.getOwnPropertyDescriptor(node, 'libp2p');
    Object.defineProperties(node, {
      isStarted: { configurable: true, value: true },
      libp2p: {
        configurable: true,
        value: { getPeers: () => [{ toString: () => peerId }] },
      },
    });
    try {
      const retry = internals as unknown as {
        drainPendingSenderKeysForConnectedPeers(): Promise<number>;
      };
      expect(await retry.drainPendingSenderKeysForConnectedPeers()).toBe(1);
    } finally {
      if (beforeStarted) Object.defineProperty(node, 'isStarted', beforeStarted);
      else Reflect.deleteProperty(node, 'isStarted');
      if (beforeLibp2p) Object.defineProperty(node, 'libp2p', beforeLibp2p);
      else Reflect.deleteProperty(node, 'libp2p');
    }
    expect(sendPeers).toEqual([peerId, peerId]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('binds an unbound retry only to the peer advertising its exact key', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerA = '12D3KooWUnboundKeyOnePeerA';
    const peerB = '12D3KooWUnboundKeyTwoPeerB';
    const keyOneAtA = makeFakeRecipient({ peerId: peerA });
    const keyTwo = generateWorkspaceRecipientEncryptionKey(
      keyOneAtA.recipientId,
      `${keyOneAtA.recipientId}#second-route-key`,
    );
    const keyTwoAtB: FakeRecipient = {
      ...keyOneAtA,
      peerId: peerB,
      recipientKeyId: keyTwo.recipientKeyId,
      publicKeyBytes: keyTwo.publicKeyBytes!,
    };
    const senderAgentAddress = ethers.Wallet.createRandom().address.toLowerCase();
    internals.pendingSenderKeyByAgent.set(keyOneAtA.agentAddress.toLowerCase(), [{
      senderAgentAddress,
      recipientAgentAddress: keyOneAtA.agentAddress.toLowerCase(),
      recipientKeyId: keyTwoAtB.recipientKeyId,
      epochId: 'epoch-unbound-key-route',
      contextGraphId: 'test-cg/unbound-key-route',
      packageBytes: new Uint8Array([1, 2, 3]),
      createdAtMs: Date.now(),
    }]);

    const retryPeers: string[] = [];
    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      retryPeers.push(peerId);
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: `m-unbound-key-route-${peerId}`,
      };
    });
    installCurrentRecipientAuthority(internals, [keyOneAtA, keyTwoAtB]);

    expect(await internals.drainPendingSenderKeyForRecipients(
      [keyOneAtA, keyTwoAtB],
      undefined,
      pendingDrainScope(
        internals,
        keyOneAtA.agentAddress,
        'test-cg/unbound-key-route',
      ),
    )).toBe(1);
    expect(retryPeers).toEqual([peerB]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('foreground drain consumes only its exact graph, subgraph, sender, and epoch', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWExactForegroundDrainPeer';
    const recipient = makeFakeRecipient({ peerId });
    const recipientAgentAddress = recipient.agentAddress.toLowerCase();
    const senderAgentAddress = ethers.Wallet.createRandom().address.toLowerCase();
    const base: PendingSenderKeyEntry = {
      senderAgentAddress,
      recipientAgentAddress,
      recipientKeyId: recipient.recipientKeyId,
      recipientPeerId: peerId,
      epochId: 'epoch-current',
      contextGraphId: 'test-cg/exact-foreground',
      subGraphName: 'subgraph-current',
      packageBytes: new Uint8Array([1]),
      createdAtMs: Date.now(),
    };
    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [
      base,
      { ...base, contextGraphId: 'test-cg/other', packageBytes: new Uint8Array([2]) },
      { ...base, subGraphName: 'subgraph-other', packageBytes: new Uint8Array([3]) },
      {
        ...base,
        senderAgentAddress: ethers.Wallet.createRandom().address.toLowerCase(),
        packageBytes: new Uint8Array([4]),
      },
      { ...base, epochId: 'epoch-other', packageBytes: new Uint8Array([5]) },
    ]);
    installCurrentRecipientAuthority(internals, [recipient]);
    const sentMarkers: number[] = [];
    installStubMessenger(internals, async (_peerId, _protocolId, payload) => {
      sentMarkers.push(payload[0]);
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-exact-scope' };
    });

    expect(await internals.drainPendingSenderKeyForRecipients(
      [recipient],
      undefined,
      {
        contextGraphId: base.contextGraphId,
        subGraphName: base.subGraphName,
        senderAgentAddress,
        epochId: base.epochId,
      },
    )).toBe(1);
    expect(sentMarkers).toEqual([1]);
    expect(
      internals.pendingSenderKeyByAgent.get(recipientAgentAddress)?.map((entry) => entry.packageBytes[0]),
    ).toEqual([2, 3, 4, 5]);
  });

  it('keeps a bound same-peer row when current authority advertises another key', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWCurrentKeyFencePeer';
    const recipient = makeFakeRecipient({ peerId });
    const recipientAgentAddress = recipient.agentAddress.toLowerCase();
    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [{
      senderAgentAddress: ethers.Wallet.createRandom().address.toLowerCase(),
      recipientAgentAddress,
      recipientKeyId: `${recipient.recipientId}#obsolete-key`,
      recipientPeerId: peerId,
      epochId: 'epoch-obsolete-key',
      contextGraphId: 'test-cg/current-key-fence',
      packageBytes: new Uint8Array([6]),
      createdAtMs: Date.now(),
    }]);
    installCurrentRecipientAuthority(internals, [recipient]);
    let sends = 0;
    installStubMessenger(internals, async () => {
      sends += 1;
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'unexpected' };
    });

    expect(await internals.drainPendingSenderKeyForPeer(peerId)).toBe(0);
    expect(sends).toBe(0);
    expect(internals.pendingSenderKeyByAgent.get(recipientAgentAddress)).toHaveLength(1);
  });

  it('keeps bound rows when the peer is excluded or current authority is unavailable', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWFailClosedBoundPeer';
    const otherPeerId = '12D3KooWFailClosedOtherPeer';
    const excludedRecipient = makeFakeRecipient({ peerId });
    const unavailableRecipient = makeFakeRecipient({ peerId });
    for (const [contextGraphId, recipient, marker] of [
      ['test-cg/bound-peer-excluded', excludedRecipient, 7],
      ['test-cg/bound-authority-unavailable', unavailableRecipient, 8],
    ] as const) {
      internals.pendingSenderKeyByAgent.set(recipient.agentAddress.toLowerCase(), [{
        senderAgentAddress: ethers.Wallet.createRandom().address.toLowerCase(),
        recipientAgentAddress: recipient.agentAddress.toLowerCase(),
        recipientKeyId: recipient.recipientKeyId,
        recipientPeerId: peerId,
        epochId: `epoch-${marker}`,
        contextGraphId,
        packageBytes: new Uint8Array([marker]),
        createdAtMs: Date.now(),
      }]);
    }
    const resolvedGraphs: string[] = [];
    internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async ({ contextGraphId }) => {
      resolvedGraphs.push(contextGraphId);
      if (contextGraphId === 'test-cg/bound-authority-unavailable') {
        throw new Error('authority RPC unavailable');
      }
      return {
        requiresEncryption: true,
        recipients: [{ ...excludedRecipient, peerId: otherPeerId }],
      };
    };
    let sends = 0;
    installStubMessenger(internals, async () => {
      sends += 1;
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'unexpected' };
    });

    expect(await internals.drainPendingSenderKeyForPeer(peerId)).toBe(0);
    expect(new Set(resolvedGraphs)).toEqual(new Set([
      'test-cg/bound-peer-excluded',
      'test-cg/bound-authority-unavailable',
    ]));
    expect(sends).toBe(0);
    expect([...internals.pendingSenderKeyByAgent.values()].flat()).toHaveLength(2);
  });

  it('does not resolve a context graph bound only to another peer on connection-open', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const connectedPeerId = '12D3KooWUnrelatedConnectedPeer';
    const otherPeerId = '12D3KooWOnlyBoundOtherPeer';
    const recipient = makeFakeRecipient({ peerId: otherPeerId });
    const recipientAgentAddress = recipient.agentAddress.toLowerCase();
    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [{
      senderAgentAddress: ethers.Wallet.createRandom().address.toLowerCase(),
      recipientAgentAddress,
      recipientKeyId: recipient.recipientKeyId,
      recipientPeerId: otherPeerId,
      epochId: 'epoch-other-peer-only',
      contextGraphId: 'test-cg/other-peer-only',
      packageBytes: new Uint8Array([9]),
      createdAtMs: Date.now(),
    }]);
    const resolvedGraphs: string[] = [];
    internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async ({ contextGraphId }) => {
      resolvedGraphs.push(contextGraphId);
      throw new Error('must not resolve unrelated bound-only CG');
    };

    expect(await internals.drainPendingSenderKeyForPeer(connectedPeerId)).toBe(0);
    expect(resolvedGraphs).toEqual([]);
    expect(internals.pendingSenderKeyByAgent.get(recipientAgentAddress)).toHaveLength(1);
  });

  it('never expands an unbound CG retry to a peer excluded by current authority', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    await internals.loadSwmSenderKeyState();

    const contextGraphId = 'test-cg/unbound-authority-peer-fence';
    const allowedPeer = '12D3KooWUnboundAuthorityAllowedPeer';
    const disallowedPeer = '12D3KooWUnboundAuthorityDisallowedPeer';
    const recipient = await insertVerifiedAgentEncryptionKey(
      internals.store,
      ethers.Wallet.createRandom(),
      { peerId: disallowedPeer },
    );
    await internals.store.insert([{
      subject: recipient.recipientId,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: `"${allowedPeer}"`,
      graph: 'did:dkg:system/agents',
    }]);
    expect(new Set(
      (await resolveWorkspaceAgentRecipientKeys(internals.store, recipient.agentAddress))
        .map((route) => route.peerId),
    )).toEqual(new Set([allowedPeer, disallowedPeer]));
    const allowedRecipient = { ...recipient, peerId: allowedPeer };
    const senderAgentAddress = ethers.Wallet.createRandom().address.toLowerCase();
    internals.pendingSenderKeyByAgent.set(recipient.agentAddress.toLowerCase(), [{
      senderAgentAddress,
      recipientAgentAddress: recipient.agentAddress.toLowerCase(),
      recipientKeyId: recipient.recipientKeyId,
      epochId: 'epoch-unbound-authority-peer-fence',
      contextGraphId,
      packageBytes: new Uint8Array([4, 5, 6]),
      createdAtMs: Date.now(),
    }]);

    installStubDiscovery(internals, (peerId) => {
      if (peerId !== allowedPeer && peerId !== disallowedPeer) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'unbound-authority-peer-fence-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });
    const resolvedContextGraphs: string[] = [];
    internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async (input) => {
      resolvedContextGraphs.push(input.contextGraphId);
      return { requiresEncryption: true, recipients: [allowedRecipient] };
    };
    const sendPeers: string[] = [];
    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      sendPeers.push(peerId);
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: `m-unbound-authority-peer-fence-${peerId}`,
      };
    });

    expect(await internals.drainPendingSenderKeyForPeer(disallowedPeer)).toBe(0);
    expect(resolvedContextGraphs).toEqual([contextGraphId]);
    expect(sendPeers).toEqual([]);
    expect(
      internals.pendingSenderKeyByAgent
        .get(recipient.agentAddress.toLowerCase())
        ?.map((entry) => entry.recipientPeerId),
    ).toEqual([allowedPeer]);

    expect(await internals.drainPendingSenderKeyForPeer(allowedPeer)).toBe(1);
    expect(sendPeers).toEqual([allowedPeer]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(0);
  });

  it('preserves the pending destination peer across restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-swm-sender-pending-peer-route-'));
    tempDirs.push(dataDir);
    const firstBoot = await bootAgent({ dataDir });
    agent = firstBoot.agent;
    const firstInternals = firstBoot.internals;

    const peerA = '12D3KooWPersistedRoutePeerA';
    const peerB = '12D3KooWPersistedRoutePeerB';
    const recipient = makeFakeRecipient();
    const recipientAtA = { ...recipient, peerId: peerA };
    const recipientAtB = { ...recipient, peerId: peerB };
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(firstInternals, async (peerId): Promise<ReliableSendResult> => ({
      delivered: true,
      response: peerId === peerA
        ? senderKeyAck(true)
        : senderKeyAck(false, 'recipient authority is still converging', 'agent-gate-pending'),
      attempts: 1,
      messageId: `m-persisted-peer-route-${peerId}`,
    }));
    await firstInternals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/persisted-pending-peer-route',
      sender,
      recipients: [recipientAtA, recipientAtB],
      membershipHash: 'sha256:persisted-pending-peer-route',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    await firstInternals.saveSwmSenderKeyState();

    const persisted = JSON.parse(await readFile(join(dataDir, 'swm-sender-keys.json'), 'utf-8')) as {
      pending?: Array<{ recipientPeerId?: string }>;
    };
    expect(persisted.pending).toEqual([
      expect.objectContaining({ recipientPeerId: peerB }),
    ]);

    await agent.stop();
    agent = null;

    const secondBoot = await bootAgent({ dataDir });
    agent = secondBoot.agent;
    const secondInternals = secondBoot.internals;
    installCurrentRecipientAuthority(secondInternals, [recipientAtA, recipientAtB]);
    installStubDiscovery(secondInternals, (peerId) => {
      if (peerId !== peerA && peerId !== peerB) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'persisted-peer-route-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });
    const retryPeers: string[] = [];
    installStubMessenger(secondInternals, async (peerId): Promise<ReliableSendResult> => {
      retryPeers.push(peerId);
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: `m-persisted-peer-route-retry-${peerId}`,
      };
    });

    expect(await secondInternals.drainPendingSenderKeyForPeer(peerA)).toBe(0);
    expect(secondInternals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase())).toHaveLength(1);
    expect(await secondInternals.drainPendingSenderKeyForPeer(peerB)).toBe(1);
    expect(retryPeers).toEqual([peerB]);
    expect(secondInternals.pendingSenderKeyByAgent.size).toBe(0);
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
    installCurrentRecipientAuthority(internals, [reachableRecipient]);
    const drained = await internals.drainPendingSenderKeyForRecipients(
      [reachableRecipient],
      { operationId: 'test-op', operationName: 'share' },
      pendingDrainScope(
        internals,
        recipient.agentAddress,
        'test-cg/publish-drain',
      ),
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

    const peerId = '12D3KooWSoftDrainTest';
    installCurrentRecipientAuthority(internals, [{ ...recipient, peerId }]);
    const drained = await internals.drainPendingSenderKeyForRecipients([{
      ...recipient,
      peerId,
    }], undefined, pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/drain-soft',
    ));
    expect(drained).toBe(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
    expect(
      internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase())?.[0].recipientPeerId,
    ).toBe(peerId);
  });

  it('revalidates authority after waiting for another drain of the same recipient', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWDrainAuthorityRacePeer';
    const recipient = makeFakeRecipient({ peerId });
    const recipientAgentAddress = recipient.agentAddress.toLowerCase();
    const contextGraphId = 'test-cg/drain-authority-race';
    const firstSender = ethers.Wallet.createRandom().address.toLowerCase();
    const base: PendingSenderKeyEntry = {
      senderAgentAddress: firstSender,
      recipientAgentAddress,
      recipientKeyId: recipient.recipientKeyId,
      recipientPeerId: peerId,
      epochId: 'epoch-first',
      contextGraphId,
      packageBytes: new Uint8Array([10]),
      createdAtMs: Date.now(),
    };
    internals.pendingSenderKeyByAgent.set(recipientAgentAddress, [
      base,
      {
        ...base,
        senderAgentAddress: ethers.Wallet.createRandom().address.toLowerCase(),
        epochId: 'epoch-waiting',
        packageBytes: new Uint8Array([11]),
      },
    ]);

    let authorityCurrent = true;
    let resolutionCalls = 0;
    let markConnectionSnapshotResolved!: () => void;
    const connectionSnapshotResolved = new Promise<void>((resolve) => {
      markConnectionSnapshotResolved = resolve;
    });
    internals.resolveWorkspaceAgentRecipientsForCurrentAuthority = async () => {
      resolutionCalls += 1;
      if (resolutionCalls === 2) markConnectionSnapshotResolved();
      return authorityCurrent
        ? { requiresEncryption: true, recipients: [recipient] }
        : { requiresEncryption: false, recipients: [] };
    };

    let markFirstSendStarted!: () => void;
    let releaseFirstSend!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => { markFirstSendStarted = resolve; });
    const firstSendReleased = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    const sentMarkers: number[] = [];
    installStubMessenger(internals, async (_peerId, _protocolId, payload) => {
      sentMarkers.push(payload[0]);
      if (sentMarkers.length === 1) {
        markFirstSendStarted();
        await firstSendReleased;
      }
      return { delivered: true, response: senderKeyAck(true), attempts: 1, messageId: 'm-authority-race' };
    });

    const foregroundDrain = internals.drainPendingSenderKeyForRecipients(
      [recipient],
      undefined,
      {
        contextGraphId,
        senderAgentAddress: firstSender,
        epochId: base.epochId,
      },
    );
    await firstSendStarted;
    const connectionDrain = internals.drainPendingSenderKeyForPeer(peerId);
    await connectionSnapshotResolved;
    authorityCurrent = false;
    releaseFirstSend();

    await expect(Promise.all([foregroundDrain, connectionDrain])).resolves.toEqual([1, 0]);
    expect(sentMarkers).toEqual([10]);
    expect(
      internals.pendingSenderKeyByAgent.get(recipientAgentAddress)?.map((entry) => entry.packageBytes[0]),
    ).toEqual([11]);
  });

  it('serializes concurrent pending drains for the same recipient', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const peerId = '12D3KooWSerializedDrainPeer';
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: opts?.messageId ?? 'm-drain-serialized-initial',
      error: 'recipient temporarily offline',
    }));
    const recipient = makeFakeRecipient({ peerId });
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

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'drain-serialized-target',
      peerId,
      agentAddress: recipient.agentAddress,
    }));
    installCurrentRecipientAuthority(internals, [recipient]);

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

  it('does not overwrite a concurrently enqueued epoch when an awaited drain commits', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const peerId = '12D3KooWConcurrentEnqueueDrainPeer';
    const recipient = makeFakeRecipient({ peerId });
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(false, 'recipient authority is still converging', 'agent-gate-pending'),
      attempts: 1,
      messageId: 'm-concurrent-enqueue-initial',
    }));
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/concurrent-enqueue-drain',
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:concurrent-enqueue-drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const original = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase())?.[0];
    if (!original) throw new Error('missing original pending row');

    installStubDiscovery(internals, () => ({
      agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
      name: 'concurrent-enqueue-drain-target',
      peerId,
      agentAddress: recipient.agentAddress,
    }));
    installCurrentRecipientAuthority(internals, [recipient]);
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => {
      markSendStarted();
      await sendReleased;
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: 'm-concurrent-enqueue-drain',
      };
    });

    const drain = internals.drainPendingSenderKeyForPeer(peerId);
    await sendStarted;
    const concurrentEpoch = 'epoch-enqueued-during-drain';
    internals.enqueuePendingSenderKey({
      ...original,
      epochId: concurrentEpoch,
      packageBytes: new Uint8Array([9, 8, 7]),
      messageId: 'm-concurrent-new-epoch',
      createdAtMs: Date.now(),
    });
    releaseSend();

    await expect(drain).resolves.toBe(1);
    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(1);
    expect(queue?.[0]).toMatchObject({
      epochId: concurrentEpoch,
      messageId: 'm-concurrent-new-epoch',
      recipientPeerId: peerId,
    });
  });

  it('does not let another peer consume a route-bound retry while its drain is in flight', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const stalePeerId = '12D3KooWStaleDrainPeer';
    const freshPeerId = '12D3KooWFreshDrainPeer';
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: opts?.messageId ?? 'm-drain-peer-race-initial',
      error: 'recipient temporarily offline',
    }));
    const recipient = makeFakeRecipient({ peerId: stalePeerId });
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

    installStubDiscovery(internals, (peerId) => {
      if (peerId !== stalePeerId && peerId !== freshPeerId) return null;
      return {
        agentUri: `did:dkg:agent:${recipient.agentAddress.toLowerCase()}`,
        name: 'drain-peer-race-target',
        peerId,
        agentAddress: recipient.agentAddress,
      };
    });
    installCurrentRecipientAuthority(internals, [recipient]);

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

    await expect(Promise.all([staleDrain, freshDrain])).resolves.toEqual([0, 0]);
    expect(sendCalls).toEqual([stalePeerId]);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
  });

  it('surfaces non-recoverable pending drain send failures instead of re-queuing silently', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const peerId = '12D3KooWNonRecoverableDrainPeer';
    installStubMessenger(internals, async (_peerId, _protocolId, _payload, opts) => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: opts?.messageId ?? 'm-nonrecoverable-initial',
      error: 'recipient temporarily offline',
    }));
    const recipient = makeFakeRecipient({ peerId });
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
      peerId,
      agentAddress: recipient.agentAddress,
    }));
    installCurrentRecipientAuthority(internals, [recipient]);
    installStubMessenger(internals, async () => {
      throw new Error('messenger substrate misconfigured');
    });

    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push({ level: entry.level, message: entry.message }));

    await expect(
      internals.drainPendingSenderKeyForPeer(peerId),
    ).rejects.toThrow('messenger substrate misconfigured');
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('failed before the Messenger substrate queued a retry'),
    }));
  });

  it('expands a persisted legacy row into every exact key route across restart', async () => {
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
    await secondInternals.loadSwmSenderKeyState();
    expect(secondInternals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase())).toEqual([
      expect.objectContaining({ recipientPeerId: undefined }),
    ]);

    const peerA = '12D3KooWPersistedReconnectDrainPeerA';
    const peerB = '12D3KooWPersistedReconnectDrainPeerB';
    const recipients = [
      { ...recipient, peerId: peerA },
      { ...recipient, peerId: peerB },
    ];
    const expansionAttempts: string[] = [];
    installStubMessenger(secondInternals, async (peerId, _protocolId, _payload, opts): Promise<ReliableSendResult> => {
      expansionAttempts.push(peerId);
      return {
        delivered: false,
        queued: true,
        attempts: 1,
        messageId: opts?.messageId ?? `m-persisted-expand-${peerId}`,
        error: 'recipient temporarily offline',
      };
    });
    installCurrentRecipientAuthority(secondInternals, recipients as [FakeRecipient, ...FakeRecipient[]]);

    expect(await secondInternals.drainPendingSenderKeyForRecipients(
      recipients,
      undefined,
      pendingDrainScope(
        secondInternals,
        recipient.agentAddress,
        'test-cg/persisted-reconnect-drain',
      ),
    )).toBe(0);
    expect(expansionAttempts).toEqual([peerA, peerB]);
    expect(
      secondInternals.pendingSenderKeyByAgent
        .get(recipient.agentAddress.toLowerCase())
        ?.map((entry) => entry.recipientPeerId),
    ).toEqual([peerA, peerB]);

    await agent.stop();
    agent = null;

    const thirdBoot = await bootAgent({ dataDir });
    agent = thirdBoot.agent;
    const thirdInternals = thirdBoot.internals;
    await thirdInternals.loadSwmSenderKeyState();
    const retryPeers: string[] = [];
    installStubMessenger(thirdInternals, async (peerId): Promise<ReliableSendResult> => {
      retryPeers.push(peerId);
      return {
        delivered: true,
        response: senderKeyAck(true),
        attempts: 1,
        messageId: `m-persisted-retry-${peerId}`,
      };
    });
    installCurrentRecipientAuthority(thirdInternals, recipients as [FakeRecipient, ...FakeRecipient[]]);

    expect(await thirdInternals.drainPendingSenderKeyForRecipients(
      recipients,
      undefined,
      pendingDrainScope(
        thirdInternals,
        recipient.agentAddress,
        'test-cg/persisted-reconnect-drain',
      ),
    )).toBe(2);
    expect(retryPeers).toEqual([peerA, peerB]);
    expect(thirdInternals.pendingSenderKeyByAgent.size).toBe(0);
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

  it('queues a chain-proven private gate that has not materialized on the receiver yet', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const recipient = makeFakeRecipient({ peerId: '12D3KooWPrivateGatePendingPeer' });
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: senderKeyAck(
        false,
        'private agent gate is not materialized yet',
        'agent-gate-pending',
      ),
      attempts: 1,
      messageId: 'm-private-gate-pending',
    }));

    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/private-gate-pending',
        sender,
        recipients: [recipient],
        membershipHash: 'sha256:private-gate-pending',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).resolves.toBeTruthy();

    const queue = internals.pendingSenderKeyByAgent.get(recipient.agentAddress.toLowerCase());
    expect(queue).toHaveLength(1);
    expect(queue![0].messageId).toMatch(/^swm-sender-key:[0-9a-f]{64}:[0-9a-f-]{36}$/);
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
    installCurrentRecipientAuthority(internals, [{
      ...recipient,
      peerId: '12D3KooWDrainFutureRejectPeer',
    }]);

    const drained = await internals.drainPendingSenderKeyForRecipients([{
      ...recipient,
      peerId: '12D3KooWDrainFutureRejectPeer',
    }], undefined, pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/drain-transient-reject',
    ));
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
      recipientRouteHash: computeSwmSenderKeyRecipientRouteHash({
        contextGraphId,
        recipients: resolution.recipients,
      }),
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
    installCurrentRecipientAuthority(internals, [{
      ...recipient,
      peerId: '12D3KooWDrainHardRejectPeer',
    }]);

    const drained = await internals.drainPendingSenderKeyForRecipients([{
      ...recipient,
      peerId: '12D3KooWDrainHardRejectPeer',
    }], undefined, pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/drain-retryable',
    ));
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
    installCurrentRecipientAuthority(internals, [{
      ...recipient,
      peerId: '12D3KooWDrainMalformedAckPeer',
    }]);

    const drained = await internals.drainPendingSenderKeyForRecipients([{
      ...recipient,
      peerId: '12D3KooWDrainMalformedAckPeer',
    }], undefined, pendingDrainScope(
      internals,
      recipient.agentAddress,
      'test-cg/drain-malformed-ack',
    ));
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
// Reconnect regression — drain must use the agent's real store-backed
// recipient resolver, not a fixture-supplied key-to-peer route. Exercise the
// production lookup against the agent registry CG so a queued package remains
// pending until its exact wallet-signed (agent, key, peer) route is published.
// -----------------------------------------------------------------------------
describe('drainPendingSenderKeyForPeer: real recipient lookup + agent registry CG', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('keeps a sender key queued until the recipient publishes its signed key-to-peer route, then drains it', async () => {
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
    const contextGraphId = 'test-cg/real-drain';
    const recipientPeerId = '12D3KooWRealDrainTestRecipient';
    const recipientWallet = ethers.Wallet.createRandom();
    const recipient = await insertVerifiedAgentEncryptionKey(
      internals.store,
      recipientWallet,
    );
    await insertAgentGate(internals.store, contextGraphId, recipient.agentAddress);

    // Only the synthetic graph's transport classification is stubbed. Recipient
    // keys and peer routes must still come through the production store-backed
    // resolver used by reconnect.
    (internals as unknown as {
      resolveSwmTransportAuthority(contextGraphId: string): Promise<{ kind: 'legacy-unregistered' }>;
    }).resolveSwmTransportAuthority = async (resolvedContextGraphId) => {
      expect(resolvedContextGraphId).toBe(contextGraphId);
      return { kind: 'legacy-unregistered' };
    };
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId,
      sender,
      recipients: [recipient],
      membershipHash: 'sha256:real-drain',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // The signed key exists, but it is not yet bound to this reconnecting peer.
    // The production resolver must therefore leave the durable row untouched.
    expect(await internals.drainPendingSenderKeyForPeer(recipientPeerId)).toBe(0);
    expect(sendCalls).toHaveLength(0);
    expect(internals.pendingSenderKeyByAgent.size).toBe(1);

    // Now publish the recipient's wallet-signed encryption key in the same
    // profile graph as its peer metadata. This is the exact route shape the
    // production resolver joins before reconnect may drain the package.
    const publicEncryptionKey = encodeWorkspaceEncryptionKey(recipient.publicKeyBytes);
    const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
      agentAddress: recipientWallet.address,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: recipient.publicKeyBytes,
    });
    const encryptionKeyProof = recipientWallet.signingKey
      .sign(ethers.hashMessage(proofPayload)).serialized;
    const { quads } = buildAgentProfile({
      peerId: recipientPeerId,
      name: 'RealDrainRecipient',
      agentAddress: recipient.agentAddress,
      publicEncryptionKey,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      encryptionKeyProof,
      skills: [],
    });
    await internals.store.insert(quads);

    const drained = await internals.drainPendingSenderKeyForPeer(recipientPeerId);

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
