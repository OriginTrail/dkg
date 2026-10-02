import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
  toAgentDid,
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import {
  isWorkspaceAgentEncryptionKeyMissingError,
  projectWorkspaceAgentRecipientFanout,
  resolveWorkspaceAgentRecipients,
  WorkspaceAgentEncryptionKeyMissingError,
  type WorkspaceAgentRecipient,
  type WorkspaceAgentRecipientResolution,
} from '../src/index.js';

const CONTEXT_GRAPH_ID = 'workspace-agent-recipient-resolution';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const AGENTS_GRAPH = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const DKG = 'https://dkg.network/ontology#';
const DKG_PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const DKG_ENCRYPTION_KEY_ALGORITHM = `${DKG}encryptionKeyAlgorithm`;
const DKG_ENCRYPTION_KEY_PROOF = `${DKG}encryptionKeyProof`;
const PEER_A = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const PEER_B = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PROJECTION_AGENTS = Array.from(
  { length: 6 },
  (_unused, index) => ethers.getAddress(`0x${String(index + 1).padStart(40, '0')}`),
);

function agentUri(address: string): string {
  return `did:dkg:agent:${ethers.getAddress(address)}`;
}

function recipientFixture(agentAddress: string, peerId?: string): WorkspaceAgentRecipient {
  return {
    ...generateWorkspaceRecipientEncryptionKey(
      agentUri(agentAddress),
      `${agentUri(agentAddress)}#projection-x25519`,
    ),
    agentAddress,
    peerId,
  };
}

function inspectResolutionArm(resolution: WorkspaceAgentRecipientResolution): string | number {
  if (resolution.requiresEncryption) {
    const firstRecipient: WorkspaceAgentRecipient = resolution.recipients[0];
    return firstRecipient.agentAddress;
  }
  const noRecipients: readonly [] = resolution.recipients;
  return noRecipients.length;
}

async function insertAgentGate(
  store: OxigraphStore,
  predicate: string,
  address: string,
): Promise<void> {
  await store.insert([{
    subject: DATA_GRAPH,
    predicate,
    object: `"${address}"`,
    graph: META_GRAPH,
  }]);
}

async function insertPrivatePeerGate(store: OxigraphStore): Promise<void> {
  await store.insert([
    {
      subject: DATA_GRAPH,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"private"',
      graph: META_GRAPH,
    },
    {
      subject: DATA_GRAPH,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: '"12D3KooWPeerOnlyRecipient"',
      graph: META_GRAPH,
    },
  ]);
}

async function insertAgentEncryptionKey(
  store: OxigraphStore,
  wallet: ethers.Wallet,
  options: {
    algorithm?: string;
    proofWallet?: ethers.Wallet;
    omitAlgorithm?: boolean;
    omitProof?: boolean;
    keyFill?: number;
    subject?: string;
    graph?: string;
    peerId?: string;
  } = {},
): Promise<{ publicKeyBytes: Uint8Array; keyId: string }> {
  const recipientKey = generateWorkspaceRecipientEncryptionKey(
    agentUri(wallet.address),
    `${agentUri(wallet.address)}#test-x25519`,
    options.keyFill === undefined
      ? undefined
      : (length) => new Uint8Array(length).fill(options.keyFill),
  );
  const publicKeyBytes = recipientKey.publicKeyBytes!;
  const publicEncryptionKey = encodeWorkspaceEncryptionKey(publicKeyBytes);
  const proofSigner = options.proofWallet ?? wallet;
  const proofPayload = computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  });
  const proof = proofSigner.signingKey.sign(ethers.hashMessage(proofPayload)).serialized;
  const subject = options.subject ?? agentUri(wallet.address);
  const graph = options.graph ?? 'did:dkg:system/agents';
  const quads = [{
    subject,
    predicate: DKG_PUBLIC_ENCRYPTION_KEY,
    object: `"${publicEncryptionKey}"`,
    graph,
  }];
  if (!options.omitAlgorithm) {
    quads.push({
      subject,
      predicate: DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${options.algorithm ?? WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph,
    });
  }
  if (!options.omitProof) {
    quads.push({
      subject,
      predicate: DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph,
    });
  }
  if (options.peerId !== undefined) {
    quads.push({
      subject,
      predicate: `${DKG}peerId`,
      object: `"${options.peerId}"`,
      graph,
    });
  }
  await store.insert(quads);
  return {
    publicKeyBytes,
    keyId: workspaceAgentEncryptionKeyId(ethers.getAddress(wallet.address), publicKeyBytes),
  };
}

