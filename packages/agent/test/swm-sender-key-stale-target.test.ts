// Operator-noise reduction for the SWM sender-key receive path.
//
// On testnet edge-node logs we observed up to 5 WARN lines per peer
// per session of the form:
//
//   SWM sender-key setup receive rejected: ... reason=No local
//     X25519 private key for DKG agent <addr> key <keyId>
//
// Each WARN was a single bootstrap attempt where the sender targeted
// a *stale* X25519 fingerprint of our agent (e.g. cached from a
// registry observation taken before our last rotation). The sender
// fans the bootstrap out across every cached fingerprint it knows of;
// only the one that matches our currently active key passes (logged
// at INFO via `SWM sender-key setup receive accepted`). The rejected
// attempts are not actionable and clutter `daemon.log`.
//
// The fix throws a typed `StaleSenderKeyTargetError` for that exact
// outcome so the receive handler can route it to DEBUG. Genuine
// failure modes (signature mismatch, agent-gate violation, recipient
// not local, revoked-key targeting) keep throwing generic `Error`s
// and stay at WARN.
//
// These tests pin both halves of the invariant: the typed error is
// what's actually thrown for the stale-key case, and the receive
// handler routes it to DEBUG (no WARN sink entry) while still routing
// other failures to WARN.

import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Logger,
  computeSwmSenderKeyPackageAAD,
  encodeSwmSenderKeyPackage,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  generateWorkspaceRecipientEncryptionKey,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { SwmSenderKeyPackageMsg } from '@origintrail-official/dkg-core';
import {
  DKGAgent,
  StaleSenderKeyTargetError,
  agentFromPrivateKey,
  type AgentKeyRecord,
} from '../src/index.js';

