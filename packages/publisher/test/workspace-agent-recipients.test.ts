import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipients } from '../src/index.js';

const CONTEXT_GRAPH_ID = 'workspace-agent-recipient-resolution';
const DATA_GRAPH = contextGraphDataUri(CONTEXT_GRAPH_ID);
const META_GRAPH = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const DKG = 'https://dkg.network/ontology#';
const DKG_PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const DKG_ENCRYPTION_KEY_ALGORITHM = `${DKG}encryptionKeyAlgorithm`;
const DKG_ENCRYPTION_KEY_PROOF = `${DKG}encryptionKeyProof`;

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
): Promise<void> {
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
}

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

  it('rejects ambiguous verified recipient keys', async () => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address);
    await insertAgentEncryptionKey(store, wallet, { keyFill: 1 });
    await insertAgentEncryptionKey(store, wallet, { keyFill: 2 });

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/Ambiguous public encryption keys/);
  });
});
