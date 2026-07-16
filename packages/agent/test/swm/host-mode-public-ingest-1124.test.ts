/**
 * GH #1124 — public context graphs must be able to publish to Verifiable Memory.
 *
 * Host-mode cores dropped a PUBLIC CG's plaintext SWM share at two gates in
 * `ingestSwmHostModeEnvelope` (the `isCiphertext` sniff + the curated-agent
 * authority check), so a public CG's storage-ACK quorum was unreachable on a
 * host-mode sharded topology. The fix opens BOTH gates — but ONLY for a CG that
 * can be positively confirmed public via `isConfirmedPublicForHostMode`.
 *
 * The SECURITY-CRITICAL property is that helper's bias: a curated CG (including
 * one whose on-chain policy hasn't loaded yet — the chain-event race) must NEVER
 * be misclassified as public, because that would admit an unauthenticated
 * plaintext envelope into curated storage. `isConfirmedPublicForHostMode`
 * delegates to the shared `getContextGraphOnChainPolicy` resolver (cache + _meta
 * + chain RPC, key-independent) and treats ONLY `accessPolicy === 0` as public;
 * curated (1) and unknown (undefined/throw) both → false.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeWorkspacePublishRequest,
  encodePublishIntent,
  encodeEncryptedWorkspacePayload,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  decodeStorageACK,
  isStorageACKDecline,
  STORAGE_ACK_DECLINE_CODES,
  computePublishACKDigest,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  sharedMemoryReadBothFilter,
  TypedEventBus,
} from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent, agentFromPrivateKey, type AgentKeyRecord } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

interface ClassifierInternals {
  isConfirmedPublicForHostMode(cgId: string): Promise<boolean>;
  getContextGraphOnChainPolicy(
    cgId: string,
    options?: { publishPolicyMaxCacheAgeMs?: number },
  ): Promise<{ accessPolicy?: number; publishPolicy?: number }>;
}

interface IngestInternals {
  getContextGraphOnChainPolicy(cgId: string): Promise<{ accessPolicy?: number; publishPolicy?: number }>;
  encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array): Promise<Uint8Array>;
  ingestSwmHostModeEnvelope(contextGraphId: string, data: Uint8Array, fromPeerId: string): Promise<void>;
  swmHostModeStore?: SwmHostModeStore;
  localAgents: Map<string, AgentKeyRecord>;
  defaultAgentAddress?: string;
  getSwmHostModeStats(): Promise<{ perCg?: Record<string, { entries: number; bytes: number }> } | undefined>;
}

function rootlessWorkspaceScope(g: IngestInternals) {
  const agentAddress = ethers.getAddress(g.defaultAgentAddress!).toLowerCase();
  const kaNumber = '1';
  return {
    agentAddress,
    kaNumber,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:otp:20430/${agentAddress}/${kaNumber}`,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    accessPolicy: 'public' as const,
    allowedPeers: [] as string[],
  };
}

describe('GH #1124 — isConfirmedPublicForHostMode safety bias (only accessPolicy===0 is public)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-1124-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({ name: 'Pub1124Core', listenHost: '127.0.0.1', dataDir, nodeRole: 'core' });
    agents.push(core);
    return core;
  }

  it('open read + open publish (accessPolicy 0, publishPolicy 1) → public', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(true);
  });

  it('public READ but curated PUBLISH (accessPolicy 0, publishPolicy 0) → NOT self-publishable', async () => {
    // The #1239-r3 🔴: read visibility ≠ write authority. A publicly-readable CG
    // can still restrict who may publish; the self-signed path must NOT apply.
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 0 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('curated read (accessPolicy 1) → NOT public, regardless of publishPolicy', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1, publishPolicy: 1 });
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('UNKNOWN policy (either axis undefined — chain-event race) → NOT public (the misclassification guard)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0 }); // publishPolicy unresolved
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
    g.getContextGraphOnChainPolicy = async () => ({}); // both unresolved
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('policy resolver THROWS → NOT public (fail-safe)', async () => {
    const g = (await makeCore()) as unknown as ClassifierInternals;
    g.getContextGraphOnChainPolicy = async () => { throw new Error('chain unavailable'); };
    expect(await g.isConfirmedPublicForHostMode('cg')).toBe(false);
  });

  it('passes a SHORT publishPolicy cache window for the admission gate (bounded staleness + rate-capped RPC)', async () => {
    // publishPolicy is mutable on-chain; the general cache is ≤60s-TTL'd. This
    // security-positive gate passes a SHORT window so an open→curated downgrade
    // is re-verified within seconds AND the chain RPC is rate-capped to ~1 per
    // window per CG — not force-every-time (Branimir review #1239 follow-on).
    const g = (await makeCore()) as unknown as ClassifierInternals;
    let capturedOpts: { publishPolicyMaxCacheAgeMs?: number } | undefined;
    g.getContextGraphOnChainPolicy = async (_cg, opts) => { capturedOpts = opts; return { accessPolicy: 0, publishPolicy: 1 }; };
    await g.isConfirmedPublicForHostMode('cg');
    // A short window: positive, and far under the general 60s TTL.
    expect(capturedOpts?.publishPolicyMaxCacheAgeMs).toBeGreaterThan(0);
    expect(capturedOpts?.publishPolicyMaxCacheAgeMs).toBeLessThanOrEqual(10_000);
  });
});

describe('GH #1124 — ingestSwmHostModeEnvelope gate behaviour (signed plaintext gossip end-to-end)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeHostCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-1124-ingest-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({ name: 'Ingest1124Host', listenHost: '127.0.0.1', dataDir, nodeRole: 'core', swmHostMode: { enabled: true } });
    agents.push(core);
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    const g = core as unknown as IngestInternals;
    g.swmHostModeStore = store;
    // Register a local signing agent so encodeWorkspaceGossipMessage produces a
    // real SIGNED gossip envelope (otherwise it returns the raw, undecodable payload).
    const signer = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'signer');
    g.localAgents.set(signer.agentAddress, signer);
    g.defaultAgentAddress = signer.agentAddress;
    return core;
  }

  const PEER = '12D3KooWHostModePublisherPeerForIngestTest';
  // A valid PLAINTEXT WorkspacePublishRequest (public SWM share) — not ciphertext,
  // and decodable by the host's verifyHostModeEnvelopeAuthority path.
  const plaintextRequest = (g: IngestInternals, cg: string): Uint8Array => encodeWorkspacePublishRequest({
    contextGraphId: cg,
    nquads: new TextEncoder().encode(
      `<urn:p01124:s> <http://schema.org/name> "Public1124" <did:dkg:context-graph:${cg}> .`,
    ),
    manifest: [],
    publisherPeerId: PEER,
    shareOperationId: `op-1124-${cg}`,
    timestampMs: 1_700_000_000_000,
    ...rootlessWorkspaceScope(g),
  });

  async function entriesFor(g: IngestInternals, cg: string): Promise<number> {
    const stats = await g.getSwmHostModeStats();
    return stats?.perCg?.[cg]?.entries ?? 0;
  }

  // Drive the REAL classifier via the resolver it depends on (getContextGraphOnChainPolicy),
  // NOT by stubbing isConfirmedPublicForHostMode — so these exercise the actual
  // public-policy resolution + the two ingest gates end to end.
  it('CONFIRMED-PUBLIC: a signed plaintext SWM envelope is STORED (was dropped pre-#1124)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 }); // resolves fully-open (public read + open publish)
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(g, cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(1);
  });

  it('CURATED (accessPolicy 1): a plaintext envelope is DROPPED (Gate 1 — curated must be ciphertext)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-curated';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1, publishPolicy: 0 });
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(g, cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('UNKNOWN policy (unresolved): a plaintext envelope is DROPPED (safe default — heals via catchup)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-unknown';
    g.getContextGraphOnChainPolicy = async () => ({}); // accessPolicy undefined
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(g, cg));
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('PUBLIC but TAMPERED signature: DROPPED (shared verifier rejects bad signature/freshness)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-public-forged';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(g, cg));
    const tampered = Uint8Array.from(env);
    for (let i = 1; i <= 8 && i <= tampered.length; i++) tampered[tampered.length - i] ^= 0xff;
    await g.ingestSwmHostModeEnvelope(cg, tampered, PEER);
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('PUBLIC but inner request targets a DIFFERENT CG: DROPPED (no cross-CG injection)', async () => {
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cgEnvelope = 'cg-ingest-A';
    const cgInner = 'cg-ingest-B';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 }); // both fully-open (isolate the CG-binding check)
    // Envelope is signed for CG-A but its inner WorkspacePublishRequest targets CG-B.
    const env = await g.encodeWorkspaceGossipMessage(cgEnvelope, plaintextRequest(g, cgInner));
    await g.ingestSwmHostModeEnvelope(cgEnvelope, env, PEER);
    expect(await entriesFor(g, cgEnvelope)).toBe(0);
    expect(await entriesFor(g, cgInner)).toBe(0);
  });

  it('PUBLIC but inner publisherPeerId names a DIFFERENT peer than the sender: DROPPED (no publisher spoof)', async () => {
    // Host catchup later applies stored entries with trustedReplay (skipping the
    // publisherPeerId↔sender binding), so it must be enforced at ingest: a peer
    // relaying an honestly-signed envelope whose inner publisherPeerId names
    // ANOTHER peer must NOT be stored (otherwise catchup applies it under the
    // spoofed publisher/ownership identity).
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-spoof';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });
    // plaintextRequest(g, cg) sets publisherPeerId = PEER; deliver it from a DIFFERENT sender.
    const env = await g.encodeWorkspaceGossipMessage(cg, plaintextRequest(g, cg));
    await g.ingestSwmHostModeEnvelope(cg, env, '12D3KooWSomeOtherRelayPeerNotThePublisher');
    expect(await entriesFor(g, cg)).toBe(0);
  });

  it('CIPHERTEXT envelope: never resolves publishPolicy (lazy confirmedPublic — no per-message eth_call on the curated path)', async () => {
    // Branimir review #1239 follow-on: `confirmedPublic` only gates anything when
    // `!isCiphertext`, so it must NOT be computed for the dominant ciphertext
    // (curated) path — else the bulk of host-mode traffic pays a synchronous
    // chain read it then discards. A ciphertext envelope must flow to the
    // authority check WITHOUT any getContextGraphOnChainPolicy (eth_call).
    const g = (await makeHostCore()) as unknown as IngestInternals;
    const cg = 'cg-ingest-ciphertext';
    let policyCalls = 0;
    g.getContextGraphOnChainPolicy = async () => { policyCalls += 1; return { accessPolicy: 0, publishPolicy: 1 }; };
    // A real ciphertext payload (passes the `isCiphertext` sniff) in a signed envelope.
    const ciphertext = encodeEncryptedWorkspacePayload({
      version: '1', type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE, contextGraphId: cg,
      senderIdentity: 'sender', operationId: 'op', shareOperationId: `op-ct-${cg}`,
      timestampMs: 1_700_000_000_000, cipherAlgorithm: 'aes-256-gcm',
      nonce: new Uint8Array(12), ciphertext: new Uint8Array([1, 2, 3]),
      recipients: [], keyAgreementAlgorithm: 'x25519', ephemeralPublicKey: new Uint8Array(32),
    });
    const env = await g.encodeWorkspaceGossipMessage(cg, ciphertext);
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);
    expect(policyCalls).toBe(0);
  });
});

/**
 * GH #1124 END-STATE (otReviewAgent 🔴 round-2 #1239) — admitting the public
 * plaintext into the host-mode store is necessary but NOT sufficient: the
 * StorageACKHandler a publisher dials reads `<cg>/_shared_memory` from the
 * triple store, NOT SwmHostModeStore. So a non-member host that only retains
 * the opaque envelope still DECLINEs `NO_DATA_IN_SWM` and public-CG quorum
 * stays unreachable. The fix ALSO applies the plaintext (via the member apply
 * path) into the SWM graph the ACK handler reads.
 *
 * These tests drive the REAL `ingestSwmHostModeEnvelope` end-to-end and then a
 * REAL `StorageACKHandler` over the SAME agent store — they go RED against the
 * pre-fix code (which only appended the opaque envelope), unlike a test that
 * seeds the triple store directly. The negative controls pin that the apply is
 * gated SOLELY by `isConfirmedPublicForHostMode` (the load-bearing wrapper):
 * a curated CG (accessPolicy=1) AND a public-READABLE-but-restricted-PUBLISH CG
 * (accessPolicy=0, publishPolicy=0) both leave `_shared_memory` empty.
 */