interface DKGAgentInternals {
  localAgents: Map<string, AgentKeyRecord>;
  // Both private — we reach in via this view to drive them in tests.
  acceptSwmSenderKeyPackage(
    pkg: SwmSenderKeyPackageMsg,
    fromPeerId: string,
    ctx: OperationContext,
  ): Promise<void>;
  handleSwmSenderKeyPackage(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  // Exposed for the `agentGate` mock so we don't have to spin up a
  // full context graph + membership snapshot just to drive the
  // sender-key bootstrap path.
  getContextGraphAgentGateAddresses(contextGraphId: string): Promise<string[] | null>;
}

interface CapturedLog {
  level: string;
  message: string;
}

const TEST_CONTEXT_GRAPH_ID = 'agent-test-cg/swm-stale-target';
const FROM_PEER_ID = '12D3KooWStaleTargetTestPeer';

async function buildSignedPackage(input: {
  senderWallet: ethers.HDNodeWallet;
  recipientAgentAddress: string;
  recipientKeyId: string;
}): Promise<SwmSenderKeyPackageMsg> {
  const signingKp = await generateEd25519Keypair();
  const chainKey = generateSwmSenderChainKey();
  // The recipient pubkey is only used by the sender as the second leg
  // of the X25519 ECDH that derives the package setup key. We never
  // exercise the decrypt path in these tests (the throw fires before
  // it), so a freshly-minted ephemeral pubkey is sufficient — its
  // only contract is "32-byte X25519 public key bytes".
  const ephemeralRecipientPub = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${input.recipientAgentAddress}`,
    input.recipientKeyId,
  ).publicKeyBytes!;

  const pkg = await encryptSwmSenderKeyPackage({
    contextGraphId: TEST_CONTEXT_GRAPH_ID,
    senderAgentAddress: input.senderWallet.address,
    epochId: generateSwmSenderEpochId(),
    membershipHash: 'sha256:stale-target-test',
    recipientAgentAddress: input.recipientAgentAddress,
    recipientKeyId: input.recipientKeyId,
    createdAtMs: Date.now(),
    initialMessageIndex: 0,
    chainKey,
    senderSigningPublicKey: signingKp.publicKey,
    recipientPublicKey: ephemeralRecipientPub,
  });
  const aad = computeSwmSenderKeyPackageAAD(pkg);
  pkg.signature = ethers.getBytes(await input.senderWallet.signMessage(aad));
  return pkg;
}

async function bootAgentForStaleTargetTest(): Promise<{
  agent: DKGAgent;
  internals: DKGAgentInternals;
  recipient: AgentKeyRecord;
  senderWallet: ethers.HDNodeWallet;
}> {
  const agent = await DKGAgent.create({
    name: 'StaleTargetTest',
    chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as DKGAgentInternals;
  const recipient = agentFromPrivateKey(
    ethers.Wallet.createRandom().privateKey,
    'recipient',
  );
  internals.localAgents.set(recipient.agentAddress, recipient);
  const senderWallet = ethers.Wallet.createRandom();
  // Stub the agent-gate lookup. The real implementation reads it
  // from the context graph's RDF membership; for the receive-handler
  // log-routing test we just need both addresses to look "allowed",
  // which is exactly what the bootstrap would observe in production
  // after the chain-side join completed.
  internals.getContextGraphAgentGateAddresses = async () => [
    senderWallet.address,
    recipient.agentAddress,
  ];
  return { agent, internals, recipient, senderWallet };
}

function captureLoggerSink(): {
  entries: CapturedLog[];
  detach: () => void;
} {
  const entries: CapturedLog[] = [];
  Logger.setSink((entry) => entries.push({ level: entry.level, message: entry.message }));
  return {
    entries,
    detach: () => Logger.setSink(null),
  };
}

describe('StaleSenderKeyTargetError (typed error class)', () => {
  // Pinning the message format so any operator alerting that grepped
  // the legacy WARN string (`No local X25519 private key for DKG agent
  // <addr> key <keyId>`) keeps matching after the demotion. If you
  // intentionally restructure this string, update operator playbooks
  // that rely on it before flipping this expectation.
  it('preserves the legacy human-readable message format', () => {
    const err = new StaleSenderKeyTargetError(
      '0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E',
      'did:dkg:agent:0xc541f50f734e01d10daf1bc1aec3891fb3ea372e#x25519-deadbeef',
    );
    expect(err.message).toBe(
      'No local X25519 private key for DKG agent 0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E ' +
        'key did:dkg:agent:0xc541f50f734e01d10daf1bc1aec3891fb3ea372e#x25519-deadbeef',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StaleSenderKeyTargetError');
    expect(err.code).toBe('StaleSenderKeyTarget');
    expect(err.recipientAgentAddress).toBe('0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E');
    expect(err.recipientKeyId).toBe(
      'did:dkg:agent:0xc541f50f734e01d10daf1bc1aec3891fb3ea372e#x25519-deadbeef',
    );
  });
});

describe('acceptSwmSenderKeyPackage: stale-target throw type', () => {
  // Verifies the THROW side of the contract: when the targeted
  // `recipientKeyId` isn't an active local key, `acceptSwmSenderKey
  // Package` throws `StaleSenderKeyTargetError` (not generic `Error`).
  // This anchors the type so the receive handler can rely on
  // `instanceof StaleSenderKeyTargetError` for log routing.

  it('throws StaleSenderKeyTargetError for a fingerprint we do not host', async () => {
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const stalePkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId:
        `did:dkg:agent:${recipient.agentAddress.toLowerCase()}#x25519-deadbeefdeadbeefdeadbeefdeadbeef`,
    });

    await expect(
      internals.acceptSwmSenderKeyPackage(stalePkg, FROM_PEER_ID, {
        operationId: 'test-op',
        operationName: 'share',
      }),
    ).rejects.toBeInstanceOf(StaleSenderKeyTargetError);
  });