async function insertAgentEncryptionKeyRevocation(
  store: OxigraphStore,
  wallet: ethers.Wallet,
  publicKeyBytes: Uint8Array,
  options: {
    revokedAt?: string;
    proofWallet?: ethers.Wallet;
    omitProof?: boolean;
    tamperProof?: boolean;
  } = {},
): Promise<void> {
  const checksum = ethers.getAddress(wallet.address);
  const keyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
  const revokedAt = options.revokedAt ?? new Date().toISOString();
  const proofSigner = options.proofWallet ?? wallet;
  const payload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
    agentAddress: checksum,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
    revokedAt,
  });
  let proof = proofSigner.signingKey.sign(ethers.hashMessage(payload)).serialized;
  if (options.tamperProof) {
    // flip the last byte so it still parses but recovers a different address
    const buf = Buffer.from(proof.slice(2), 'hex');
    buf[buf.length - 2] ^= 0xff;
    proof = `0x${buf.toString('hex')}`;
  }
  const quads = [
    {
      subject: keyId,
      predicate: DKG_ONTOLOGY.DKG_REVOKED_AT,
      object: `"${revokedAt}"`,
      graph: 'did:dkg:system/agents',
    },
    {
      subject: keyId,
      predicate: DKG_ONTOLOGY.DKG_REVOKED_BY,
      object: agentUri(wallet.address),
      graph: 'did:dkg:system/agents',
    },
  ];
  if (!options.omitProof) {
    quads.push({
      subject: keyId,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
      object: `"${proof}"`,
      graph: 'did:dkg:system/agents',
    });
  }
  await store.insert(quads);
}

describe('projectWorkspaceAgentRecipientFanout', () => {
  it('projects the validated snapshot once, trimming, deduping, and excluding self', () => {
    const resolution = {
      requiresEncryption: true,
      recipients: [
        recipientFixture(PROJECTION_AGENTS[0]!, ` ${PEER_A} `),
        recipientFixture(PROJECTION_AGENTS[1]!, PEER_A),
        recipientFixture(PROJECTION_AGENTS[2]!, SELF_PEER),
        recipientFixture(PROJECTION_AGENTS[3]!, '  '),
        recipientFixture(PROJECTION_AGENTS[4]!),
        recipientFixture(PROJECTION_AGENTS[5]!, PEER_B),
      ],
    } satisfies WorkspaceAgentRecipientResolution;

    expect(projectWorkspaceAgentRecipientFanout(resolution, SELF_PEER)).toEqual({
      source: 'agent-roster',
      members: [PEER_A, PEER_B],
      complete: false,
    });
  });

  it('narrows both valid resolution arms without a refinement helper', () => {
    const encrypted = {
      requiresEncryption: true,
      recipients: [recipientFixture(PROJECTION_AGENTS[0]!, PEER_A)],
    } satisfies WorkspaceAgentRecipientResolution;
    const plaintext = {
      requiresEncryption: false,
      recipients: [],
    } satisfies WorkspaceAgentRecipientResolution;

    expect(inspectResolutionArm(encrypted)).toBe(PROJECTION_AGENTS[0]);
    expect(inspectResolutionArm(plaintext)).toBe(0);
  });

  it('marks a mixed authorized roster incomplete while retaining known peers', () => {
    const resolution = {
      requiresEncryption: true,
      recipients: [
        recipientFixture(PROJECTION_AGENTS[0]!, PEER_A),
        recipientFixture(PROJECTION_AGENTS[1]!),
      ],
    } satisfies WorkspaceAgentRecipientResolution;

    expect(projectWorkspaceAgentRecipientFanout(resolution, SELF_PEER)).toEqual({
      source: 'agent-roster',
      members: [PEER_A],
      complete: false,
    });
  });

  it('counts the local agent as covered without adding self to remote peers', () => {
    const resolution = {
      requiresEncryption: true,
      recipients: [
        recipientFixture(PROJECTION_AGENTS[0]!, SELF_PEER),
        recipientFixture(PROJECTION_AGENTS[1]!, PEER_B),
      ],
    } satisfies WorkspaceAgentRecipientResolution;

    expect(projectWorkspaceAgentRecipientFanout(resolution, SELF_PEER)).toEqual({
      source: 'agent-roster',
      members: [PEER_B],
      complete: true,
    });
  });

  it('rejects malformed profile peer IDs and keeps the fallback-required projection incomplete', () => {
    const resolution = {
      requiresEncryption: true,
      recipients: [
        recipientFixture(PROJECTION_AGENTS[0]!, PEER_A),
        recipientFixture(PROJECTION_AGENTS[1]!, 'not-a-peer-id'),
      ],
    } satisfies WorkspaceAgentRecipientResolution;

    expect(projectWorkspaceAgentRecipientFanout(resolution, SELF_PEER)).toEqual({
      source: 'agent-roster',
      members: [PEER_A],
      complete: false,
    });
  });
});

