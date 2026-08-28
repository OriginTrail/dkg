import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  decodeWorkspacePublishRequest,
  decodeEncryptedWorkspacePayload,
  encodeGossipEnvelope,
  encodeEncryptedWorkspacePayload,
  encryptWorkspacePayload,
  generateWorkspaceRecipientEncryptionKey,
  computeGossipSigningPayload,
  DKG_GOSSIP_MAX_MESSAGE_BYTES,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  STORAGE_ACK_MAX_STAGING_BYTES,
  type WorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  SharedMemoryHandler,
  StaleWriteError,
  resolveKnowledgeAssetWorkspaceHead,
  resolvePublishedKnowledgeAssetWorkspaceHead,
  type ShareOptions,
  type ConditionalShareOptions,
} from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, seedContextGraphRegistration, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { wrapPublisherForTest, buildSeal } from './_helpers/seal.js';
import { makeHardhatReceiverACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';
import {
  encodeRootlessWorkspaceRequest,
  rootlessSharedMemoryGraphFromWire,
} from './_helpers/rootless-workspace.js';
import type { V10ACKProvider, V10ACKProviderParams } from '../src/publisher.js';

// RC11 / PR1: in-memory 3-of-N ACK provider that signs the V10 ACK
// digest with the staked Hardhat receiver wallets (REC1..REC3). Replaces
// the deleted self-signed ACK fallback so every Hardhat publish below
// goes through the real ACK quorum code path.
let _ackProvider: V10ACKProvider | undefined;
function getAckProvider(): V10ACKProvider {
  if (!_ackProvider) {
    if (!_kav10Address) {
      throw new Error('getAckProvider() called before _kav10Address was initialized in beforeAll');
    }
    _ackProvider = makeHardhatReceiverACKProvider(
      getSharedContext(),
      _kav10Address,
      [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
    );
  }
  return _ackProvider;
}

let CONTEXT_GRAPH = 'test-workspace';
let DATA_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
let WORKSPACE_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
let WORKSPACE_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
const ENTITY = 'urn:test:entity:1';
const SNAPSHOT_PEER_A = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const SNAPSHOT_PEER_B = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SNAPSHOT_SELF_PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const SNAPSHOT_PEER_C = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
let _kav10Address: string;
let _provider: ethers.JsonRpcProvider;
const _author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

async function sealForQuads(quads: Quad[], contextGraphId: string | bigint) {
  return buildSeal({
    quads,
    author: _author,
    contextGraphId,
    ctx: { provider: _provider, kav10Address: _kav10Address },
  });
}

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const nquadsEncoder = new TextEncoder();

function serializePublicQuad(quad: Quad): string {
  return `<${quad.subject}> <${quad.predicate}> ${
    quad.object.startsWith('"') ? quad.object : `<${quad.object}>`
  } <${quad.graph}> .`;
}

function encodedPublicByteLength(quads: Quad[]): number {
  return nquadsEncoder.encode(quads.map(serializePublicQuad).join('\n')).length;
}

function buildPublicQuadsWithByteSize(targetBytes: number, graph = ''): Quad[] {
  const quads: Quad[] = [];
  const maxSafeLiteralBytes = 50_000;

  for (let i = 0; i < 1_000; i++) {
    const subject = `urn:test:oversized-swm:${i}`;
    const predicate = 'http://schema.org/description';
    const emptyLine = serializePublicQuad({
      subject,
      predicate,
      object: '""',
      graph,
    });
    const currentBytes = encodedPublicByteLength(quads);
    const separatorBytes = quads.length === 0 ? 0 : 1;
    const bytesNeededInsideLiteral =
      targetBytes - currentBytes - separatorBytes - nquadsEncoder.encode(emptyLine).length;
    const literalBytes =
      bytesNeededInsideLiteral >= 0 && bytesNeededInsideLiteral <= maxSafeLiteralBytes
        ? bytesNeededInsideLiteral
        : maxSafeLiteralBytes;

    quads.push({
      subject,
      predicate,
      object: `"${'x'.repeat(literalBytes)}"`,
      graph,
    });

    const size = encodedPublicByteLength(quads);
    if (size >= targetBytes) {
      if (size !== targetBytes) {
        throw new Error(`oversized SWM fixture byte-size drift: expected ${targetBytes}, got ${size}`);
      }
      return quads;
    }
  }

  throw new Error(`failed to build public quads with byte size ${targetBytes}`);
}

async function signWorkspaceMessage(
  wallet: ethers.Wallet,
  contextGraphId: string,
  payload: Uint8Array,
  timestamp = new Date().toISOString(),
): Promise<Uint8Array> {
  const signingPayload = computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    timestamp,
    payload,
  );
  const signature = await wallet.signMessage(signingPayload);
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: wallet.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

function recipientKeyFor(agentAddress: string): WorkspaceRecipientEncryptionKey {
  return generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${agentAddress}`,
    `did:dkg:agent:${agentAddress}#test-x25519`,
  );
}

async function encryptWorkspaceMessage(
  agentAddress: string,
  contextGraphId: string,
  payload: Uint8Array,
  shareOperationId: string,
  timestampMs: number,
  recipientKey: WorkspaceRecipientEncryptionKey,
): Promise<Uint8Array> {
  return encodeEncryptedWorkspacePayload(await encryptWorkspacePayload({
    contextGraphId,
    senderIdentity: `did:dkg:agent:${agentAddress}`,
    operationId: shareOperationId,
    shareOperationId,
    timestampMs,
    plaintext: payload,
    recipients: [recipientKey],
  }));
}

beforeAll(async () => {
  // Public CG (accessPolicy 0): these tests publish PLAINTEXT to exercise
  // workspace/SWM/lifecycle mechanics, not curated/ciphertext semantics, so a
  // curated CG would now revert (#1072 CuratedCGRequiresCiphertextCommitment).
  const cgId = await createTestContextGraph(undefined, undefined, 0);
  CONTEXT_GRAPH = String(cgId);
  DATA_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  WORKSPACE_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
  WORKSPACE_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
  _provider = createProvider();
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  _kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
});

describe('Workspace: share', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
  });
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('stores quads in workspace and workspace_meta, returns encoded message', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
      q(ENTITY, 'http://schema.org/description', '"Workspace draft"'),
    ];
    const opts: ShareOptions = {
      publisherPeerId: '12D3KooWTest',
    };

    const result = await publisher.share(CONTEXT_GRAPH, quads, opts);

    expect(result.shareOperationId).toMatch(/^swm-\d+-[a-z0-9]+$/);
    expect(result.gossipPayload.message).toBeInstanceOf(Uint8Array);
    expect(result.gossipPayload.message.length).toBeGreaterThan(0);
    expect(result.message).toBe(result.gossipPayload.message);

    const workspaceResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(workspaceResult.type).toBe('bindings');
    if (workspaceResult.type === 'bindings') {
      expect(workspaceResult.bindings.length).toBe(1);
      expect(workspaceResult.bindings[0]['o']).toBe('"Test"');
    }

    const metaResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> } }`,
    );
    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(metaResult.bindings.length).toBe(1);
    }
  });

  it('returns isolated encryption-time fan-out snapshots for concurrent shares', async () => {
    const senderAgentAddress = ethers.Wallet.createRandom().address;
    publisher.setWorkspaceAgentRecipientResolver(async ({ contextGraphId }) => ({
      requiresEncryption: true,
      recipients: [{
        ...recipientKeyFor(senderAgentAddress),
        agentAddress: senderAgentAddress,
        peerId: contextGraphId === 'snapshot-a' ? SNAPSHOT_PEER_A : SNAPSHOT_PEER_B,
      }],
    }));
    publisher.setWorkspaceSenderKeyEncryptor(async (input) => {
      expect(input.resolution.recipients[0]?.peerId).toBe(
        input.contextGraphId === 'snapshot-a' ? SNAPSHOT_PEER_A : SNAPSHOT_PEER_B,
      );
      return input.plaintext;
    });

    const [first, second] = await Promise.all([
      publisher.share('snapshot-a', [q('urn:test:snapshot-a', 'http://schema.org/name', '"A"')], {
        publisherPeerId: SNAPSHOT_SELF_PEER,
        senderAgentAddress,
      }),
      publisher.share('snapshot-b', [q('urn:test:snapshot-b', 'http://schema.org/name', '"B"')], {
        publisherPeerId: SNAPSHOT_SELF_PEER,
        senderAgentAddress,
      }),
    ]);

    expect(first.gossipPayload).toEqual({
      message: expect.any(Uint8Array),
      fanout: {
        kind: 'captured',
        snapshot: {
          source: 'agent-roster',
          members: [SNAPSHOT_PEER_A],
          complete: true,
        },
      },
    });
    expect(second.gossipPayload).toEqual({
      message: expect.any(Uint8Array),
      fanout: {
        kind: 'captured',
        snapshot: {
          source: 'agent-roster',
          members: [SNAPSHOT_PEER_B],
          complete: true,
        },
      },
    });
  });

  it('owns resolver recipient records and key bytes before encryption and fan-out', async () => {
    const senderAgentAddress = ethers.Wallet.createRandom().address;
    const resolverKey = recipientKeyFor(senderAgentAddress);
    const resolverPublicKeyBytes = resolverKey.publicKeyBytes;
    if (!resolverPublicKeyBytes) throw new Error('expected recipient public key');
    const originalPublicKeyBytes = Uint8Array.from(resolverPublicKeyBytes);
    const resolverRecipient = {
      ...resolverKey,
      agentAddress: senderAgentAddress,
      peerId: SNAPSHOT_PEER_A,
    };

    publisher.setWorkspaceAgentRecipientResolver(async () => ({
      requiresEncryption: true,
      recipients: [resolverRecipient],
    }));
    publisher.setWorkspaceSenderKeyEncryptor(async (input) => {
      resolverRecipient.peerId = SNAPSHOT_PEER_B;
      resolverPublicKeyBytes.fill(0);

      const capturedRecipient = input.resolution.recipients[0];
      expect(capturedRecipient).not.toBe(resolverRecipient);
      expect(capturedRecipient.peerId).toBe(SNAPSHOT_PEER_A);
      expect(capturedRecipient.publicKeyBytes).not.toBe(resolverPublicKeyBytes);
      expect(capturedRecipient.publicKeyBytes).toEqual(originalPublicKeyBytes);
      expect(Object.isFrozen(input.resolution)).toBe(true);
      expect(Object.isFrozen(input.resolution.recipients)).toBe(true);
      expect(Object.isFrozen(capturedRecipient)).toBe(true);
      expect(() => {
        (capturedRecipient as { peerId?: string }).peerId = SNAPSHOT_PEER_B;
      }).toThrow();
      return input.plaintext;
    });

    const result = await publisher.share(
      'snapshot-owned-recipient',
      [q('urn:test:snapshot-owned-recipient', 'http://schema.org/name', '"owned"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    );

    expect(result.gossipPayload.fanout.kind).toBe('captured');
    expect(result.gossipPayload.fanout.kind === 'captured'
      ? result.gossipPayload.fanout.snapshot
      : null).toEqual({
      source: 'agent-roster',
      members: [SNAPSHOT_PEER_A],
      complete: true,
    });
  });

  it('uses the validated non-empty recipient snapshot in built-in encryption', async () => {
    const senderAgentAddress = ethers.Wallet.createRandom().address;
    const recipient = recipientKeyFor(senderAgentAddress);
    publisher.setWorkspaceAgentRecipientResolver(async () => ({
      requiresEncryption: true,
      recipients: [{
        ...recipient,
        agentAddress: senderAgentAddress,
        peerId: SNAPSHOT_PEER_A,
      }],
    }));

    const result = await publisher.share(
      'snapshot-built-in-encryption',
      [q('urn:test:snapshot-built-in', 'http://schema.org/name', '"built-in"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    );

    expect(result.gossipPayload.fanout.kind).toBe('captured');
    if (result.gossipPayload.fanout.kind !== 'captured') throw new Error('expected captured fan-out');
    const envelope = decodeEncryptedWorkspacePayload(result.gossipPayload.message);
    expect(envelope.recipients).toHaveLength(1);
    expect(result.gossipPayload.fanout.snapshot).toEqual({
      source: 'agent-roster',
      members: [SNAPSHOT_PEER_A],
      complete: true,
    });
  });

  it('does not leak recipient state from a failed pre-commit encryption', async () => {
    const senderAgentAddress = ethers.Wallet.createRandom().address;
    publisher.setWorkspaceAgentRecipientResolver(async ({ contextGraphId }) => ({
      requiresEncryption: true,
      recipients: [{
        ...recipientKeyFor(senderAgentAddress),
        agentAddress: senderAgentAddress,
        peerId: contextGraphId === 'snapshot-fail' ? SNAPSHOT_PEER_B : SNAPSHOT_PEER_C,
      }],
    }));
    publisher.setWorkspaceSenderKeyEncryptor(async (input) => {
      if (input.contextGraphId === 'snapshot-fail') throw new Error('encryption failed');
      return input.plaintext;
    });

    await expect(publisher.share(
      'snapshot-fail',
      [q('urn:test:snapshot-fail', 'http://schema.org/name', '"fail"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    )).rejects.toThrow('encryption failed');

    const recovered = await publisher.share(
      'snapshot-fresh',
      [q('urn:test:snapshot-fresh', 'http://schema.org/name', '"fresh"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    );
    expect(recovered.gossipPayload).toEqual({
      message: expect.any(Uint8Array),
      fanout: {
        kind: 'captured',
        snapshot: {
          source: 'agent-roster',
          members: [SNAPSHOT_PEER_C],
          complete: true,
        },
      },
    });
  });

  it('keeps gossip enabled when an unchanged encryption member advertises a malformed peer ID', async () => {
    const senderAgentAddress = ethers.Wallet.createRandom().address;
    const recipient = recipientKeyFor(senderAgentAddress);
    let advertisedPeerId = SNAPSHOT_PEER_A;
    publisher.setWorkspaceAgentRecipientResolver(async () => ({
      requiresEncryption: true,
      recipients: [{
        ...recipient,
        agentAddress: senderAgentAddress,
        peerId: advertisedPeerId,
      }],
    }));
    publisher.setWorkspaceSenderKeyEncryptor(async (input) => input.plaintext);

    const first = await publisher.share(
      'snapshot-malformed-peer',
      [q('urn:test:snapshot-malformed-peer:first', 'http://schema.org/name', '"first"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    );
    advertisedPeerId = 'not-a-peer-id';
    const second = await publisher.share(
      'snapshot-malformed-peer',
      [q('urn:test:snapshot-malformed-peer:second', 'http://schema.org/name', '"second"')],
      { publisherPeerId: SNAPSHOT_SELF_PEER, senderAgentAddress },
    );

    expect(first.gossipPayload.fanout.kind).toBe('captured');
    expect(first.gossipPayload.fanout.kind === 'captured'
      ? first.gossipPayload.fanout.snapshot
      : null).toEqual({
      source: 'agent-roster',
      members: [SNAPSHOT_PEER_A],
      complete: true,
    });
    expect(second.gossipPayload.fanout.kind).toBe('captured');
    expect(second.gossipPayload.fanout.kind === 'captured'
      ? second.gossipPayload.fanout.snapshot
      : null).toEqual({
      source: 'agent-roster',
      members: [],
      complete: false,
    });
  });

  it.each([
    [
      'an empty encrypted roster',
      { requiresEncryption: true, recipients: [] },
      /has no valid DKG agent recipients/,
    ],
    [
      'recipients on the plaintext arm',
      {
        requiresEncryption: false,
        recipients: [{
          ...recipientKeyFor('0x0000000000000000000000000000000000000001'),
          agentAddress: '0x0000000000000000000000000000000000000001',
        }],
      },
      /returned recipients while encryption is disabled/,
    ],
    [
      'a malformed encrypted recipient',
      { requiresEncryption: true, recipients: [{ agentAddress: ethers.Wallet.createRandom().address }] },
      /returned an invalid DKG agent recipient/,
    ],
  ])('rejects custom resolver output with %s', async (_label, invalidResolution, expected) => {
    publisher.setWorkspaceAgentRecipientResolver(async () => invalidResolution as any);

    await expect(publisher.share(
      'snapshot-invalid-resolver',
      [q('urn:test:snapshot-invalid-resolver', 'http://schema.org/name', '"invalid"')],
      {
        publisherPeerId: SNAPSHOT_SELF_PEER,
        senderAgentAddress: ethers.Wallet.createRandom().address,
      },
    )).rejects.toThrow(expected);
  });

  // ── Strict curator-ack gate (OT-RFC-49 curator-leader) ──
  // The publisher-side hook: `confirmBeforeCommit` runs after the wire message
  // is built and BEFORE any store mutation. A non-confirmation MUST abort with
  // zero local persistence — the load-bearing "don't accept state" property.
  it('curator-ack gate: aborts (CuratorUnconfirmedError) and does NOT persist when the confirmer returns applied:false', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"GatedV2"')];
    let received: Uint8Array | undefined;
    const opts: ShareOptions = {
      publisherPeerId: 'peer1',
      confirmBeforeCommit: async (message) => {
        received = message;
        return { applied: false };
      },
    };
    await expect(publisher.share(CONTEXT_GRAPH, quads, opts)).rejects.toThrow(
      /not confirmed by its curator/,
    );
    // the confirmer received the real, fully-built wire message
    expect(received).toBeInstanceOf(Uint8Array);
    expect(received!.length).toBeGreaterThan(0);
    // CRITICAL: nothing was persisted — the workspace graph is empty for ENTITY
    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') expect(r.bindings.length).toBe(0);
  });

  it('curator-ack gate: aborts (CuratorRejectedError) and does NOT persist on a permanent rejection', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"GatedRej"')];
    await expect(
      publisher.share(CONTEXT_GRAPH, quads, {
        publisherPeerId: 'peer1',
        confirmBeforeCommit: async () => ({ applied: false, rejected: true }),
      }),
    ).rejects.toThrow(/permanently rejected by its curator/);
    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    if (r.type === 'bindings') expect(r.bindings.length).toBe(0);
  });

  it('curator-ack gate: commits normally when the confirmer returns applied:true', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"GatedOK"')];
    const result = await publisher.share(CONTEXT_GRAPH, quads, {
      publisherPeerId: 'peer1',
      confirmBeforeCommit: async () => ({ applied: true }),
    });
    expect(result.shareOperationId).toMatch(/^swm-/);
    const r = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(r.type).toBe('bindings');
    if (r.type === 'bindings') {
      expect(r.bindings.length).toBe(1);
      expect(r.bindings[0]['o']).toBe('"GatedOK"');
    }
  });

  it('allows same creator to upsert an existing workspace entity', async () => {
    const quads1 = [q(ENTITY, 'http://schema.org/name', '"First"')];
    await publisher.share(CONTEXT_GRAPH, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Updated by same creator"')];
    await publisher.share(CONTEXT_GRAPH, quads2, { publisherPeerId: 'peer1' });

    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated by same creator"');
    }
  });

  it('rejects write when rootEntity in workspace was created by a different peer (Rule 4)', async () => {
    const quads1 = [q(ENTITY, 'http://schema.org/name', '"First"')];
    await publisher.share(CONTEXT_GRAPH, quads1, { publisherPeerId: 'peer1' });

    const quads2 = [q(ENTITY, 'http://schema.org/name', '"Second"')];
    await expect(
      publisher.share(CONTEXT_GRAPH, quads2, { publisherPeerId: 'peer2' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('rejects write when rootEntity already in data graph (Rule 4)', async () => {
    await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [q(ENTITY, 'http://schema.org/name', '"Published"')],
    });

    const quads = [q(ENTITY, 'http://schema.org/description', '"In workspace"')];
    await expect(
      publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' }),
    ).rejects.toThrow(/Rule 4|Workspace validation failed/);
  });

  it('upsert replaces old triples, not appends', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://schema.org/name', '"Original"'),
      q(ENTITY, 'http://schema.org/description', '"Will be removed"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://schema.org/name', '"Replaced"'),
    ], { publisherPeerId: 'peer1' });

    const nameResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(nameResult.type).toBe('bindings');
    if (nameResult.type === 'bindings') {
      expect(nameResult.bindings.length).toBe(1);
      expect(nameResult.bindings[0]['o']).toBe('"Replaced"');
    }

    const descResult = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://schema.org/description> ?o } }`,
    );
    expect(descResult.type).toBe('boolean');
    if (descResult.type === 'boolean') {
      expect(descResult.value).toBe(false);
    }
  });
});