  it('does NOT throw StaleSenderKeyTargetError for an active key (decrypt failure path)', async () => {
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    // Use the recipient's actual active key id, but keep the random
    // ephemeral recipient pubkey from `buildSignedPackage` — that
    // mismatch will fail inside `decryptSwmSenderKeyPackage` AFTER
    // the localKey lookup succeeds. The point: a generic `Error`
    // surfaces, not `StaleSenderKeyTargetError`, so the receive
    // handler keeps WARN-routing real protocol failures.
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });

    const accept = internals.acceptSwmSenderKeyPackage(pkg, FROM_PEER_ID, {
      operationId: 'test-op',
      operationName: 'share',
    });
    await expect(accept).rejects.toBeInstanceOf(Error);
    await expect(accept).rejects.not.toBeInstanceOf(StaleSenderKeyTargetError);
  });

  it('does NOT throw StaleSenderKeyTargetError when the active key exists but local private material is missing', async () => {
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    delete recipient.workspaceEncryptionKeys[0].privateEncryptionKey;
    delete recipient.privateEncryptionKey;
    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });

    const accept = internals.acceptSwmSenderKeyPackage(pkg, FROM_PEER_ID, {
      operationId: 'test-op',
      operationName: 'share',
    });
    await expect(accept).rejects.toThrow(
      `No local X25519 private key for DKG agent ${recipient.agentAddress} key ${activeKeyId}`,
    );
    await expect(accept).rejects.not.toBeInstanceOf(StaleSenderKeyTargetError);
  });

  it('does NOT misclassify a revoked-key target as stale when localAgents is keyed under a different case', async () => {
    // Codex round 2 regression on PR #654: `hasLocalAgent` does a
    // case-insensitive scan over `localAgents.values()`, but the
    // inner record lookup in the `!localKey` diagnostic branch was
    // doing exact-string `Map.get(checksum)`. If the keystore is
    // keyed under a different case than the record's own
    // `agentAddress` field (legacy persisted state, older fixtures,
    // any path that lowercases on save while keeping EIP-55 on the
    // record itself), `record` becomes `undefined`, the
    // active/revoked discriminators silently fail, and the bootstrap
    // falls through to `StaleSenderKeyTargetError` — demoting a real
    // revoked-key targeting to DEBUG. Pin the case-insensitive scan.
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    recipient.workspaceEncryptionKeys[0].revokedAt = new Date().toISOString();
    internals.localAgents.delete(recipient.agentAddress);
    internals.localAgents.set(recipient.agentAddress.toLowerCase(), recipient);

    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });
    const accept = internals.acceptSwmSenderKeyPackage(pkg, FROM_PEER_ID, {
      operationId: 'test-op',
      operationName: 'share',
    });
    await expect(accept).rejects.toThrow(/was revoked at/);
    await expect(accept).rejects.not.toBeInstanceOf(StaleSenderKeyTargetError);
  });
});

