// PR-1 latency pin: `createAndDistributeSwmSenderKeyEpoch` must fan out to
// all recipients in parallel.
//
// Pre-rc.12 the function awaited each `messenger.sendReliable` sequentially
// inside a `for (const recipient of input.recipients)` loop. With the
// per-send timeout floor at 20 s and a quorum of 5+ keys, foreground
// publish latency scaled to ~minutes when any one recipient stalled. We
// now wrap every per-recipient closure in `Promise.allSettled`, so the
// wall-clock cost is bounded by the slowest individual send rather than
// the sum of all sends.
//
// This test pins the parallelism by injecting a fake messenger whose
// `sendReliable` sleeps a controllable amount, then asserting that the
// total elapsed time for N recipients is closer to one slot than to N.
//
// Failure mode this catches: a future refactor that re-introduces an
// `await` inside the loop (e.g. "we need to read X synchronously before
// the next send"). The latency assertion is generous on purpose — CI
// jitter makes tight wall-clock bounds flaky — but the gap between
// "parallel" and "serial" is 6x for N=6, well outside any reasonable
// noise floor.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  encodeSwmSenderKeyPackageAck,
  decodeSwmSenderKeyPackage,
  generateWorkspaceRecipientEncryptionKey,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  agentFromPrivateKey,
  type AgentKeyRecord,
} from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';
import type { LocalSwmSenderKeySendState } from '../src/dkg-agent-types.js';
import { swmSenderStateKey } from '../src/dkg-agent-swm-state.js';