describe('Workspace: publishFromSharedMemory', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  let chain: EVMChainAdapter;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
    chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
    await seedContextGraphRegistration(store, CONTEXT_GRAPH);
  });
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('reads workspace and publishes to data graph (selection: all)', async () => {
    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Enshrine Me"'),
      q(ENTITY, 'http://schema.org/description', '"Will be enshrined"'),
    ];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      precomputedAttestation: await sealForQuads(quads, CONTEXT_GRAPH),
    });

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(ENTITY);

    // rc.17 uniform per-KA layout: a confirmed publish writes the KA's public
    // quads into the per-KA verifiable-memory graph …/_verifiable_memory/{author}/{number}
    // (author+number unpacked from the minted kaId), NOT the legacy monolithic
    // root data graph.
    const vmNumber = result.kaId & ((1n << 96n) - 1n);
    const vmAuthor = `0x${(result.kaId >> 96n).toString(16).padStart(40, '0')}`;
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/${vmAuthor}/${vmNumber}`;
    const dataResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${vmGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(dataResult.type).toBe('bindings');
    if (dataResult.type === 'bindings') {
      expect(dataResult.bindings.length).toBe(1);
      expect(dataResult.bindings[0]['o']).toBe('"Enshrine Me"');
    }
  });

  it('inlines small public SWM payloads for the internal first ACK attempt', async () => {
    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Inline From SWM"'),
    ];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer-inline' });

    let receivedStagingQuads: Uint8Array | undefined;
    const realProvider = getAckProvider();
    const v10ACKProvider: V10ACKProvider = async (params: V10ACKProviderParams) => {
      receivedStagingQuads = params.stagingQuads;
      expect(params.ackMode.kind).toBe('public');
      return realProvider(params);
    };

    const selectedQuads = [{
      subject: ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Inline From SWM"',
      graph: DATA_GRAPH,
    }];
    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      precomputedAttestation: await sealForQuads(selectedQuads, CONTEXT_GRAPH),
      v10ACKProvider,
    });

    expect(result.status).toBe('confirmed');
    expect(receivedStagingQuads).toBeDefined();
    expect(receivedStagingQuads!.length).toBeGreaterThan(0);

    const decoded = new TextDecoder().decode(receivedStagingQuads!);
    expect(decoded).toContain(`<${ENTITY}> <http://schema.org/name> "Inline From SWM"`);
  });

  it('omits staging quads for over-limit aggregate public SWM first ACK attempts', async () => {
    const targetBytes = STORAGE_ACK_MAX_STAGING_BYTES + 1;
    // The publisher prices/ACKs the canonical data-graph N-Quads, not the
    // caller's graphless SWM input. Build the boundary fixture with that exact
    // graph name so targetBytes remains the actual wire byte size.
    const selectedQuads = buildPublicQuadsWithByteSize(targetBytes, DATA_GRAPH);
    expect(encodedPublicByteLength(selectedQuads)).toBe(targetBytes);

    // An aggregate SWM selection can exceed the 4 MiB ACK-inline ceiling even
    // though every individual gossip operation respects the same 4 MiB limit.
    // Seed that reachable state through two valid shares instead of one
    // oversized share that must now fail at the producing boundary.
    const graphlessQuads = selectedQuads.map((quad) => ({ ...quad, graph: '' }));
    const splitAt = Math.ceil(graphlessQuads.length / 2);
    const firstShare = await publisher.share(
      CONTEXT_GRAPH,
      graphlessQuads.slice(0, splitAt),
      { publisherPeerId: 'peer-aggregate-first' },
    );
    const secondShare = await publisher.share(
      CONTEXT_GRAPH,
      graphlessQuads.slice(splitAt),
      { publisherPeerId: 'peer-aggregate-second' },
    );
    expect(firstShare.gossipPayload.message.length).toBeLessThanOrEqual(DKG_GOSSIP_MAX_MESSAGE_BYTES);
    expect(secondShare.gossipPayload.message.length).toBeLessThanOrEqual(DKG_GOSSIP_MAX_MESSAGE_BYTES);

    let receivedParams: V10ACKProviderParams | undefined;
    const stopAfterCapture = new Error('stop after over-limit ACK capture');
    const v10ACKProvider: V10ACKProvider = async (params: V10ACKProviderParams) => {
      receivedParams = params;
      throw stopAfterCapture;
    };

    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
        precomputedAttestation: await sealForQuads(selectedQuads, CONTEXT_GRAPH),
        v10ACKProvider,
      }),
    ).rejects.toThrow(stopAfterCapture.message);

    expect(receivedParams).toBeDefined();
    const params = receivedParams!;
    expect(params.ackMode.kind).toBe('public');
    if (params.ackMode.kind !== 'public') {
      throw new Error(`expected public ACK mode, got ${params.ackMode.kind}`);
    }
    expect(params.publicByteSize).toBe(BigInt(targetBytes));
    expect(params.stagingQuads).toBeUndefined();
  });

  it('enshrine with rootEntities filter only enshrines those entities', async () => {
    const entity1 = 'urn:test:entity:1';
    const entity2 = 'urn:test:entity:2';
    await publisher.share(CONTEXT_GRAPH, [
      q(entity1, 'http://schema.org/name', '"One"'),
      q(entity2, 'http://schema.org/name', '"Two"'),
    ], { publisherPeerId: 'peer1' });

    // RC11 / PR2: on-chain publishes require a precomputedAttestation.
    // Build one over the exact public-data-graph quads
    // `publishFromSharedMemory` will select for `entity1`.
    const selectedQuads = [{
      subject: entity1,
      predicate: 'http://schema.org/name',
      object: '"One"',
      graph: DATA_GRAPH,
    }];
    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
      rootEntities: [entity1],
    }, {
      precomputedAttestation: await sealForQuads(selectedQuads, CONTEXT_GRAPH),
    });

    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(entity1);

    // rc.17 uniform per-KA layout: the selected entity is published into the
    // per-KA verifiable-memory graph …/_verifiable_memory/{author}/{number}
    // (author+number unpacked from the minted kaId), NOT the legacy monolithic
    // root data graph.
    const vmNumber = result.kaId & ((1n << 96n) - 1n);
    const vmAuthor = `0x${(result.kaId >> 96n).toString(16).padStart(40, '0')}`;
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/${vmAuthor}/${vmNumber}`;
    const oneInData = await store.query(
      `ASK { GRAPH <${vmGraph}> { <${entity1}> <http://schema.org/name> ?o } }`,
    );
    expect(oneInData.type).toBe('boolean');
    if (oneInData.type === 'boolean') expect(oneInData.value).toBe(true);

    const twoInWorkspace = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${entity2}> <http://schema.org/name> ?o } }`,
    );
    expect(twoInWorkspace.type).toBe('boolean');
    if (twoInWorkspace.type === 'boolean') expect(twoInWorkspace.value).toBe(true);
  });

  it('clearSharedMemoryAfter removes enshrined rootEntities from workspace', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Clear After"')];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' });

    await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      clearSharedMemoryAfter: true,
      precomputedAttestation: await sealForQuads(quads, CONTEXT_GRAPH),
    });

    const stillInWorkspace = await store.query(
      `ASK { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(stillInWorkspace.type).toBe('boolean');
    if (stillInWorkspace.type === 'boolean') expect(stillInWorkspace.value).toBe(false);
  });

  it('throws when workspace is empty for selection', async () => {
    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all'),
    ).rejects.toThrow(/No public or private quads/);
  });

  it('escapes backslash and double-quote in rootEntity filter (SPARQL injection prevention)', async () => {
    const entityWithSpecialChars = 'urn:test:entity:with\\"backslash';
    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, {
        rootEntities: [entityWithSpecialChars],
      }),
    ).rejects.toThrow(/No valid rootEntities provided/);
  });

  it('throws distinct error for empty rootEntities array', async () => {
    await expect(
      publisher.publishFromSharedMemory(CONTEXT_GRAPH, { rootEntities: [] }),
    ).rejects.toThrow(/No rootEntities provided/);
  });

  it('publishFromSharedMemory with contextGraphId remaps quads to context graph URIs', async () => {
    const cgResult = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const ctxId = String(cgResult.contextGraphId);
    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ctxId}`;
    const ctxMetaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${ctxId}/_meta`;

    const quads = [
      q(ENTITY, 'http://schema.org/name', '"Context Enshrine"'),
      q(ENTITY, 'http://schema.org/description', '"In context graph"'),
    ];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      publishContextGraphId: ctxId,
      precomputedAttestation: await sealForQuads(quads, ctxId),
    });

    expect(result.status).toBe('confirmed');

    const dataResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(dataResult.type).toBe('bindings');
    if (dataResult.type === 'bindings') {
      expect(dataResult.bindings.length).toBe(1);
      expect(dataResult.bindings[0]['o']).toBe('"Context Enshrine"');
    }

    // RFC ka-metadata-trim P3.1 (collapsed shape): KA rows are the UAL
    // subject itself — identified by the member-entity pair, no `<ual>/<n>`
    // token rows and no `dkg:partOf`.
    const metaResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${ctxMetaGraph}> { ?s <http://dkg.io/ontology/rootEntity> ?root } }`,
    );
    expect(metaResult.type).toBe('bindings');
    if (metaResult.type === 'bindings') {
      expect(metaResult.bindings.length).toBeGreaterThan(0);
      expect(metaResult.bindings[0]['s']).toBe(result.ual);
    }
  });

  it('publishFromSharedMemory with contextGraphId calls verify', async () => {
    const cgResult = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const ctxId = String(cgResult.contextGraphId);

    const quads = [q(ENTITY, 'http://schema.org/name', '"Batch Test"')];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' });

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      publishContextGraphId: ctxId,
      precomputedAttestation: await sealForQuads(quads, ctxId),
    });
    expect(result.status).toBe('confirmed');
  });
});