describe('handleSwmSenderKeyPackage: log-level routing', () => {
  // The OPERATOR-FACING half: with the typed error wired, the receive
  // handler must dispatch DEBUG for the stale case and WARN for
  // anything else. We assert on the Logger sink (see
  // packages/core/src/logger.ts — `debug()` is sink-only and never
  // reaches stdout/stderr; `warn()` writes both). This is what
  // demotes the line from `daemon.log` while keeping it
  // troubleshootable via the dashboard DB sink at debug level.

  let detachSink: (() => void) | null = null;
  afterEach(() => {
    detachSink?.();
    detachSink = null;
  });

  it('routes a stale-key rejection to DEBUG (no WARN entry in the sink)', async () => {
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const stalePkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId:
        `did:dkg:agent:${recipient.agentAddress.toLowerCase()}#x25519-cafef00dcafef00dcafef00dcafef00d`,
    });
    const bytes = encodeSwmSenderKeyPackage(stalePkg);

    const sink = captureLoggerSink();
    detachSink = sink.detach;
    await internals.handleSwmSenderKeyPackage(bytes, FROM_PEER_ID);

    const rejectEntries = sink.entries.filter((e) =>
      e.message.startsWith('SWM sender-key setup receive rejected'),
    );
    expect(rejectEntries).toHaveLength(1);
    expect(rejectEntries[0].level).toBe('debug');
    expect(rejectEntries[0].message).toContain(
      `reason=No local X25519 private key for DKG agent ${recipient.agentAddress}`,
    );

    const warnRejects = sink.entries.filter(
      (e) => e.level === 'warn' && e.message.includes('SWM sender-key setup receive rejected'),
    );
    expect(warnRejects).toEqual([]);
  });

  it('routes a non-stale failure (recipient not local) to WARN', async () => {
    // Same setup, but we drop the recipient from `localAgents` AFTER
    // the agent-gate stub still allows it. That makes
    // `hasLocalAgent(recipientAgentAddress)` return false and
    // `acceptSwmSenderKeyPackage` throws a plain `Error` ("Recipient
    // agent <addr> is not local to this node") — which must stay at
    // WARN so operators see real misconfigurations.
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });
    const bytes = encodeSwmSenderKeyPackage(pkg);
    internals.localAgents.delete(recipient.agentAddress);

    const sink = captureLoggerSink();
    detachSink = sink.detach;
    await internals.handleSwmSenderKeyPackage(bytes, FROM_PEER_ID);

    const rejectEntries = sink.entries.filter((e) =>
      e.message.startsWith('SWM sender-key setup receive rejected'),
    );
    expect(rejectEntries).toHaveLength(1);
    expect(rejectEntries[0].level).toBe('warn');
    expect(rejectEntries[0].message).toContain('is not local to this node');
  });

  it('routes a missing local private key for a known active fingerprint to WARN', async () => {
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    delete recipient.workspaceEncryptionKeys[0].privateEncryptionKey;
    delete recipient.privateEncryptionKey;
    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });
    const bytes = encodeSwmSenderKeyPackage(pkg);

    const sink = captureLoggerSink();
    detachSink = sink.detach;
    await internals.handleSwmSenderKeyPackage(bytes, FROM_PEER_ID);

    const rejectEntries = sink.entries.filter((e) =>
      e.message.startsWith('SWM sender-key setup receive rejected'),
    );
    expect(rejectEntries).toHaveLength(1);
    expect(rejectEntries[0].level).toBe('warn');
    expect(rejectEntries[0].message).toContain(
      `reason=No local X25519 private key for DKG agent ${recipient.agentAddress} key ${activeKeyId}`,
    );
  });

  it('routes a revoked-key target to WARN even when localAgents is keyed under a different case', async () => {
    // Operator-facing pin for Codex round 2: same case-mismatch as
    // the accept-path regression above, but verified end-to-end
    // through `handleSwmSenderKeyPackage` so a future refactor that
    // re-introduces the exact-key Map.get() trips both halves.
    const { internals, recipient, senderWallet } = await bootAgentForStaleTargetTest();
    const activeKeyId = recipient.workspaceEncryptionKeys[0].encryptionKeyId;
    recipient.workspaceEncryptionKeys[0].revokedAt = new Date().toISOString();
    internals.localAgents.delete(recipient.agentAddress);
    internals.localAgents.set(recipient.agentAddress.toLowerCase(), recipient);

    const pkg = await buildSignedPackage({
      senderWallet,
      recipientAgentAddress: recipient.agentAddress,
      recipientKeyId: activeKeyId,
    });
    const bytes = encodeSwmSenderKeyPackage(pkg);

    const sink = captureLoggerSink();
    detachSink = sink.detach;
    await internals.handleSwmSenderKeyPackage(bytes, FROM_PEER_ID);

    const rejectEntries = sink.entries.filter((e) =>
      e.message.startsWith('SWM sender-key setup receive rejected'),
    );
    expect(rejectEntries).toHaveLength(1);
    expect(rejectEntries[0].level).toBe('warn');
    expect(rejectEntries[0].message).toContain('was revoked at');
  });
});