describe('GH #1124 — a confirmed-public ingest makes a NON-MEMBER host ACK-capable (the quorum bridge)', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const PEER = '12D3KooWHostModePublisherPeerForAckTest';
  const TEST_CHAIN_ID = 31337n;
  const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
  const nquadFor = (cg: string) =>
    `<urn:ack1124:s> <http://schema.org/name> "AckCapable1124" <did:dkg:context-graph:${cg}> .`;

  async function makeHostCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-1124-ack-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({ name: 'Ack1124Host', listenHost: '127.0.0.1', dataDir, nodeRole: 'core', swmHostMode: { enabled: true } });
    agents.push(core);
    const g = core as unknown as IngestInternals;
    // Wire the host-mode store explicitly — ingestSwmHostModeEnvelope returns
    // early when `swmHostModeStore` is unset (it's lazily inited on start()).
    const store = new SwmHostModeStore({ dataDir: join(dataDir, 'swm-host'), ...SwmHostModeStore.defaultLimits() });
    await store.init();
    g.swmHostModeStore = store;
    const signer = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'signer');
    g.localAgents.set(signer.agentAddress, signer);
    g.defaultAgentAddress = signer.agentAddress;
    return core;
  }

  // The publish envelope the host receives off gossip (numeric cg — the ACK
  // digest requires a numeric on-chain id). publisherPeerId === sender so the
  // anti-spoof bind passes.
  const publishEnvelope = (g: IngestInternals, cg: string) => g.encodeWorkspaceGossipMessage(cg, encodeWorkspacePublishRequest({
    contextGraphId: cg,
    nquads: new TextEncoder().encode(nquadFor(cg)),
    manifest: [],
    publisherPeerId: PEER,
    shareOperationId: `op-ack-${cg}`,
    timestampMs: 1_700_000_000_000,
    ...rootlessWorkspaceScope(g),
  }));

  // Read the SWM graph EXACTLY as StorageACKHandler.loadSWMQuads does.
  async function readSwmQuads(core: DKGAgent, cg: string) {
    const swmGraphUri = `did:dkg:context-graph:${cg}/_shared_memory`;
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } ${sharedMemoryReadBothFilter(swmGraphUri)} }`;
    const res = await core.store.query(sparql);
    return res.type === 'quads' ? res.quads : [];
  }

  function ackHandler(core: DKGAgent, signer: ethers.Wallet) {
    return new StorageACKHandler(core.store as any, {
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: signer,
      contextGraphSharedMemoryUri: (id: string) => `did:dkg:context-graph:${id}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    }, new TypedEventBus() as any);
  }

  it('CONFIRMED-PUBLIC: real ingest applies plaintext to _shared_memory → host signs a quorum-eligible ACK (not NO_DATA)', async () => {
    const core = await makeHostCore();
    const g = core as unknown as IngestInternals;
    const cg = '4242001';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 1 });

    // The REAL ingest path — NOT a direct store.insert.
    const env = await publishEnvelope(g, cg);
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);

    // 1) The plaintext landed in the ACK-readable SWM scope (empty pre-fix).
    const quads = await readSwmQuads(core, cg);
    expect(quads.length).toBe(1);
    expect(quads[0].subject).toBe('urn:ack1124:s');
    expect(quads[0].object).toContain('AckCapable1124');

    // 2) A REAL StorageACKHandler over the SAME store now signs an ACK. The
    //    publisher's claimed root = the flat-KC root over those quads (what a
    //    publisher that published this KA would submit); the host recomputes
    //    over its applied copy and they match by construction.
    const merkleRoot = computeFlatKCRootV10(quads, []);
    const leafCount = computeFlatKCMerkleLeafCountV10(quads, []);
    const byteSize = new TextEncoder().encode(nquadFor(cg)).length;
    const signer = ethers.Wallet.createRandom();
    const intent = encodePublishIntent({
      merkleRoot, contextGraphId: cg, publisherPeerId: PEER,
      publicByteSize: byteSize, isPrivate: false, kaCount: 1,
      rootEntities: [], merkleLeafCount: leafCount,
      ...rootlessWorkspaceScope(g),
    });
    const ack = decodeStorageACK(await ackHandler(core, signer).handler(intent, { toString: () => PEER }));

    expect(isStorageACKDecline(ack)).toBe(false);
    // The ACK is a real EIP-191 signature over the canonical V10 digest.
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID, TEST_KAV10_ADDR, BigInt(cg), merkleRoot,
      1n, BigInt(byteSize), 1n, 0n, BigInt(leafCount),
    );
    const recovered = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('CURATED (accessPolicy 1): real ingest does NOT apply → _shared_memory empty → StorageACKHandler DECLINEs NO_DATA', async () => {
    const core = await makeHostCore();
    const g = core as unknown as IngestInternals;
    const cg = '4242002';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 1, publishPolicy: 0 });

    const env = await publishEnvelope(g, cg);
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);

    expect((await readSwmQuads(core, cg)).length).toBe(0);
    const signer = ethers.Wallet.createRandom();
    const intent = encodePublishIntent({
      merkleRoot: new Uint8Array(32), contextGraphId: cg, publisherPeerId: PEER,
      publicByteSize: 10, isPrivate: false, kaCount: 1, rootEntities: ['urn:ack1124:s'],
    });
    const ack = decodeStorageACK(await ackHandler(core, signer).handler(intent, { toString: () => PEER }));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
  });

  it('PUBLIC READ but RESTRICTED PUBLISH (accessPolicy 0, publishPolicy 0): real ingest does NOT apply → NO_DATA (the #1239-r3 case)', async () => {
    // The case a naive accessPolicy-only check would miss: readable ≠ self-
    // publishable. The apply must stay gated on BOTH axes (publishPolicy===1).
    const core = await makeHostCore();
    const g = core as unknown as IngestInternals;
    const cg = '4242003';
    g.getContextGraphOnChainPolicy = async () => ({ accessPolicy: 0, publishPolicy: 0 });

    const env = await publishEnvelope(g, cg);
    await g.ingestSwmHostModeEnvelope(cg, env, PEER);

    expect((await readSwmQuads(core, cg)).length).toBe(0);
    const signer = ethers.Wallet.createRandom();
    const intent = encodePublishIntent({
      merkleRoot: new Uint8Array(32), contextGraphId: cg, publisherPeerId: PEER,
      publicByteSize: 10, isPrivate: false, kaCount: 1, rootEntities: ['urn:ack1124:s'],
    });
    const ack = decodeStorageACK(await ackHandler(core, signer).handler(intent, { toString: () => PEER }));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
  });
});