describe('Workspace: ownership persistence and reconstruction', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  let _fileSnapshot: string;
  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  let _testSnapshot: string;
  beforeEach(async () => {
    _testSnapshot = await takeSnapshot();
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
    await seedContextGraphRegistration(store, CONTEXT_GRAPH);
  });
  afterEach(async () => {
    await revertSnapshot(_testSnapshot);
  });

  it('persists ownership quads to workspace_meta on share', async () => {
    const quads: Quad[] = [
      q(ENTITY, 'http://schema.org/name', '"Test"'),
    ];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: '12D3KooWCreator' });

    const result = await store.query(
      `SELECT ?creator WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['creator']).toBe('"12D3KooWCreator"');
    }
  });

  it('reconstructs sharedMemoryOwnedEntities from persisted ownership triples', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peerA' });

    const entity2 = 'urn:test:entity:2';
    await publisher.share(CONTEXT_GRAPH, [
      q(entity2, 'http://schema.org/name', '"Second"'),
    ], { publisherPeerId: 'peerB' });

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(2);
    expect(freshOwned.get(CONTEXT_GRAPH)?.get(ENTITY)).toBe('peerA');
    expect(freshOwned.get(CONTEXT_GRAPH)?.get(entity2)).toBe('peerB');
  });

  it('reconstructs ownership for slash-shaped context graph ids from SWM meta graph names', async () => {
    const curatedContextGraph = `${CONTEXT_GRAPH}/curated`;
    const curatedEntity = 'urn:test:entity:curated';
    const swmMetaGraph = `did:dkg:context-graph:${curatedContextGraph}/_shared_memory_meta`;
    const op = 'urn:test:op:curated';
    await store.insert([
      q('urn:test:root-marker', 'http://schema.org/name', '"Root"', WORKSPACE_META_GRAPH),
      q(curatedEntity, 'http://dkg.io/ontology/workspaceOwner', '"peerCurated"', swmMetaGraph),
      q(op, 'http://dkg.io/ontology/rootEntity', curatedEntity, swmMetaGraph),
      q(op, 'http://dkg.io/ontology/publisherPeerId', '"peerCurated"', swmMetaGraph),
    ]);

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(1);
    expect(freshOwned.get(curatedContextGraph)?.get(curatedEntity)).toBe('peerCurated');
  });

  it('reconstructs registered sub-graph ownership under the sub-graph key', async () => {
    const subGraphName = 'registered-sg';
    const subGraphUri = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}`;
    const subGraphMetaGraph = `${subGraphUri}/_shared_memory_meta`;
    const entity = 'urn:test:entity:registered-subgraph';
    const op = 'urn:test:op:registered-subgraph';
    await store.insert([
      q(subGraphUri, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://dkg.io/ontology/SubGraph', `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`),
      q(subGraphUri, 'http://schema.org/name', `"${subGraphName}"`, `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`),
      q(subGraphUri, 'http://dkg.io/ontology/createdBy', '"tester"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`),
      q(entity, 'http://dkg.io/ontology/workspaceOwner', '"peerSubGraph"', subGraphMetaGraph),
      q(op, 'http://dkg.io/ontology/rootEntity', entity, subGraphMetaGraph),
      q(op, 'http://dkg.io/ontology/publisherPeerId', '"peerSubGraph"', subGraphMetaGraph),
    ]);

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(1);
    expect(freshOwned.get(`${CONTEXT_GRAPH}\0${subGraphName}`)?.get(entity)).toBe('peerSubGraph');
  });

  it('reconstructs registered sub-graph ownership under slash-shaped context graph ids', async () => {
    const slashContextGraph = `${CONTEXT_GRAPH}/curated`;
    const subGraphName = 'registered-sg';
    const subGraphUri = `did:dkg:context-graph:${slashContextGraph}/${subGraphName}`;
    const subGraphMetaGraph = `${subGraphUri}/_shared_memory_meta`;
    const entity = 'urn:test:entity:slash-registered-subgraph';
    const op = 'urn:test:op:slash-registered-subgraph';
    await store.insert([
      q(subGraphUri, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://dkg.io/ontology/SubGraph', `did:dkg:context-graph:${slashContextGraph}/_meta`),
      q(subGraphUri, 'http://schema.org/name', `"${subGraphName}"`, `did:dkg:context-graph:${slashContextGraph}/_meta`),
      q(subGraphUri, 'http://dkg.io/ontology/createdBy', '"tester"', `did:dkg:context-graph:${slashContextGraph}/_meta`),
      q(entity, 'http://dkg.io/ontology/workspaceOwner', '"peerSlashSubGraph"', subGraphMetaGraph),
      q(op, 'http://dkg.io/ontology/rootEntity', entity, subGraphMetaGraph),
      q(op, 'http://dkg.io/ontology/publisherPeerId', '"peerSlashSubGraph"', subGraphMetaGraph),
    ]);

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const freshOwned = new Map<string, Map<string, string>>();
    const freshPublisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: freshOwned,
    });

    const count = await freshPublisher.reconstructWorkspaceOwnership();
    expect(count).toBe(1);
    expect(freshOwned.get(`${slashContextGraph}\0${subGraphName}`)?.get(entity)).toBe('peerSlashSubGraph');
    expect(freshOwned.get(`${slashContextGraph}/${subGraphName}`)?.get(entity)).toBeUndefined();
  });

  it('clears ownership quads on publishFromSharedMemory with clearSharedMemoryAfter', async () => {
    const quads = [q(ENTITY, 'http://schema.org/name', '"Enshrine"')];
    await publisher.share(CONTEXT_GRAPH, quads, { publisherPeerId: 'peer1' });

    await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      clearSharedMemoryAfter: true,
      precomputedAttestation: await sealForQuads(quads, CONTEXT_GRAPH),
    });

    const result = await store.query(
      `ASK { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(false);
    }
  });

  it('does not create duplicate ownership quads on upsert by same creator', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://schema.org/name', '"First"'),
    ], { publisherPeerId: 'peer1' });

    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://schema.org/name', '"Updated"'),
    ], { publisherPeerId: 'peer1' });

    const result = await store.query(
      `SELECT ?creator WHERE { GRAPH <${WORKSPACE_META_GRAPH}> { <${ENTITY}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }
  });
});