// The fanout function lives on the agent class but is `private`. The
// existing swm-sender-key-stale-target test reaches it via the same
// `as unknown as` cast pattern; we mirror that here. `messenger` is
// public on the agent but only populated by `start()`, which spins
// the full libp2p stack — heavier than this unit test needs. We
// inject a fake messenger directly into the field instead.
type StubMessenger = {
  sendReliable: (
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
  ) => Promise<ReliableSendResult>;
};
interface FanoutInternals {
  messenger: StubMessenger;
  node: { peerId: { toString(): string } };
  swmSenderKeySendStates: Map<string, LocalSwmSenderKeySendState>;
  createAndDistributeSwmSenderKeyEpoch(input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly FakeRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<LocalSwmSenderKeySendState>;
}

interface FakeRecipient {
  agentAddress: string;
  peerId?: string;
  recipientKeyId: string;
  recipientId: string;
  purpose: typeof WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE;
  encryptionKeyAlgorithm: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
  publicKeyBytes: Uint8Array;
}

function makeFakeRecipient(): FakeRecipient {
  const wallet = ethers.Wallet.createRandom();
  const agentAddress = wallet.address;
  const recipientId = `did:dkg:agent:${agentAddress.toLowerCase()}`;
  const recipientKeyId = `${recipientId}#x25519-${ethers.id(wallet.privateKey).slice(2, 34)}`;
  const key = generateWorkspaceRecipientEncryptionKey(recipientId, recipientKeyId);
  return {
    agentAddress,
    peerId: `12D3KooWFakeTestPeer${ethers.id(agentAddress).slice(2, 18)}`,
    recipientKeyId,
    recipientId,
    purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes: key.publicKeyBytes!,
  };
}

function installStubMessenger(
  internals: FanoutInternals,
  sendReliable: StubMessenger['sendReliable'],
): void {
  internals.messenger = { sendReliable };
  // `node.peerId.toString()` is referenced when the recipient happens
  // to be the local agent (fan-in branch); our fakeRecipients never
  // are, but the field is read on every call so keep it defined.
  if (!internals.node) {
    (internals as { node: { peerId: { toString(): string } } }).node = {
      peerId: { toString: () => '12D3KooWStubLocalPeerForFanoutTest' },
    };
  }
}

async function bootAgent(): Promise<{ agent: DKGAgent; internals: FanoutInternals }> {
  const agent = await DKGAgent.create({
    name: 'FanoutLatencyTest',
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as FanoutInternals;
  return { agent, internals };
}

describe('createAndDistributeSwmSenderKeyEpoch: parallel fanout latency', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('assigns a strictly increasing WAL key epoch when Sender Key rotation lands in one millisecond', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    installStubMessenger(internals, async () => ({
      delivered: true,
      response: encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
      }),
      attempts: 1,
      messageId: 'm-monotonic',
    }));
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };
    const input = {
      contextGraphId: 'test-cg/wal-key-epoch',
      sender,
      recipients: [makeFakeRecipient()],
      membershipHash: 'sha256:first',
      ctx: { operationId: 'test-op', operationName: 'share' } as OperationContext,
    };
    const first = await internals.createAndDistributeSwmSenderKeyEpoch(input);
    internals.swmSenderKeySendStates.set(
      swmSenderStateKey(input.contextGraphId, undefined, first.senderAgentAddress),
      first,
    );
    const second = await internals.createAndDistributeSwmSenderKeyEpoch({
      ...input,
      membershipHash: 'sha256:second',
    });
    expect(second.createdAtMs).toBe(first.createdAtMs + 1);
    expect(second.walEpochKey).not.toEqual(first.walEpochKey);
  });

  it('fans out concurrently (N recipients ≈ one slot, not N slots)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const N = 6;
    const SEND_DELAY_MS = 200;

    // Inject a stub messenger whose `sendReliable` sleeps SEND_DELAY_MS
    // then returns an "accepted" ack. We bypass `agent.start()` to keep
    // the test free of libp2p plumbing — the fanout function only needs
    // the messenger surface to fire each recipient send.
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => {
      await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
      const ack = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
      });
      return { delivered: true, response: ack, attempts: 1, messageId: 'm-test' };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = Array.from({ length: N }, makeFakeRecipient);
    const start = Date.now();
    await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/fanout-latency',
      sender,
      recipients,
      membershipHash: 'sha256:fanout-latency-test',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    const elapsed = Date.now() - start;

    // Parallel: ~SEND_DELAY_MS. Serial: ~N * SEND_DELAY_MS.
    // Pick a threshold roughly halfway through that gap, biased toward
    // the parallel side to leave headroom for CI scheduler jitter +
    // ack-encoding cost. With SEND_DELAY=200ms and N=6, the gap is
    // 200ms (parallel) vs 1200ms (serial); 600ms reliably distinguishes
    // them while accommodating slow runners.
    const PARALLEL_BUDGET_MS = SEND_DELAY_MS * 3;
    expect(elapsed).toBeLessThan(PARALLEL_BUDGET_MS);
  });

  it('aggregates per-recipient hard failures into a single throw', async () => {
    // Sanity check on the post-settle aggregation: when EVERY key for
    // an agent fails (here the messenger always returns a terminal
    // "accepted=false" ack), we must surface a fatal-agents throw rather
    // than silently returning a state. This pins the existing C2 contract
    // through the new aggregation path.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => {
      const ack = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason: 'bad membership hash',
        reasonCode: 'bad-signature',
      });
      return { delivered: true, response: ack, attempts: 1, messageId: 'm-test' };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = [makeFakeRecipient(), makeFakeRecipient()];
    await expect(
      internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/fanout-fatal',
        sender,
        recipients,
        membershipHash: 'sha256:fanout-fatal',
        ctx: { operationId: 'test-op', operationName: 'share' },
      }),
    ).rejects.toThrow(/SWM Sender Key setup rejected by 2 agent\(s\)/);
  });

  it('classifies delivered=false as soft success (no throw)', async () => {
    // Soft-success contract: when messenger.sendReliable returns
    // `delivered: false, queued: true`, the recipient is durably queued
    // and the publish must proceed. Pre-PR-1 the per-iteration `continue`
    // already implemented this; the new Promise.allSettled flow keeps
    // it via the `return { kind: 'success' }` branch inside the
    // delivered=false handler.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: 'm-queued',
      error: 'recipient offline',
      nextAttemptAtMs: Date.now() + 60_000,
    }));

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    const recipients = [makeFakeRecipient(), makeFakeRecipient(), makeFakeRecipient()];
    const state = await internals.createAndDistributeSwmSenderKeyEpoch({
      contextGraphId: 'test-cg/fanout-soft',
      sender,
      recipients,
      membershipHash: 'sha256:fanout-soft',
      ctx: { operationId: 'test-op', operationName: 'share' },
    });
    expect(state).toBeDefined();
    expect(state.walEpochKey).toEqual(state.chainKey);
    expect(state.walEpochKey).toHaveLength(32);
  });

  it('1-of-N partial fail: throw cites only the agent whose keys all failed; non-failed peers do not appear in the error', async () => {
    // The aggregation logic at `dkg-agent.ts:5998-6042` separates per-
    // agent outcomes: a fatal agent is one where EVERY key failed. The
    // throw must:
    //   - include exactly the fatal agent(s) — not the successful ones
    //   - count them correctly ("N agent(s)" in the message)
    //   - leave the other recipients' deliveries observable as
    //     successes (e.g. their epoch state)
    //
    // This pins the "M of N agents fatal" branch the existing all-fail
    // and all-soft tests don't reach.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const recipientA = makeFakeRecipient();
    const recipientB = makeFakeRecipient(); // <-- this one's keys will fail
    const recipientC = makeFakeRecipient();

    // Messenger returns ACCEPTED for A and C, REJECTED for B. We
    // discriminate on the recipient peerId since each fake recipient
    // has a deterministic peerId derived from its agentAddress.
    installStubMessenger(internals, async (peerId): Promise<ReliableSendResult> => {
      const acceptedEnvelope = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
      });
      const rejectedEnvelope = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason: 'simulated per-recipient fatal',
        reasonCode: 'bad-signature',
      });
      const isBfailure = peerId === recipientB.peerId;
      return {
        delivered: true,
        response: isBfailure ? rejectedEnvelope : acceptedEnvelope,
        attempts: 1,
        messageId: `m-test-${peerId.slice(-6)}`,
      };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    let thrown: Error | null = null;
    try {
      await internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/fanout-1ofN',
        sender,
        recipients: [recipientA, recipientB, recipientC],
        membershipHash: 'sha256:fanout-1ofN',
        ctx: { operationId: 'test-op', operationName: 'share' },
      });
    } catch (err) {
      thrown = err as Error;
    }

    // Must throw — recipient B is fatal even though A and C succeeded.
    expect(thrown).not.toBeNull();
    // Aggregation count must be EXACTLY 1 — not 3 (every agent), not
    // 0 (none).
    expect(thrown!.message).toMatch(/rejected by 1 agent\(s\)/);
    // Identity of the fatal agent must be present in the throw.
    expect(thrown!.message.toLowerCase()).toContain(recipientB.agentAddress.toLowerCase());
    // Identities of the successful agents MUST NOT be present (would
    // leak diagnostic noise and mislead operators).
    expect(thrown!.message.toLowerCase()).not.toContain(recipientA.agentAddress.toLowerCase());
    expect(thrown!.message.toLowerCase()).not.toContain(recipientC.agentAddress.toLowerCase());
    // The simulated per-recipient reason should bubble up via the
    // failure list (proves the per-key reasons are forwarded).
    expect(thrown!.message).toContain('simulated per-recipient fatal');
  });

  it('per-AGENT (not per-key) aggregation: an agent with 2 keys where 1 accepts and 1 rejects is NOT fatal', async () => {
    // Codex review feedback on #740: the 1-of-N test above uses one
    // key per agent, so it does not actually exercise the
    // "fatal only when EVERY key for an agent fails" aggregation
    // rule documented at `dkg-agent.ts:5998-6042`. A regression
    // that started aggregating by key (instead of by agent) would
    // pass that test silently — any one key rejection would still
    // throw, even if other keys for the SAME agent succeeded.
    //
    // To pin the per-agent semantics, build recipientB with TWO
    // keys (same `agentAddress` + `peerId`, distinct
    // `recipientKeyId` + `publicKeyBytes`) and have the messenger
    // accept one and reject the other. The expected production
    // behavior: B is logged as a partial-delivery warning but NOT
    // added to `fatalAgents`, so the fanout call resolves
    // successfully overall. recipientA with a single all-fail key
    // is the actual fatal — the only one cited in the throw.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Build recipientB with two keys for the SAME agent.
    const wallet = ethers.Wallet.createRandom();
    const agentAddress = wallet.address;
    const recipientId = `did:dkg:agent:${agentAddress.toLowerCase()}`;
    const peerId = `12D3KooWFakeTestPeer${ethers.id(agentAddress).slice(2, 18)}`;
    const keyAId = `${recipientId}#x25519-keyA-${ethers.id(`${agentAddress}|A`).slice(2, 10)}`;
    const keyBId = `${recipientId}#x25519-keyB-${ethers.id(`${agentAddress}|B`).slice(2, 10)}`;
    const keyA = generateWorkspaceRecipientEncryptionKey(recipientId, keyAId);
    const keyB = generateWorkspaceRecipientEncryptionKey(recipientId, keyBId);
    const recipientB_keyA: FakeRecipient = {
      agentAddress,
      peerId,
      recipientKeyId: keyAId,
      recipientId,
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: keyA.publicKeyBytes!,
    };
    const recipientB_keyB: FakeRecipient = {
      agentAddress,
      peerId,
      recipientKeyId: keyBId,
      recipientId,
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes: keyB.publicKeyBytes!,
    };
    // A separate agent whose only key always fails — the genuine
    // fatal, used as the control to keep the throw observable.
    const recipientFatal = makeFakeRecipient();
    // And one fully-successful agent to keep the all-accept path
    // active in this scenario.
    const recipientHappy = makeFakeRecipient();

    // Messenger discrimination:
    //  - recipientFatal: always reject (genuine fatal)
    //  - recipientB peerId: reject the call carrying keyAId, accept
    //    the call carrying keyBId. Both calls go to the SAME peerId
    //    so we need a STABLE per-key discriminator — Codex review
    //    feedback on the prior revision: keying off the per-peer
    //    call ordinal was order-dependent because the fanout's
    //    `createSignedSwmSenderKeyPackage` runs per-recipient in
    //    parallel and the two sends can race to the messenger in
    //    either order. The `SwmSenderKeyPackage` proto encodes
    //    `recipientKeyId` as a top-level plaintext field (the
    //    recipient needs it to pick the right decryption key), so
    //    we decode the payload and key the decision off that.
    //  - everyone else: accept.
    const callsByPeer = new Map<string, number>();
    const seenKeyIds: string[] = [];
    installStubMessenger(internals, async (sendPeerId, _protocolId, payload): Promise<ReliableSendResult> => {
      const acceptedEnvelope = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
      });
      const rejectedEnvelope = encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason: 'simulated key-level rejection',
        reasonCode: 'bad-signature',
      });
      callsByPeer.set(sendPeerId, (callsByPeer.get(sendPeerId) ?? 0) + 1);

      if (sendPeerId === recipientFatal.peerId) {
        return {
          delivered: true,
          response: rejectedEnvelope,
          attempts: 1,
          messageId: `m-fatal-${sendPeerId.slice(-6)}`,
        };
      }
      if (sendPeerId === peerId) {
        // Decode the package to read `recipientKeyId` directly —
        // robust against the per-recipient send race.
        const pkg = decodeSwmSenderKeyPackage(payload);
        seenKeyIds.push(pkg.recipientKeyId);
        return {
          delivered: true,
          response: pkg.recipientKeyId === keyAId ? rejectedEnvelope : acceptedEnvelope,
          attempts: 1,
          messageId: `m-mixed-${pkg.recipientKeyId.slice(-8)}`,
        };
      }
      return {
        delivered: true,
        response: acceptedEnvelope,
        attempts: 1,
        messageId: `m-happy-${sendPeerId.slice(-6)}`,
      };
    });

    const sender = agentFromPrivateKey(
      ethers.Wallet.createRandom().privateKey,
      'sender',
    ) as AgentKeyRecord & { privateKey: string };

    let thrown: Error | null = null;
    try {
      await internals.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: 'test-cg/per-agent-mixed',
        sender,
        // Order matters for the per-peer ordinal discrimination:
        // B_keyA is sent BEFORE B_keyB, so the messenger's "first
        // call to recipientB's peerId" reliably maps to keyA.
        recipients: [recipientHappy, recipientB_keyA, recipientB_keyB, recipientFatal],
        membershipHash: 'sha256:per-agent-mixed',
        ctx: { operationId: 'test-op', operationName: 'share' },
      });
    } catch (err) {
      thrown = err as Error;
    }

    // We expect a throw — recipientFatal is the only ALL-fail agent.
    expect(thrown).not.toBeNull();

    // Pin per-AGENT semantics: exactly 1 fatal agent (not 2). A
    // regression that counted per-key would surface "2 agent(s)"
    // because recipientB had a key-level rejection too.
    expect(thrown!.message).toMatch(/rejected by 1 agent\(s\)/);

    // The throw must cite recipientFatal but NOT recipientB —
    // recipientB had partial success and is intentionally not
    // listed as fatal under the per-agent rule.
    expect(thrown!.message.toLowerCase()).toContain(recipientFatal.agentAddress.toLowerCase());
    expect(thrown!.message.toLowerCase()).not.toContain(agentAddress.toLowerCase());
    expect(thrown!.message.toLowerCase()).not.toContain(recipientHappy.agentAddress.toLowerCase());

    // Sanity: recipientB's peerId was called exactly twice and the
    // per-key discrimination correctly saw BOTH keyAId and keyBId
    // (order doesn't matter — that's the whole point of decoding
    // the payload instead of using a per-peer call ordinal).
    expect(callsByPeer.get(peerId)).toBe(2);
    expect([...seenKeyIds].sort()).toEqual([keyAId, keyBId].sort());
  });
});
