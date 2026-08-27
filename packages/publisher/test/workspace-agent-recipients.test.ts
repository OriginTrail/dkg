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
  workspaceAgentEncryptionKeyId,
} from '@origintrail-official/dkg-core';
import {
  projectWorkspaceAgentRecipientFanout,
  resolveWorkspaceAgentRecipients,
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

function agentUri(address: string): string {
  return `did:dkg:agent:${ethers.getAddress(address)}`;
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
  const quads = [{
    subject: agentUri(wallet.address),
    predicate: DKG_PUBLIC_ENCRYPTION_KEY,
    object: `"${publicEncryptionKey}"`,
    graph: 'did:dkg:system/agents',
  }];
  if (!options.omitAlgorithm) {
    quads.push({
      subject: agentUri(wallet.address),
      predicate: DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${options.algorithm ?? WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph: 'did:dkg:system/agents',
    });
  }
  if (!options.omitProof) {
    quads.push({
      subject: agentUri(wallet.address),
      predicate: DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph: 'did:dkg:system/agents',
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
        { peerId: ` ${PEER_A} ` },
        { peerId: PEER_A },
        { peerId: SELF_PEER },
        { peerId: '  ' },
        {},
        { peerId: PEER_B },
      ],
    } as unknown as WorkspaceAgentRecipientResolution;

    expect(projectWorkspaceAgentRecipientFanout(resolution, SELF_PEER)).toEqual({
      source: 'agent-roster',
      members: [PEER_A, PEER_B],
      complete: false,
    });
  });

  it('returns null for a plaintext recipient resolution', () => {
    expect(projectWorkspaceAgentRecipientFanout({
      requiresEncryption: false,
      recipients: [],
    })).toBeNull();
  });

  it('marks a mixed authorized roster incomplete while retaining known peers', () => {
    const resolution = {
      requiresEncryption: true,
      recipients: [
        { agentAddress: '0xaaa', peerId: PEER_A },
        { agentAddress: '0xbbb' },
      ],
    } as unknown as WorkspaceAgentRecipientResolution;

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
        { agentAddress: '0xaaa', peerId: SELF_PEER },
        { agentAddress: '0xbbb', peerId: PEER_B },
      ],
    } as unknown as WorkspaceAgentRecipientResolution;

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
        { agentAddress: '0xaaa', peerId: PEER_A },
        { agentAddress: '0xbbb', peerId: 'not-a-peer-id' },
      ],
    } as unknown as WorkspaceAgentRecipientResolution;

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