describe('SharedMemoryHandler', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('stores valid workspace message to workspace and workspace_meta', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Handler Test" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-handler-1',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const wsGraph = rootlessSharedMemoryGraphFromWire(msg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Handler Test"');
    }
    expect(workspaceOwned.get(CONTEXT_GRAPH)?.has(ENTITY)).not.toBe(true);
  });

  it('notifies context-graph meta invalidation after SWM sub-graph auto-registration', async () => {
    const dirtyQuads: Quad[] = [];
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      markContextGraphMetaDirtyFromQuads: (quads) => { dirtyQuads.push(...quads); },
    });
    const subGraphName = 'tasks';
    const subGraphGraph = `${DATA_GRAPH}/${subGraphName}`;
    const nquads = `<${ENTITY}> <http://schema.org/name> "SubGraph Handler Test" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      subGraphName,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-handler-subgraph-dirty',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    expect(dirtyQuads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: subGraphGraph,
          predicate: 'http://schema.org/name',
          object: `"${subGraphName}"`,
          graph: `${DATA_GRAPH}/_meta`,
        }),
      ]),
    );
  });

  it('rejects raw workspace gossip when the context graph is agent-gated', async () => {
    const wallet = ethers.Wallet.createRandom();
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: 'https://dkg.network/ontology#allowedAgent',
      object: `"${wallet.address}"`,
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`,
    }]);

    const nquads = `<${ENTITY}> <http://schema.org/name> "Unsigned" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-unsigned-agent-gate',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CONTEXT_GRAPH);
    const askResult = await store.query(
      `ASK { GRAPH <${gm.workspaceGraphUri(CONTEXT_GRAPH)}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(false);
    }
  });

  it('treats malformed allowedAgent metadata as gated instead of open', async () => {
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: 'https://dkg.network/ontology#allowedAgent',
      object: '"not-an-address"',
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`,
    }]);

    const nquads = `<${ENTITY}> <http://schema.org/name> "Malformed Gate" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-malformed-agent-gate',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CONTEXT_GRAPH);
    const askResult = await store.query(
      `ASK { GRAPH <${gm.workspaceGraphUri(CONTEXT_GRAPH)}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(false);
    }
  });

  it('accepts signed workspace gossip from an allowed agent', async () => {
    const wallet = ethers.Wallet.createRandom();
    const recipientKey = recipientKeyFor(wallet.address);
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [wallet.address],
      workspaceRecipientPrivateKeys: () => [recipientKey],
    });
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: 'https://dkg.network/ontology#allowedAgent',
      object: `"${wallet.address}"`,
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`,
    }]);

    const nquads = `<${ENTITY}> <http://schema.org/name> "Signed" <${DATA_GRAPH}> .`;
    const timestampMs = Date.now();
    const shareOperationId = 'ws-signed-agent-gate';
    const raw = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId,
      timestampMs,
    });
    const encrypted = await encryptWorkspaceMessage(
      wallet.address,
      CONTEXT_GRAPH,
      raw,
      shareOperationId,
      timestampMs,
      recipientKey,
    );
    const msg = await signWorkspaceMessage(wallet, CONTEXT_GRAPH, encrypted);

    await handler.handle(msg, '12D3KooWPeer');

    const wsGraph = rootlessSharedMemoryGraphFromWire(raw);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]?.['o']).toBe('"Signed"');
    }
  });

  it('rejects signed workspace gossip from an agent outside the allowlist', async () => {
    const allowed = ethers.Wallet.createRandom();
    const denied = ethers.Wallet.createRandom();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
      localAgentAddresses: () => [allowed.address],
    });
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: 'https://dkg.network/ontology#allowedAgent',
      object: `"${allowed.address}"`,
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`,
    }]);

    const nquads = `<${ENTITY}> <http://schema.org/name> "Denied" <${DATA_GRAPH}> .`;
    const raw = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-denied-agent-gate',
      timestampMs: Date.now(),
    });
    const msg = await signWorkspaceMessage(denied, CONTEXT_GRAPH, raw);

    await handler.handle(msg, '12D3KooWPeer');

    const gm = new GraphManager(store);
    await gm.ensureContextGraph(CONTEXT_GRAPH);
    const askResult = await store.query(
      `ASK { GRAPH <${gm.workspaceGraphUri(CONTEXT_GRAPH)}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(false);
    }
  });

  it('does not consult legacy per-root ownership for a graph-scoped KA', async () => {
    workspaceOwned.set(CONTEXT_GRAPH, new Map([[ENTITY, 'otherPeer']]));

    const nquads = `<${ENTITY}> <http://schema.org/name> "Duplicate" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'ws-dup',
      timestampMs: Date.now(),
    });

    const outcome = await handler.handle(msg, '12D3KooWPeer');

    const wsGraph = rootlessSharedMemoryGraphFromWire(msg);
    const askResult = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${ENTITY}> ?p ?o } }`,
    );
    expect(outcome.applied).toBe(true);
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(true);
    }
  });

  it('allows same creator to upsert via gossip handler', async () => {
    const peerId = '12D3KooWSameCreator';

    const msg1 = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Original" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-1',
      timestampMs: Date.now(),
    });
    await handler.handle(msg1, peerId);

    const msg2 = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-2',
      assertionVersion: '2',
      timestampMs: Date.now(),
    });
    await handler.handle(msg2, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(msg2);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Updated"');
    }
  });

  it('persists one durable KA-level transport owner across assertion versions', async () => {
    const peerId = '12D3KooWOwner';
    const firstPublishedAt = 1_700_000_000_000;
    // Oxigraph canonicalizes the valid xsd:dateTime fraction `.120Z` to `.12Z`.
    // The resolver must validate the value semantically and normalize it to ms.
    const secondPublishedAt = 1_700_000_000_120;

    const msg1 = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "First" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-own-1',
      timestampMs: firstPublishedAt,
    });
    await handler.handle(msg1, peerId);

    const gm = new GraphManager(store);
    const firstRequest = decodeWorkspacePublishRequest(msg1);
    const afterFirst = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: gm,
      contextGraphId: CONTEXT_GRAPH,
      kaUal: firstRequest.kaUal ?? '',
    });
    expect(afterFirst?.publisherPeerId).toBe(peerId);
    expect(afterFirst?.publishedAt).toBe(firstPublishedAt.toString());
    await expect(resolvePublishedKnowledgeAssetWorkspaceHead({
      store,
      graphManager: gm,
      contextGraphId: CONTEXT_GRAPH,
      kaUal: firstRequest.kaUal ?? '',
    })).resolves.toMatchObject({ publishedAt: firstPublishedAt.toString() });

    await store.deleteByPattern({
      graph: gm.sharedMemoryMetaUri(CONTEXT_GRAPH),
      subject: `urn:dkg:share:${CONTEXT_GRAPH}:ws-own-1`,
      predicate: 'http://dkg.io/ontology/publishedAt',
    });
    const legacyHeadWithoutPublishedAt = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: gm,
      contextGraphId: CONTEXT_GRAPH,
      kaUal: firstRequest.kaUal ?? '',
    });
    expect(legacyHeadWithoutPublishedAt?.publishedAt).toBeUndefined();
    await expect(resolvePublishedKnowledgeAssetWorkspaceHead({
      store,
      graphManager: gm,
      contextGraphId: CONTEXT_GRAPH,
      kaUal: firstRequest.kaUal ?? '',
    })).rejects.toThrow(/missing canonical publishedAt/u);

    const msg2 = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-own-2',
      assertionVersion: '2',
      timestampMs: secondPublishedAt,
    });
    await handler.handle(msg2, peerId);

    const afterSecond = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: gm,
      contextGraphId: CONTEXT_GRAPH,
      kaUal: firstRequest.kaUal ?? '',
    });
    expect(afterSecond).toMatchObject({
      assertionVersion: '2',
      publisherPeerId: peerId,
      publishedAt: secondPublishedAt.toString(),
    });
  });
});

/**
 * rc.9 PR-C codex R3: `handle()` returns a `SharedMemoryApplyOutcome`
 * so the new substrate-fanout receiver can distinguish "applied
 * locally" from "silently rejected" without log-scraping. Gossip
 * callers ignore the return (unchanged behaviour); substrate
 * callers throw on `retryable: true` so `sendReliable` keeps the
 * share queued for retry.
 */
describe('SharedMemoryHandler.handle outcome (rc.9 PR-C codex R3)', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;

  beforeEach(() => {
    store = new OxigraphStore();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {});
  });

  it('successful apply returns { applied: true } with metadata for PR-D ack-quorum tracking', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Applied" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeerR3',
      shareOperationId: 'op-applied',
      timestampMs: Date.now(),
    });

    const outcome = await handler.handle(msg, '12D3KooWPeerR3');
    // PR-D extended the applied: true variant to carry cgId,
    // shareOperationId, and publisherPeerId so the gossip
    // subscriber can address SwmShareAck back to the publisher
    // (RFC-003 §4.2). Backward-compat: legacy callers using just
    // `outcome.applied` still see `true`; only assertions with
    // strict equality need the new fields.
    // Codex PR #610 R2 added `insertedTriples` to the applied:true
    // variant so LU-6 host-catchup can report a per-triple total
    // (rather than per-envelope) in `totalInsertedTriples`. Same
    // backward-compat note as before: legacy callers reading just
    // `outcome.applied` are unaffected; only strict-equality
    // assertions need the new field.
    expect(outcome).toEqual({
      applied: true,
      assetUal: expect.stringMatching(/^did:dkg:/),
      cgId: CONTEXT_GRAPH,
      shareOperationId: 'op-applied',
      publisherPeerId: '12D3KooWPeerR3',
      insertedTriples: 1,
    });
  });

  it('permanent rejection (publisherPeerId / fromPeerId mismatch) returns { applied: false, retryable: false }', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "PubMismatch" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWClaimedPublisher',
      shareOperationId: 'op-pub-mismatch',
      timestampMs: Date.now(),
    });

    const outcome = await handler.handle(msg, '12D3KooWActualSender');
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('unreachable');
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain('does not match sender');
  });

  it('retryable rejection (CAS pre-condition not met) returns { applied: false, retryable: true } — codex R4', async () => {
    // Codex R4 (dropped review comment): CAS-not-met is
    // TRANSIENT when SWM writes arrive out of order. The
    // missed upstream write might still land via gossip and
    // bring local state up to where the CAS condition would
    // pass; the substrate outbox must keep this share queued.
    //
    // Setup: empty store. Send a publish with a CAS condition
    // expecting "recruiting" on a subject/predicate that
    // doesn't exist locally → enforceCASConditions returns
    // false → withWriteLocks closure returns false with
    // withWriteLocksRejection = 'cas' → outcome should be
    // retryable.
    const nquads = `<${ENTITY}> <http://schema.org/name> "CASRetry" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeerR4',
      shareOperationId: 'op-cas-retryable',
      timestampMs: Date.now(),
      casConditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });

    const outcome = await handler.handle(msg, '12D3KooWPeerR4');
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('unreachable');
    expect(outcome.retryable).toBe(true);
    expect(outcome.reason).toMatch(/CAS/);
  });

  it('permanent rejection (malformed protobuf wire bytes) returns { applied: false, retryable: false } — codex R5', async () => {
    // Codex R5 (dropped review comment): decode failures are
    // DETERMINISTIC — retrying the same bytes can't make a
    // malformed envelope parse. The top-level decode try in
    // handle() short-circuits these as `retryable: false` so
    // the substrate outbox drops on first attempt instead of
    // burning retry budget on log noise.
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

    const outcome = await handler.handle(garbage, '12D3KooWPeerR5');
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('unreachable');
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toMatch(/decode/i);
  });

  it('retryable rejection (unexpected throw during apply) returns { applied: false, retryable: true }', async () => {
    // Dominant production case for `retryable: true`: the
    // sender key package for the current epoch hasn't arrived
    // yet, so `workspaceSenderKeyDecryptor` rejects with an
    // Error. The outer catch in `handle()` MUST classify any
    // such thrown error as retryable so the substrate outbox
    // keeps the share queued for retry — once the sender key
    // package arrives, the SAME wire bytes apply cleanly.
    //
    // Setting up a real agent-gated CG + sender-key state is
    // heavyweight here; instead we install a store proxy that
    // throws inside the handle()'s try-block (a triple-store
    // hiccup has identical semantics — caught by the same
    // outer catch and classified by the same rule). Any
    // unexpected throw → `retryable: true`.
    const throwingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return () => Promise.reject(new Error('simulated triple-store worker hiccup'));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const throwingHandler = new SharedMemoryHandler(throwingStore, new TypedEventBus(), {});

    const nquads = `<${ENTITY}> <http://schema.org/name> "WillThrow" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeerR3',
      shareOperationId: 'op-retryable',
      timestampMs: Date.now(),
    });

    const outcome = await throwingHandler.handle(msg, '12D3KooWPeerR3');
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('unreachable');
    expect(outcome.retryable).toBe(true);
    expect(typeof outcome.reason).toBe('string');
    expect(outcome.reason.length).toBeGreaterThan(0);
  });
});

describe('SharedMemoryHandler: redundant-apply counter (rc.9 PR-A)', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;

  beforeEach(() => {
    store = new OxigraphStore();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {});
  });

  it('returns zero counts initially', () => {
    expect(handler.getStats()).toEqual({ redundantApplies: {}, redundantAppliesLowerBound: false, redundantAppliesOverflow: 0, redundantAppliesTruncated: false });
  });

  it('does not count first delivery of a (cgId, shareOpId) pair', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "First" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'first-only',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');

    expect(handler.getStats()).toEqual({ redundantApplies: {}, redundantAppliesLowerBound: false, redundantAppliesOverflow: 0, redundantAppliesTruncated: false });
  });

  it('counts each subsequent delivery of the same (cgId, shareOpId) within TTL', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Twice" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'dup-op',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');
    await handler.handle(msg, '12D3KooWPeer');
    await handler.handle(msg, '12D3KooWPeer');

    expect(handler.getStats()).toEqual({
      redundantApplies: { [CONTEXT_GRAPH]: 2 },
      redundantAppliesLowerBound: false,
      redundantAppliesOverflow: 0,
      redundantAppliesTruncated: false,
    });
  });

  it('isolates counts per cgId', async () => {
    const otherCg = `${CONTEXT_GRAPH}-second`;
    const otherDataGraph = `did:dkg:context-graph:${otherCg}`;

    const msgA = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "A" <${DATA_GRAPH}> .`),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-a',
      timestampMs: Date.now(),
    });
    const msgB = encodeRootlessWorkspaceRequest({
      contextGraphId: otherCg,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "B" <${otherDataGraph}> .`),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-b',
      timestampMs: Date.now(),
    });

    await handler.handle(msgA, '12D3KooWPeer');
    await handler.handle(msgA, '12D3KooWPeer');
    await handler.handle(msgB, '12D3KooWPeer');
    await handler.handle(msgB, '12D3KooWPeer');
    await handler.handle(msgB, '12D3KooWPeer');

    expect(handler.getStats()).toEqual({
      redundantApplies: {
        [CONTEXT_GRAPH]: 1,
        [otherCg]: 2,
      },
      redundantAppliesLowerBound: false,
      redundantAppliesOverflow: 0,
      redundantAppliesTruncated: false,
    });
  });

  it('does not count if same shareOpId is delivered but TTL has elapsed', async () => {
    let nowMs = 1_000_000;
    const handlerWithClock = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
    });

    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${ENTITY}> <http://schema.org/name> "TTL" <${DATA_GRAPH}> .`),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-ttl',
      timestampMs: nowMs,
    });

    await handlerWithClock.handle(msg, '12D3KooWPeer');
    nowMs += 10 * 60 * 1000 + 1;
    await handlerWithClock.handle(msg, '12D3KooWPeer');

    expect(handlerWithClock.getStats()).toEqual({ redundantApplies: {}, redundantAppliesLowerBound: false, redundantAppliesOverflow: 0, redundantAppliesTruncated: false });
  });

  it('still applies the second delivery (no behavior change — measurement only)', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Applied" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-applied-twice',
      timestampMs: Date.now(),
    });

    await handler.handle(msg, '12D3KooWPeer');
    await handler.handle(msg, '12D3KooWPeer');

    const wsGraph = rootlessSharedMemoryGraphFromWire(msg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${ENTITY}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Applied"');
    }
    expect(handler.getStats()).toEqual({
      redundantApplies: { [CONTEXT_GRAPH]: 1 },
      redundantAppliesLowerBound: false,
      redundantAppliesOverflow: 0,
      redundantAppliesTruncated: false,
    });
  });

  // PR-A R1 regression: a delivery that fails validation (here:
  // invalid subGraphName — caught by `validateSubGraphName` before the
  // write lock) MUST NOT bump `redundantApplies`. Pre-fix the counter
  // was incremented at the top of `handle()` before any validation,
  // so a steady stream of rejected duplicate messages would silently
  // inflate the /api/slo metric the rc10 dedup decision is based on.
  // Codex review on PR #570 caught the early-bump.
  it('does NOT count a duplicated rejected delivery (R1: rejected messages skipped)', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Bad" <${DATA_GRAPH}> .`;
    const badMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: '12D3KooWPeer',
      shareOperationId: 'op-rejected',
      timestampMs: Date.now(),
      // Invalid sub-graph name — `validateSubGraphName` rejects, so
      // `handle()` returns BEFORE the write lock and BEFORE
      // recordSeenShareOp is invoked.
      subGraphName: '../illegal',
    });

    await handler.handle(badMsg, '12D3KooWPeer');
    await handler.handle(badMsg, '12D3KooWPeer');
    await handler.handle(badMsg, '12D3KooWPeer');

    expect(handler.getStats()).toEqual({ redundantApplies: {}, redundantAppliesLowerBound: false, redundantAppliesOverflow: 0, redundantAppliesTruncated: false });
  });

  it('does NOT count a duplicated delivery whose publisherPeerId disagrees with the sender (R1: rejected messages skipped)', async () => {
    const nquads = `<${ENTITY}> <http://schema.org/name> "Spoofed" <${DATA_GRAPH}> .`;
    const spoofedMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      // Claims to be from Peer-A but `handle()` receives it from
      // Peer-Other → rejected at the publisherPeerId check.
      publisherPeerId: '12D3KooWPeer-A',
      shareOperationId: 'op-spoofed',
      timestampMs: Date.now(),
    });

    await handler.handle(spoofedMsg, '12D3KooWPeer-Other');
    await handler.handle(spoofedMsg, '12D3KooWPeer-Other');

    expect(handler.getStats()).toEqual({ redundantApplies: {}, redundantAppliesLowerBound: false, redundantAppliesOverflow: 0, redundantAppliesTruncated: false });
  });

  // PR-A R2 + R4 regression: the seenShareOps map is true LRU AND
  // the cap-based eviction is exercised. Pre-R2, `Map#set(existing,…)`
  // didn't move the key in iteration order, so a hot key inserted at
  // t=0 would be evicted as if cold. Pre-R4 the regression test only
  // checked insertion order without crossing the cap, so removing the
  // `delete(key)` fix would still let the test pass.
  //
  // This test drives the map past `seenOpsMaxSize` (configured tiny
  // here, default is 50_000) so the eviction path actually runs and
  // we can assert the hot key survives. Uses an injected fixed clock
  // so the TTL prune-first phase doesn't bail anything out for us.
  it('LRU refresh + cap eviction: a re-observed key survives an actual eviction batch (R2 + R4)', () => {
    let nowMs = 1_000_000;
    const handlerForLru = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
      seenOpsMaxSize: 10,
      seenOpsEvictBatch: 5,
      seenOpsTtlMs: 10 * 60 * 1000,
    });
    const internals = handlerForLru as unknown as {
      seenShareOps: Map<string, number>;
      recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
    };
    const ctx = {} as any;

    internals.recordSeenShareOp('cg', 'hot', ctx);
    for (let i = 0; i < 8; i++) {
      internals.recordSeenShareOp('cg', `cold-${i}`, ctx);
    }
    internals.recordSeenShareOp('cg', 'hot', ctx);
    internals.recordSeenShareOp('cg', 'cold-9', ctx);
    internals.recordSeenShareOp('cg', 'cold-10', ctx);

    // PR-A R11: keys are `JSON.stringify([cgId, shareOperationId])`,
    // not the legacy `${cgId}|${shareOperationId}` (which was
    // ambiguous when either field contained `|`).
    const remaining = [...internals.seenShareOps.keys()];
    expect(remaining).toContain(JSON.stringify(['cg', 'hot']));
    expect(remaining.length).toBeLessThanOrEqual(10);
    expect(remaining).not.toContain(JSON.stringify(['cg', 'cold-0']));
    expect(remaining).not.toContain(JSON.stringify(['cg', 'cold-1']));
  });

  // PR-A R3 regression: when the map fills the cap, the FIRST eviction
  // pass prunes TTL-expired entries — only if that's not enough does
  // cap-based batch eviction kick in. Pre-fix, cap eviction trimmed
  // live entries even when TTL-expired entries were sitting right
  // there waiting to be removed, silently shrinking the measurement
  // window. This test inserts entries at t=0, advances the clock past
  // TTL, then inserts more — and asserts the t=0 entries are pruned
  // by the TTL-first sweep before any live entries get touched.
  it('cap eviction prunes TTL-expired entries first (R3)', () => {
    let nowMs = 1_000_000;
    const handlerForTtl = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
      seenOpsMaxSize: 5,
      seenOpsEvictBatch: 5,
      seenOpsTtlMs: 1_000,
    });
    const internals = handlerForTtl as unknown as {
      seenShareOps: Map<string, number>;
      seenOpsCapEvictedLiveEntries: boolean;
      recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
    };
    const ctx = {} as any;

    for (let i = 0; i < 5; i++) {
      internals.recordSeenShareOp('cg', `expired-${i}`, ctx);
    }
    nowMs += 2_000;
    internals.recordSeenShareOp('cg', 'live-0', ctx);
    internals.recordSeenShareOp('cg', 'live-1', ctx);

    // PR-A R11: keys are `JSON.stringify([cgId, shareOperationId])`.
    const remaining = [...internals.seenShareOps.keys()];
    expect(remaining).toContain(JSON.stringify(['cg', 'live-0']));
    expect(remaining).toContain(JSON.stringify(['cg', 'live-1']));
    for (let i = 0; i < 5; i++) {
      expect(remaining).not.toContain(JSON.stringify(['cg', `expired-${i}`]));
    }
    expect(internals.seenOpsCapEvictedLiveEntries).toBe(false);
    expect(handlerForTtl.getStats().redundantAppliesLowerBound).toBe(false);
  });

  // PR-A R9 regression: the per-cgId `redundantApplyCounts` map must
  // be bounded. Pre-fix, a hostile peer could force one duplicate
  // apply on many fresh cgIds and grow process memory + /api/slo
  // payload unboundedly. Fix: cap at `redundantAppliesMaxCgs` (default
  // 1024), evict smallest-count entries into an overflow bucket, flip
  // a sticky truncated flag. R8 lifted: the eviction comparison is
  // GLOBAL — when the new entry IS the smallest, it gets evicted
  // (not pushing out an existing hot cgId).
  it('caps redundantApplyCounts and protects hot cgIds against one-off bumps (R8 + R9)', () => {
    let nowMs = 1_000_000;
    const handlerForR9 = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
      redundantAppliesMaxCgs: 4,
      seenOpsTtlMs: 60 * 60 * 1000,
    });
    const internals = handlerForR9 as unknown as {
      recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
      enforceRedundantApplyCountsCap: () => void;
      redundantApplyCounts: Map<string, number>;
    };
    const ctx = {} as any;

    for (let i = 0; i < 5; i++) {
      internals.recordSeenShareOp('cg-hot', 'op-shared', ctx);
      internals.recordSeenShareOp('cg-hot', 'op-shared', ctx);
    }
    const hotCountBeforeEviction = internals.redundantApplyCounts.get('cg-hot');
    expect(hotCountBeforeEviction).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < 20; i++) {
      const opId = `op-cold-${i}`;
      internals.recordSeenShareOp(`cg-cold-${i}`, opId, ctx);
      internals.recordSeenShareOp(`cg-cold-${i}`, opId, ctx);
    }

    const stats = handlerForR9.getStats();
    expect(stats.redundantAppliesTruncated).toBe(true);
    expect(stats.redundantAppliesOverflow).toBeGreaterThan(0);
    expect(stats.redundantApplies['cg-hot']).toBe(hotCountBeforeEviction);
    expect(Object.keys(stats.redundantApplies).length).toBeLessThanOrEqual(4);
  });

  // PR-A R3 regression: when throughput outruns even the prune-expired
  // path (everything is still live AND we're over the cap), cap-based
  // eviction MUST trim live entries to stay bounded. The sticky
  // `redundantAppliesLowerBound` flag flips so operators see the
  // /api/slo metric has become a lower bound for the operating window.
  it('cap eviction sets the lower-bound flag when forced to trim live entries (R3)', () => {
    let nowMs = 1_000_000;
    const handlerForLowerBound = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
      seenOpsMaxSize: 5,
      seenOpsEvictBatch: 3,
      seenOpsTtlMs: 60 * 60 * 1000,
    });
    const internals = handlerForLowerBound as unknown as {
      seenShareOps: Map<string, number>;
      seenOpsCapEvictedLiveEntries: boolean;
      recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
    };
    const ctx = {} as any;

    expect(handlerForLowerBound.getStats().redundantAppliesLowerBound).toBe(false);

    for (let i = 0; i < 10; i++) {
      nowMs += 1;
      internals.recordSeenShareOp('cg', `live-${i}`, ctx);
    }

    expect(internals.seenOpsCapEvictedLiveEntries).toBe(true);
    expect(handlerForLowerBound.getStats().redundantAppliesLowerBound).toBe(true);
  });

  // PR-A R11 regression: prior to the fix, the composite key was
  // `${cgId}|${shareOperationId}`, which collided whenever either
  // field contained `|` (both wire-supplied — a hostile peer could
  // craft them). Two structurally distinct (cgId, op) pairs that
  // hash to the same string would corrupt `redundantApplies`
  // accounting: a legitimate first-delivery on one pair would look
  // like a "redundant" re-delivery of the other and bump the
  // operator-facing counter under the wrong cgId. The fix uses
  // `JSON.stringify([cgId, op])`, which is unambiguous (array
  // delimiters + JSON quote-escaping). This test exercises the
  // canonical aliasing pair and asserts that the legitimate first
  // delivery on the second pair is NOT counted as redundant.
  it('avoids (cgId, shareOpId) composite-key aliasing across pipe-containing values (R11)', () => {
    let nowMs = 1_000_000;
    const handlerForR11 = new SharedMemoryHandler(store, new TypedEventBus(), {
      now: () => nowMs,
      seenOpsTtlMs: 60 * 60 * 1000,
    });
    const internals = handlerForR11 as unknown as {
      recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
    };
    const ctx = {} as any;

    // Legacy `${cgId}|${shareOperationId}` would produce the same
    // string `"a|b|c"` for both of these distinct logical pairs:
    internals.recordSeenShareOp('a|b', 'c', ctx);
    internals.recordSeenShareOp('a', 'b|c', ctx);

    // Neither call is a redundant apply: the keys must be distinct.
    const stats = handlerForR11.getStats();
    expect(stats.redundantApplies).toEqual({});
    expect(stats.redundantAppliesLowerBound).toBe(false);
    expect(stats.redundantAppliesOverflow).toBe(0);
    expect(stats.redundantAppliesTruncated).toBe(false);

    // Now genuinely re-deliver the second pair and assert it IS
    // counted under the correct cgId (and not under "a|b").
    internals.recordSeenShareOp('a', 'b|c', ctx);
    const stats2 = handlerForR11.getStats();
    expect(stats2.redundantApplies).toEqual({ a: 1 });
  });

  // PR #570 Codex final follow-up + PR #573 R1: the bounded-memory
  // tuning knobs (`seenOpsTtlMs`, `seenOpsMaxSize`,
  // `seenOpsEvictBatch`, `redundantAppliesMaxCgs`) were stored
  // without validation, so a misconfigured value (e.g.
  // `seenOpsEvictBatch: 0`, negative TTLs, NaN) could defeat the
  // very memory bound those knobs underpin. The constructor now
  // validates each knob via `sanitizePositiveInt` and falls back to
  // the documented default for any value that wouldn't be a positive
  // integer (zero / negative / NaN / ±Infinity), WARN-logging the
  // correction. Fractional positive values are floored. These tests
  // pin that behavior.
  describe('tuning knob validation (PR #570 follow-up + PR #573 R1)', () => {
    const DEFAULT_SEEN_OPS_TTL_MS = 10 * 60 * 1000;
    const DEFAULT_SEEN_OPS_MAX_SIZE = 50_000;
    const DEFAULT_SEEN_OPS_EVICT_BATCH = 5_000;
    const DEFAULT_REDUNDANT_APPLIES_MAX_CGS = 1024;

    it('falls back to default when seenOpsEvictBatch is 0 (clamp-to-1 would still mostly work, but default is the consistent safe choice)', () => {
      const handlerForBatchZero = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsEvictBatch: 0,
      });
      const internals = handlerForBatchZero as unknown as { seenOpsEvictBatch: number };
      expect(internals.seenOpsEvictBatch).toBe(DEFAULT_SEEN_OPS_EVICT_BATCH);
    });

    it('falls back to default when seenOpsMaxSize is 0', () => {
      const handlerForCapZero = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsMaxSize: 0,
      });
      const internals = handlerForCapZero as unknown as { seenOpsMaxSize: number };
      expect(internals.seenOpsMaxSize).toBe(DEFAULT_SEEN_OPS_MAX_SIZE);
    });

    // PR #573 R1 specific: a clamp to 1 was the previous behavior, but
    // 1ms is too small to detect any real redundant apply — the metric
    // is silently disabled with only a WARN, exactly what Codex flagged.
    // Verify the negative TTL now produces the documented 10-minute
    // default instead.
    it('falls back to default (10 min) when seenOpsTtlMs is negative — a 1ms TTL would silently disable redundant-apply detection (R1)', () => {
      const handlerForNegTtl = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsTtlMs: -5000,
      });
      const internals = handlerForNegTtl as unknown as { seenOpsTtlMs: number };
      expect(internals.seenOpsTtlMs).toBe(DEFAULT_SEEN_OPS_TTL_MS);
    });

    it('falls back to default when seenOpsTtlMs is 0 (R1)', () => {
      const handlerForZeroTtl = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsTtlMs: 0,
      });
      const internals = handlerForZeroTtl as unknown as { seenOpsTtlMs: number };
      expect(internals.seenOpsTtlMs).toBe(DEFAULT_SEEN_OPS_TTL_MS);
    });

    it('falls back to default when redundantAppliesMaxCgs is 0', () => {
      const handlerForR9Zero = new SharedMemoryHandler(store, new TypedEventBus(), {
        redundantAppliesMaxCgs: 0,
      });
      const internals = handlerForR9Zero as unknown as { redundantAppliesMaxCgs: number };
      expect(internals.redundantAppliesMaxCgs).toBe(DEFAULT_REDUNDANT_APPLIES_MAX_CGS);
    });

    it('falls back to defaults when knob is NaN or ±Infinity (non-finite)', () => {
      const handlerForNaN = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsTtlMs: NaN,
        seenOpsMaxSize: Number.POSITIVE_INFINITY,
        seenOpsEvictBatch: Number.NEGATIVE_INFINITY,
        redundantAppliesMaxCgs: NaN,
      });
      const internals = handlerForNaN as unknown as {
        seenOpsTtlMs: number;
        seenOpsMaxSize: number;
        seenOpsEvictBatch: number;
        redundantAppliesMaxCgs: number;
      };
      expect(internals.seenOpsTtlMs).toBe(DEFAULT_SEEN_OPS_TTL_MS);
      expect(internals.seenOpsMaxSize).toBe(DEFAULT_SEEN_OPS_MAX_SIZE);
      expect(internals.seenOpsEvictBatch).toBe(DEFAULT_SEEN_OPS_EVICT_BATCH);
      expect(internals.redundantAppliesMaxCgs).toBe(DEFAULT_REDUNDANT_APPLIES_MAX_CGS);
    });

    it('floors fractional positive values to the nearest positive integer', () => {
      const handlerForFractional = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsMaxSize: 10.7,
        seenOpsEvictBatch: 2.4,
        seenOpsTtlMs: 1500.9,
        redundantAppliesMaxCgs: 5.5,
      });
      const internals = handlerForFractional as unknown as {
        seenOpsMaxSize: number;
        seenOpsEvictBatch: number;
        seenOpsTtlMs: number;
        redundantAppliesMaxCgs: number;
      };
      expect(internals.seenOpsMaxSize).toBe(10);
      expect(internals.seenOpsEvictBatch).toBe(2);
      expect(internals.seenOpsTtlMs).toBe(1500);
      expect(internals.redundantAppliesMaxCgs).toBe(5);
    });

    it('falls back to default when a positive fractional value floors to 0', () => {
      const handlerForSmallFractional = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsMaxSize: 0.5,
      });
      const internals = handlerForSmallFractional as unknown as { seenOpsMaxSize: number };
      expect(internals.seenOpsMaxSize).toBe(DEFAULT_SEEN_OPS_MAX_SIZE);
    });

    it('preserves well-formed values verbatim (regression guard)', () => {
      const handlerOk = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsMaxSize: 7,
        seenOpsEvictBatch: 3,
        seenOpsTtlMs: 1_000,
        redundantAppliesMaxCgs: 4,
      });
      const internals = handlerOk as unknown as {
        seenOpsMaxSize: number;
        seenOpsEvictBatch: number;
        seenOpsTtlMs: number;
        redundantAppliesMaxCgs: number;
      };
      expect(internals.seenOpsMaxSize).toBe(7);
      expect(internals.seenOpsEvictBatch).toBe(3);
      expect(internals.seenOpsTtlMs).toBe(1_000);
      expect(internals.redundantAppliesMaxCgs).toBe(4);
    });

    // PR #573 R2: the previous regression for `seenOpsEvictBatch: 0`
    // only asserted "map didn't stay at 20", which would still pass
    // even if eviction leaked 19/20 entries. With the new
    // fall-back-to-default semantics that test no longer exercises
    // batch=0's broken behavior (it falls back to the healthy 5000
    // batch), so instead pin the real invariant directly: with
    // healthy values configured, the cap MUST hold. Drives the map
    // past the configured `seenOpsMaxSize=3` and asserts size never
    // exceeds the cap, catching any future regression in the Phase-1
    // / Phase-2 eviction logic.
    it('seenShareOps respects the configured cap with healthy values (PR #573 R2)', () => {
      const handlerCapped = new SharedMemoryHandler(store, new TypedEventBus(), {
        seenOpsMaxSize: 3,
        seenOpsEvictBatch: 2,
        seenOpsTtlMs: 60 * 60 * 1000,
      });
      const internals = handlerCapped as unknown as {
        seenShareOps: Map<string, number>;
        recordSeenShareOp: (cgId: string, opId: string, ctx: unknown) => void;
      };
      const ctx = {} as any;

      for (let i = 0; i < 20; i++) {
        internals.recordSeenShareOp('cg', `op-${i}`, ctx);
        // The cap must hold after EVERY insert (not just at the end)
        // so a regression that occasionally leaks an extra entry
        // can't slip through by happening to land on an evict-cycle
        // boundary on the final iteration.
        expect(internals.seenShareOps.size).toBeLessThanOrEqual(3);
      }
      expect(internals.seenShareOps.size).toBeLessThanOrEqual(3);
    });
  });
});