describe('resolveWorkspaceAgentRecipients', () => {
  it.each([
    ['DKG_ALLOWED_AGENT', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
    ['DKG_PARTICIPANT_AGENT', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
  ])('resolves verified X25519 DKG agent keys for %s', async (_label, predicate) => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, predicate, wallet.address);
    await insertAgentEncryptionKey(store, wallet);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientId).toBe(agentUri(wallet.address));
    expect(resolution.recipients[0]?.encryptionKeyAlgorithm).toBe(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519);
  });

  it('resolves a key registered only under the canonical lowercase agent DID', async () => {
    const store = new OxigraphStore();
    const wallet = new ethers.Wallet(`0x${'0'.repeat(63)}1`);
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const key = await insertAgentEncryptionKey(store, wallet, {
      subject: toAgentDid(wallet.address),
    });

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(key.keyId);
  });

  it('deduplicates one verified key stored under canonical and historical DID aliases', async () => {
    const store = new OxigraphStore();
    const wallet = new ethers.Wallet(`0x${'0'.repeat(63)}1`);
    expect(agentUri(wallet.address)).not.toBe(toAgentDid(wallet.address));
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const historical = await insertAgentEncryptionKey(store, wallet, { keyFill: 8 });
    const canonical = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 8,
      subject: toAgentDid(wallet.address),
    });
    expect(canonical.keyId).toBe(historical.keyId);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(historical.keyId);
  });

  it('prefers a peer-bound copy over a peerless copy of the same verified key', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const peerless = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 9,
      graph: 'did:dkg:profile/peerless',
    });
    const peerBound = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 9,
      graph: 'did:dkg:profile/peer-a',
      peerId: PEER_A,
    });
    expect(peerBound.keyId).toBe(peerless.keyId);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]).toMatchObject({
      recipientKeyId: peerless.keyId,
      peerId: PEER_A,
    });
  });

  it('preserves distinct peer-bound variants of the same verified key', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const first = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 10,
      graph: 'did:dkg:profile/peer-a',
      peerId: PEER_A,
    });
    const second = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 10,
      graph: 'did:dkg:profile/peer-b',
      peerId: PEER_B,
    });
    expect(second.keyId).toBe(first.keyId);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(2);
    expect(new Set(resolution.recipients.map((recipient) => recipient.recipientKeyId)))
      .toEqual(new Set([first.keyId]));
    expect(new Set(resolution.recipients.map((recipient) => recipient.peerId)))
      .toEqual(new Set([PEER_A, PEER_B]));
    expect(resolution.recipients.filter((recipient) => recipient.peerId === PEER_B))
      .toHaveLength(1);
  });

  it('bounds peer-route variants of one wallet-verified key', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await Promise.all(Array.from({ length: 64 }, async (_unused, index) => (
      insertAgentEncryptionKey(store, wallet, {
        keyFill: 13,
        graph: `did:dkg:profile/peer-route-${index}`,
        peerId: `peer-route-${index}`,
      })
    )));

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .resolves.toMatchObject({ requiresEncryption: true, recipients: { length: 64 } });

    await insertAgentEncryptionKey(store, wallet, {
      keyFill: 13,
      graph: 'did:dkg:profile/peer-route-64',
      peerId: 'peer-route-64',
    });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Too many public encryption-key candidates/u);
  });

  it('bounds proof candidates independently from key-route variants', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await insertAgentEncryptionKey(store, wallet);
    await store.insert(Array.from({ length: 64 }, (_unused, index) => ({
      subject: agentUri(wallet.address),
      predicate: DKG_ENCRYPTION_KEY_PROOF,
      object: `"untrusted-proof-${index}"`,
      graph: 'did:dkg:system/agents',
    })));

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Too many public encryption-key proof candidates/u);
  });

  it('resolves AGENTS-graph private declarations through the sender-key recipient path', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await store.insert([
      {
        subject: DATA_GRAPH,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: AGENTS_GRAPH,
      },
      {
        subject: DATA_GRAPH,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${wallet.address}"`,
        graph: AGENTS_GRAPH,
      },
    ]);
    await insertAgentEncryptionKey(store, wallet);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.agentAddress).toBe(ethers.getAddress(wallet.address));
  });

  it('preserves peer-only non-private graphs as legacy plaintext-compatible SWM', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: '"12D3KooWPeerOnlyRecipient"',
      graph: META_GRAPH,
    }]);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.requiresEncryption).toBe(false);
    expect(resolution.recipients).toHaveLength(0);
  });

  it('fails closed when a private peer allowlist has no DKG agent recipients', async () => {
    const store = new OxigraphStore();
    await insertPrivatePeerGate(store);

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/declares no DKG_ALLOWED_AGENT or DKG_PARTICIPANT_AGENT recipients/);
  });

  it('rejects missing recipient public encryption keys', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Missing public encryption key/);
  });

  it('reports a missing recipient key as a typed error naming the agent (#2849)', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);

    const error = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceAgentEncryptionKeyMissingError);
    expect(isWorkspaceAgentEncryptionKeyMissingError(error)).toBe(true);
    expect((error as WorkspaceAgentEncryptionKeyMissingError).agentAddress)
      .toBe(ethers.getAddress(wallet.address));
    expect((error as WorkspaceAgentEncryptionKeyMissingError).agentAddresses)
      .toEqual([ethers.getAddress(wallet.address)]);
    expect((error as Error).message)
      .toBe(`Missing public encryption key for DKG agent ${ethers.getAddress(wallet.address)}`);
    // Recognised across module copies by name and fields, not by class identity.
    const copy = Object.assign(new Error('copy'), {
      name: 'WorkspaceAgentEncryptionKeyMissingError',
      agentAddress: wallet.address,
      agentAddresses: [wallet.address],
    });
    expect(isWorkspaceAgentEncryptionKeyMissingError(copy)).toBe(true);
    expect(isWorkspaceAgentEncryptionKeyMissingError(Object.assign(new Error('copy'), {
      name: 'WorkspaceAgentEncryptionKeyMissingError',
      agentAddress: wallet.address,
    }))).toBe(false);
    expect(isWorkspaceAgentEncryptionKeyMissingError(new Error('Missing public encryption key')))
      .toBe(false);
    expect(() => new WorkspaceAgentEncryptionKeyMissingError([])).toThrow(TypeError);
  });

  it('names every recipient without a key in one typed error (#2849)', async () => {
    const store = new OxigraphStore();
    const first = ethers.Wallet.createRandom();
    const keyed = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    for (const wallet of [first, keyed, second]) {
      await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    }
    await insertAgentEncryptionKey(store, keyed);

    const error = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID })
      .then(() => null, (thrown: unknown) => thrown);

    expect(isWorkspaceAgentEncryptionKeyMissingError(error)).toBe(true);
    const missing = [first, second].map((wallet) => ethers.getAddress(wallet.address));
    expect([...(error as WorkspaceAgentEncryptionKeyMissingError).agentAddresses].sort())
      .toEqual([...missing].sort());
    expect((error as Error).message).toContain('Missing public encryption key for DKG agent ');
    expect((error as Error).message).toContain('also missing for ');
  });

  it('still stops at a key that fails for another reason while collecting missing keys', async () => {
    const store = new OxigraphStore();
    const missing = ethers.Wallet.createRandom();
    const spoofed = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, missing.address);
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, spoofed.address);
    await insertAgentEncryptionKey(store, spoofed, { proofWallet: ethers.Wallet.createRandom() });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Spoofed or unverifiable public encryption key/);
  });

  it('rejects untrusted RDF-only keys without algorithm or proof', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await insertAgentEncryptionKey(store, wallet, { omitAlgorithm: true, omitProof: true });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Untrusted RDF-only public encryption key/);
  });

  it('rejects wrong-algorithm keys', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await insertAgentEncryptionKey(store, wallet, { algorithm: 'P-256' });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Unsupported public encryption key algorithm/);
  });

  it('rejects spoofed or unverifiable key proofs', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await insertAgentEncryptionKey(store, wallet, { proofWallet: ethers.Wallet.createRandom() });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Spoofed or unverifiable public encryption key/);
  });

  it('accepts every verified recipient key for an agent with multiple registered keys', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const k1 = await insertAgentEncryptionKey(store, wallet, { keyFill: 1 });
    const k2 = await insertAgentEncryptionKey(store, wallet, { keyFill: 2 });

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients).toHaveLength(2);
    const ids = resolution.recipients.map((r) => r.recipientKeyId).sort();
    expect(ids).toEqual([k1.keyId, k2.keyId].sort());
    for (const recipient of resolution.recipients) {
      expect(recipient.agentAddress).toBe(ethers.getAddress(wallet.address));
      expect(recipient.encryptionKeyAlgorithm).toBe(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519);
    }
  });

  it('resolves the surviving key after 64 retire-old rotations', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const keys = [];
    for (let index = 0; index < 65; index += 1) {
      keys.push(await insertAgentEncryptionKey(store, wallet, { keyFill: index + 1 }));
    }
    for (const retired of keys.slice(0, -1)) {
      await insertAgentEncryptionKeyRevocation(store, wallet, retired.publicKeyBytes);
    }

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(keys.at(-1)?.keyId);
  });

  it('does not grant history budget to 64 bare revocation markers', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const keys = [];
    for (let index = 0; index < 65; index += 1) {
      keys.push(await insertAgentEncryptionKey(store, wallet, { keyFill: index + 1 }));
    }
    for (const untrustedRetirement of keys.slice(0, -1)) {
      await insertAgentEncryptionKeyRevocation(
        store,
        wallet,
        untrustedRetirement.publicKeyBytes,
        { omitProof: true },
      );
    }

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Too many public encryption-key candidates/u);
  });

  it('does not amplify one authenticated retirement through non-canonical key aliases', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const retired = await insertAgentEncryptionKey(store, wallet, { keyFill: 70 });
    await insertAgentEncryptionKeyRevocation(store, wallet, retired.publicKeyBytes);
    await insertAgentEncryptionKey(store, wallet, { keyFill: 71 });
    const canonical = encodeWorkspaceEncryptionKey(retired.publicKeyBytes);
    await store.insert(Array.from({ length: 65 }, (_unused, index) => ({
      subject: agentUri(wallet.address),
      predicate: DKG_PUBLIC_ENCRYPTION_KEY,
      object: `"${canonical}${'!'.repeat(index + 1)}"`,
      graph: 'did:dkg:attacker-controlled-copy',
    })));

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Too many public encryption-key candidates/u);
  });

  it('ignores a malformed candidate when a verified active key also exists', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const valid = await insertAgentEncryptionKey(store, wallet);
    await store.insert([{
      subject: agentUri(wallet.address),
      predicate: DKG_PUBLIC_ENCRYPTION_KEY,
      object: '"not-a-valid-x25519-key"',
      graph: 'did:dkg:attacker-controlled-copy',
    }]);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(valid.keyId);
  });

  it('filters out keys with a verified wallet-signed revocation', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const retired = await insertAgentEncryptionKey(store, wallet, { keyFill: 1 });
    const active = await insertAgentEncryptionKey(store, wallet, { keyFill: 2 });
    await insertAgentEncryptionKeyRevocation(store, wallet, retired.publicKeyBytes);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(active.keyId);
  });

  it('removes every peer-bound variant when their shared key ID is revoked', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const retired = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 11,
      graph: 'did:dkg:profile/retired-peer-a',
      peerId: PEER_A,
    });
    const retiredVariant = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 11,
      graph: 'did:dkg:profile/retired-peer-b',
      peerId: PEER_B,
    });
    const active = await insertAgentEncryptionKey(store, wallet, {
      keyFill: 12,
      graph: 'did:dkg:profile/active-peer-a',
      peerId: PEER_A,
    });
    expect(retiredVariant.keyId).toBe(retired.keyId);
    await insertAgentEncryptionKeyRevocation(store, wallet, retired.publicKeyBytes);

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]).toMatchObject({
      recipientKeyId: active.keyId,
      peerId: PEER_A,
    });
  });

  it('ignores revocations whose proof was signed by another wallet (no bricking)', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const k = await insertAgentEncryptionKey(store, wallet, { keyFill: 3 });
    await insertAgentEncryptionKeyRevocation(store, wallet, k.publicKeyBytes, {
      proofWallet: ethers.Wallet.createRandom(),
    });

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
    expect(resolution.recipients[0]?.recipientKeyId).toBe(k.keyId);
  });

  it('ignores revocations whose proof was tampered with after signing', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const k = await insertAgentEncryptionKey(store, wallet, { keyFill: 4 });
    await insertAgentEncryptionKeyRevocation(store, wallet, k.publicKeyBytes, {
      tamperProof: true,
    });

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
  });

  it('ignores revocation triples missing the encryptionKeyRevocationProof', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const k = await insertAgentEncryptionKey(store, wallet, { keyFill: 5 });
    await insertAgentEncryptionKeyRevocation(store, wallet, k.publicKeyBytes, {
      omitProof: true,
    });

    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.recipients).toHaveLength(1);
  });

  it('fails when every registered key for an agent has been revoked', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    const k1 = await insertAgentEncryptionKey(store, wallet, { keyFill: 6 });
    const k2 = await insertAgentEncryptionKey(store, wallet, { keyFill: 7 });
    await insertAgentEncryptionKeyRevocation(store, wallet, k1.publicKeyBytes);
    await insertAgentEncryptionKeyRevocation(store, wallet, k2.publicKeyBytes);

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/have been revoked/);
  });
});