describe('SharedMemoryHandler: CAS gossip enforcement', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('rejects CAS conditions with SPARQL injection in subject', async () => {
    const peerId = '12D3KooWPeer';
    const safeEntity = 'urn:test:safe-entity';
    const nquads = `<${safeEntity}> <http://schema.org/name> "Test" <${DATA_GRAPH}> .`;

    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-1',
      timestampMs: Date.now(),
      casConditions: [{
        subject: 'urn:x> } } . DROP ALL #<urn:y',
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(CONTEXT_GRAPH);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${safeEntity}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('rejects CAS conditions with SPARQL injection in expectedValue', async () => {
    const peerId = '12D3KooWPeer';
    const safeEntity = 'urn:test:safe-entity2';

    // First write so the entity exists
    const setupMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${safeEntity}> <http://schema.org/name> "Setup" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const nquads = `<${safeEntity}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`;
    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-2',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: safeEntity,
        predicate: 'http://schema.org/name',
        expectedValue: '"Setup" } } . DROP ALL #',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setupMsg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${safeEntity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Setup"');
    }
  });

  it('accepts valid CAS conditions and enforces them', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:cas-valid';

    const setupMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-cas-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-cas-update',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(updateMsg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"traveling"');
    }
  });

  it('rejects write when CAS condition value mismatches', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:cas-mismatch';

    const setupMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-mismatch-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "arrived" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-mismatch-update',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setupMsg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"traveling"');
    }
  });

  it('expectAbsent: allows write when triple does not exist', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:absent-pass';

    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-pass',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '',
        expectAbsent: true,
      }],
    });
    await handler.handle(msg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(msg);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('expectAbsent: rejects write when triple already exists', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:absent-fail';

    const setupMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-absent-reject',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status',
        expectedValue: '',
        expectAbsent: true,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setupMsg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"recruiting"');
    }
  });

  it('rejects non-absent CAS condition with empty expectedValue (protobuf default)', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:empty-expected';

    const setupMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://schema.org/name> "Setup" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-empty-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setupMsg, peerId);

    const updateMsg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://schema.org/name> "Updated" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-empty-update',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://schema.org/name',
        expectedValue: '',
        expectAbsent: false,
      }],
    });
    await handler.handle(updateMsg, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setupMsg);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://schema.org/name> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"Setup"');
    }
  });
});

describe('Workspace: conditionalShare (CAS)', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      kaAllocator: makeTestKaAllocator(),
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    publisher = wrapPublisherForTest(publisher, {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      v10ACKProvider: getAckProvider(),
    });
  });

  it('succeeds when condition matches current value', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    const result = await publisher.conditionalShare(CONTEXT_GRAPH, updated, opts);
    expect(result.shareOperationId).toBeTruthy();

    const check = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <http://example.org/status> ?o } }`,
    );
    expect(check.type).toBe('bindings');
    if (check.type === 'bindings') {
      expect(check.bindings[0].o).toBe('"traveling"');
    }
  });

  it('throws StaleWriteError when condition does not match', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    await expect(publisher.conditionalShare(CONTEXT_GRAPH, updated, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('throws StaleWriteError when expecting absent but triple exists', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const newQuads = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: null,
      }],
    };

    await expect(publisher.conditionalShare(CONTEXT_GRAPH, newQuads, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('succeeds when expecting absent and triple does not exist', async () => {
    const quads = [q(ENTITY, 'http://example.org/status', '"recruiting"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: null,
      }],
    };

    const result = await publisher.conditionalShare(CONTEXT_GRAPH, quads, opts);
    expect(result.shareOperationId).toBeTruthy();
  });

  it('does not treat promoted per-KA data as stale CAS bucket state', async () => {
    const predicate = 'http://example.org/status';
    const promotedGraph = `${WORKSPACE_GRAPH}/0x1111111111111111111111111111111111111111/1`;
    await store.insert([q(ENTITY, predicate, '"promoted"', promotedGraph)]);

    const result = await publisher.conditionalShare(CONTEXT_GRAPH, [
      q(ENTITY, predicate, '"recruiting"'),
    ], {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate,
        expectedValue: null,
      }],
    });

    expect(result.shareOperationId).toBeTruthy();
    const check = await store.query(
      `SELECT ?o WHERE { GRAPH <${WORKSPACE_GRAPH}> { <${ENTITY}> <${predicate}> ?o } }`,
    );
    expect(check.type).toBe('bindings');
    if (check.type === 'bindings') {
      expect(check.bindings.map((b) => b.o)).toContain('"recruiting"');
    }
  });

  it('StaleWriteError includes condition and actual value', async () => {
    const initial = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };

    try {
      await publisher.conditionalShare(CONTEXT_GRAPH, [q(ENTITY, 'http://example.org/status', '"traveling"')], opts);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleWriteError);
      const e = err as InstanceType<typeof StaleWriteError>;
      expect(e.condition.subject).toBe(ENTITY);
      expect(e.condition.predicate).toBe('http://example.org/status');
      expect(e.condition.expectedValue).toBe('"recruiting"');
      expect(e.actualValue).not.toBeNull();
    }
  });

  it('supports multiple conditions (all must pass)', async () => {
    const initial = [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
      q(ENTITY, 'http://example.org/turn', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const updated = [
      q(ENTITY, 'http://example.org/status', '"traveling"'),
      q(ENTITY, 'http://example.org/turn', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [
        { subject: ENTITY, predicate: 'http://example.org/status', expectedValue: '"recruiting"' },
        { subject: ENTITY, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    };

    const result = await publisher.conditionalShare(CONTEXT_GRAPH, updated, opts);
    expect(result.shareOperationId).toBeTruthy();
  });

  it('fails if any one of multiple conditions mismatches', async () => {
    const initial = [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
      q(ENTITY, 'http://example.org/turn', '"5"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ];
    await publisher.share(CONTEXT_GRAPH, initial, { publisherPeerId: 'peer1' });

    const updated = [q(ENTITY, 'http://example.org/status', '"traveling"')];
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [
        { subject: ENTITY, predicate: 'http://example.org/status', expectedValue: '"recruiting"' },
        { subject: ENTITY, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      ],
    };

    await expect(publisher.conditionalShare(CONTEXT_GRAPH, updated, opts))
      .rejects.toThrow(StaleWriteError);
  });

  it('rejects unsafe RDF terms in expectedValue (SPARQL injection)', async () => {
    const opts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting" } } . DROP ALL #',
      }],
    };
    await expect(publisher.conditionalShare(CONTEXT_GRAPH, [], opts))
      .rejects.toThrow('Unsafe RDF term');
  });

  it('accepts valid RDF literal and IRI terms', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://example.org/status', '"recruiting"'),
    ], { publisherPeerId: 'peer1' });

    const literalOpts: ConditionalShareOptions = {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/status',
        expectedValue: '"recruiting"',
      }],
    };
    // Weak `resolves.toBeDefined()` would accept a skeleton result
    // object or a failed-CAS shape where the assertion-condition
    // matched coincidentally. Pin both fields of the `ShareResult`
    // contract so a regression that silently no-ops the CAS (returns
    // a dummy "success" shape) cannot pass.
    const casResult = await publisher.conditionalShare(CONTEXT_GRAPH, [], literalOpts);
    expect(casResult.shareOperationId).toMatch(/.+/);
    expect(casResult.gossipPayload.message).toBeInstanceOf(Uint8Array);
    expect(casResult.gossipPayload.message.length).toBeGreaterThan(0);
  });

  it('serializes concurrent CAS writes to the same subject+predicate', async () => {
    await publisher.share(CONTEXT_GRAPH, [
      q(ENTITY, 'http://example.org/counter', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], { publisherPeerId: 'peer1' });

    const write1 = publisher.conditionalShare(CONTEXT_GRAPH, [
      q(ENTITY, 'http://example.org/counter', '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/counter',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      }],
    });

    const write2 = publisher.conditionalShare(CONTEXT_GRAPH, [
      q(ENTITY, 'http://example.org/counter', '"3"^^<http://www.w3.org/2001/XMLSchema#integer>'),
    ], {
      publisherPeerId: 'peer1',
      conditions: [{
        subject: ENTITY,
        predicate: 'http://example.org/counter',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
      }],
    });

    const results = await Promise.allSettled([write1, write2]);
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
  });
});

describe('SharedMemoryHandler: CAS edge cases', () => {
  let store: OxigraphStore;
  let handler: SharedMemoryHandler;
  let workspaceOwned: Map<string, Map<string, string>>;

  beforeEach(async () => {
    store = new OxigraphStore();
    workspaceOwned = new Map();
    handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: workspaceOwned,
    });
  });

  it('rejects CAS conditions with SPARQL injection in predicate', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:inject-pred';
    const nquads = `<${entity}> <http://schema.org/name> "Test" <${DATA_GRAPH}> .`;

    const msg = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquads),
      publisherPeerId: peerId,
      shareOperationId: 'ws-inject-pred',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/status> } } . DROP ALL #<http://x',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    });

    await handler.handle(msg, peerId);

    const gm = new GraphManager(store);
    const wsGraph = gm.workspaceGraphUri(CONTEXT_GRAPH);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${entity}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('cross-subject CAS: condition on subject A, write targets subject B — lock covers both', async () => {
    const peerId = '12D3KooWPeer';
    const subjectA = 'urn:test:lock-a';
    const subjectB = 'urn:test:lock-b';

    const setupA = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${subjectA}> <http://example.org/status> "active" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-setup-a',
      timestampMs: Date.now(),
    });
    await handler.handle(setupA, peerId);
    const setupScope = decodeWorkspacePublishRequest(setupA);

    const writeB = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${subjectB}> <http://example.org/name> "Created conditionally" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-write-b',
      agentAddress: setupScope.agentAddress,
      kaNumber: setupScope.kaNumber,
      kaUal: setupScope.kaUal,
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: subjectA,
        predicate: 'http://example.org/status',
        expectedValue: '"active"',
        expectAbsent: false,
      }],
    });
    await handler.handle(writeB, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(writeB);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${subjectB}> <http://example.org/name> ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(true);
  });

  it('cross-subject CAS: rejects when condition on subject A fails', async () => {
    const peerId = '12D3KooWPeer';
    const subjectA = 'urn:test:lock-a2';
    const subjectB = 'urn:test:lock-b2';

    const setupA = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${subjectA}> <http://example.org/status> "inactive" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-setup-a2',
      timestampMs: Date.now(),
    });
    await handler.handle(setupA, peerId);
    const setupScope = decodeWorkspacePublishRequest(setupA);

    const writeB = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${subjectB}> <http://example.org/name> "Should not appear" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-lock-write-b2',
      agentAddress: setupScope.agentAddress,
      kaNumber: setupScope.kaNumber,
      kaUal: setupScope.kaUal,
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: subjectA,
        predicate: 'http://example.org/status',
        expectedValue: '"active"',
        expectAbsent: false,
      }],
    });
    await handler.handle(writeB, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setupA);
    const result = await store.query(
      `ASK { GRAPH <${wsGraph}> { <${subjectB}> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') expect(result.value).toBe(false);
  });

  it('multiple gossip CAS conditions: rejects if any single condition fails', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:multi-cond';

    const setup = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/status> "recruiting" <${DATA_GRAPH}> .\n` +
        `<${entity}> <http://example.org/turn> "5"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      publisherPeerId: peerId,
      shareOperationId: 'ws-multi-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setup, peerId);

    const update = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(`<${entity}> <http://example.org/status> "traveling" <${DATA_GRAPH}> .`),
      publisherPeerId: peerId,
      shareOperationId: 'ws-multi-update',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [
        { subject: entity, predicate: 'http://example.org/status', expectedValue: '"recruiting"', expectAbsent: false },
        { subject: entity, predicate: 'http://example.org/turn', expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', expectAbsent: false },
      ],
    });
    await handler.handle(update, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(setup);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/status> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"recruiting"');
    }
  });

  it('gossip CAS with typed literal (xsd:integer) succeeds when match', async () => {
    const peerId = '12D3KooWPeer';
    const entity = 'urn:test:typed-lit';

    const setup = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/turn> "1"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      publisherPeerId: peerId,
      shareOperationId: 'ws-typed-setup',
      timestampMs: Date.now(),
    });
    await handler.handle(setup, peerId);

    const update = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(
        `<${entity}> <http://example.org/turn> "2"^^<http://www.w3.org/2001/XMLSchema#integer> <${DATA_GRAPH}> .`,
      ),
      publisherPeerId: peerId,
      shareOperationId: 'ws-typed-update',
      assertionVersion: '2',
      timestampMs: Date.now(),
      casConditions: [{
        subject: entity,
        predicate: 'http://example.org/turn',
        expectedValue: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
        expectAbsent: false,
      }],
    });
    await handler.handle(update, peerId);

    const wsGraph = rootlessSharedMemoryGraphFromWire(update);
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${wsGraph}> { <${entity}> <http://example.org/turn> ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
      expect(result.bindings[0]['o']).toBe('"2"^^<http://www.w3.org/2001/XMLSchema#integer>');
    }
  });
});
