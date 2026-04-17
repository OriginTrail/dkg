import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  DKGAgentWallet,
  buildAgentProfile,
  CclEvaluator,
  DiscoveryClient,
  ProfileManager,
  encrypt,
  decrypt,
  ed25519ToX25519Private,
  ed25519ToX25519Public,
  x25519SharedSecret,
  DKGAgent,
  AGENT_REGISTRY_CONTEXT_GRAPH,
  parseCclPolicy,
} from '../src/index.js';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, SYSTEM_PARANETS, DKG_ONTOLOGY, paranetDataGraphUri, paranetWorkspaceGraphUri, sparqlString } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { sha256 } from '@noble/hashes/sha2.js';
import { EVMChainAdapter, MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Evaluator: ReferenceEvaluator, loadYaml } = require(fileURLToPath(new URL('../../../ccl_v0_1/evaluator/reference_evaluator.js', import.meta.url)));
const CCL_FACT_NS = 'https://example.org/ccl-fact#';

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

function buildSnapshotFactQuads(opts: {
  paranetId: string;
  snapshotId: string;
  view: 'accepted' | 'workspace';
  scopeUal?: string;
  facts: Array<[string, ...unknown[]]>;
}): Quad[] {
  const graph = opts.view === 'workspace'
    ? paranetWorkspaceGraphUri(opts.paranetId)
    : paranetDataGraphUri(opts.paranetId);

  return opts.facts.flatMap((fact, index) => {
    const [predicate, ...args] = fact;
    const subject = `did:dkg:ccl-fact:${opts.paranetId}:${opts.snapshotId}:${index}`;
    const quads: Quad[] = [
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: `${CCL_FACT_NS}InputFact`, graph },
      { subject, predicate: `${CCL_FACT_NS}predicate`, object: sparqlString(predicate), graph },
      { subject, predicate: DKG_ONTOLOGY.DKG_SNAPSHOT_ID, object: sparqlString(opts.snapshotId), graph },
      { subject, predicate: DKG_ONTOLOGY.DKG_VIEW, object: sparqlString(opts.view), graph },
    ];

    if (opts.scopeUal) {
      quads.push({ subject, predicate: DKG_ONTOLOGY.DKG_SCOPE_UAL, object: sparqlString(opts.scopeUal), graph });
    }

    args.forEach((arg, argIndex) => {
      quads.push({
        subject,
        predicate: `${CCL_FACT_NS}arg${argIndex}`,
        object: sparqlString(JSON.stringify(arg)),
        graph,
      });
    });

    return quads;
  });
}


describe('AgentWallet', () => {
  it('generates a wallet with keypair', async () => {
    const wallet = await DKGAgentWallet.generate();
    expect(wallet.masterKey).toHaveLength(32);
    expect(wallet.keypair.secretKey).toBeDefined();
    expect(wallet.keypair.publicKey).toBeDefined();
    expect(wallet.peerId()).toBeDefined();
  });

  it('signs with Ed25519 master key', async () => {
    const wallet = await DKGAgentWallet.generate();
    const sig = await wallet.sign(new TextEncoder().encode('test'));
    expect(sig).toHaveLength(64);
  });

  it('saves and loads wallet from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-wallet-'));
    try {
      const wallet = await DKGAgentWallet.generate();
      await wallet.save(dir);

      const keyFile = await readFile(join(dir, 'agent-key.bin'));
      expect(keyFile).toHaveLength(32);

      const loaded = await DKGAgentWallet.load(dir);
      expect(Buffer.from(loaded.masterKey).toString('hex')).toBe(
        Buffer.from(wallet.masterKey).toString('hex'),
      );

      expect(loaded.peerId()).toBe(wallet.peerId());

      expect(Buffer.from(loaded.keypair.secretKey).toString('hex')).toBe(
        Buffer.from(wallet.keypair.secretKey).toString('hex'),
      );
      expect(Buffer.from(loaded.keypair.publicKey).toString('hex')).toBe(
        Buffer.from(wallet.keypair.publicKey).toString('hex'),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('fromMasterKey produces same peerId and keypair', async () => {
    const wallet = await DKGAgentWallet.generate();
    const restored = await DKGAgentWallet.fromMasterKey(wallet.masterKey);
    expect(restored.peerId()).toBe(wallet.peerId());
    expect(Buffer.from(restored.keypair.secretKey).toString('hex')).toBe(
      Buffer.from(wallet.keypair.secretKey).toString('hex'),
    );
    expect(Buffer.from(restored.keypair.publicKey).toString('hex')).toBe(
      Buffer.from(wallet.keypair.publicKey).toString('hex'),
    );
  });

  it('DKGAgent.create() persists identity across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-agent-persist-'));
    try {
      const agent1 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
      const peerId1 = agent1.wallet.keypair.publicKey;

      const agent2 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
      const peerId2 = agent2.wallet.keypair.publicKey;

      expect(Buffer.from(peerId2).toString('hex')).toBe(
        Buffer.from(peerId1).toString('hex'),
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('different wallets produce different peerIds', async () => {
    const a = await DKGAgentWallet.generate();
    const b = await DKGAgentWallet.generate();
    expect(a.peerId()).not.toBe(b.peerId());
  });
});

describe('Profile Builder', () => {
  it('builds agent profile quads', () => {
    const { quads, rootEntity } = buildAgentProfile({
      peerId: 'QmTest123',
      name: 'TestBot',
      description: 'A test agent',
      framework: 'OpenClaw',
      skills: [
        {
          skillType: 'ImageAnalysis',
          pricePerCall: 0.5,
          currency: 'TRAC',
          successRate: 0.95,
          pricingModel: 'PerInvocation',
        },
      ],
    });

    expect(rootEntity).toBe('did:dkg:agent:QmTest123');
    expect(quads.length).toBeGreaterThanOrEqual(8);

    const subjects = quads.map(q => q.subject);
    expect(subjects).toContain('did:dkg:agent:QmTest123');
    expect(subjects).toContain('did:dkg:agent:QmTest123/.well-known/genid/offering1');

    const predicates = quads.map(q => q.predicate);
    expect(predicates).toContain('https://schema.org/name');
    expect(predicates).toContain('https://dkg.origintrail.io/skill#offersSkill');
    expect(predicates).toContain('https://dkg.origintrail.io/skill#skill');
  });

  it('handles multiple skills', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmMulti',
      name: 'MultiBot',
      skills: [
        { skillType: 'ImageAnalysis' },
        { skillType: 'TextAnalysis' },
      ],
    });

    const offeringSubjects = quads.filter(
      q => q.predicate === 'https://dkg.origintrail.io/skill#offersSkill',
    );
    expect(offeringSubjects).toHaveLength(2);
  });

  it('all quads target the agent-registry graph', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmGraph',
      name: 'GraphBot',
      skills: [{ skillType: 'CodeGeneration' }],
    });

    for (const q of quads) {
      expect(q.graph).toBe('did:dkg:context-graph:agents');
    }
  });

  it('includes hosting profile when contextGraphsServed is set', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmHost',
      name: 'HostBot',
      skills: [],
      contextGraphsServed: ['agent-skills', 'climate'],
    });

    const hostingQuads = quads.filter(q =>
      q.predicate === 'https://dkg.origintrail.io/skill#hostingProfile',
    );
    expect(hostingQuads).toHaveLength(1);

    const contextGraphsQuad = quads.find(q =>
      q.predicate === 'https://dkg.origintrail.io/skill#contextGraphsServed',
    );
    expect(contextGraphsQuad).toBeDefined();
    expect(contextGraphsQuad!.object).toContain('agent-skills,climate');
  });

  it('omits optional fields when not provided', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmMinimal',
      name: 'MinimalBot',
      skills: [],
    });

    const descQuads = quads.filter(q => q.predicate === 'http://schema.org/description');
    expect(descQuads).toHaveLength(0);

    const frameworkQuads = quads.filter(q =>
      q.predicate === 'https://dkg.origintrail.io/skill#framework',
    );
    expect(frameworkQuads).toHaveLength(0);
  });
});

describe('ProfileManager', () => {
  it('publishes a profile as a KC via the Publisher', async () => {
    const store = new OxigraphStore();
    const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
    const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({ store, chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP), eventBus, keypair });

    const manager = new ProfileManager(publisher, store);
    const result = await manager.publishProfile({
      peerId: 'QmManaged',
      name: 'ManagedBot',
      framework: 'LangChain',
      skills: [{ skillType: 'Translation', pricePerCall: 0.3, currency: 'TRAC' }],
    });

    expect(result.kcId).toBeDefined();
    expect(result.kaManifest.length).toBeGreaterThan(0);
    expect(manager.profileKcId).toBe(result.kcId);
  });

  it('cleans up stale profile triples before re-publishing', async () => {
    const store = new OxigraphStore();
    const { DKGPublisher } = await import('@origintrail-official/dkg-publisher');
    const { TypedEventBus, generateEd25519Keypair } = await import('@origintrail-official/dkg-core');
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({ store, chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP), eventBus, keypair });

    const manager = new ProfileManager(publisher, store);

    // First publish
    await manager.publishProfile({
      peerId: 'QmStale',
      name: 'OldName',
      framework: 'DKG',
      skills: [],
    });

    // Verify OldName is stored in the data graph
    const graph = 'did:dkg:context-graph:agents';
    const oldCount = await store.countQuads(graph);
    expect(oldCount).toBeGreaterThan(0);

    // Second publish with different name — should replace, not accumulate
    await manager.publishProfile({
      peerId: 'QmStale',
      name: 'NewName',
      framework: 'DKG',
      skills: [],
    });

    const newCount = await store.countQuads(graph);

    // Data graph triple count should stay the same (old cleaned up, new inserted)
    expect(newCount).toBe(oldCount);

    // The data graph should contain NewName, not OldName
    const result = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      const nameTriples = result.bindings.filter(b => b['p']?.includes('schema.org/name'));
      expect(nameTriples.length).toBeGreaterThan(0);
      expect(nameTriples.some(b => b['o'] === '"NewName"')).toBe(true);
      expect(nameTriples.every(b => b['o'] !== '"OldName"')).toBe(true);
    }
  });
});

describe('Discovery Client', () => {
  it('finds agents by querying local store', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const { quads } = buildAgentProfile({
      peerId: 'QmDiscoverable',
      name: 'DiscoverableBot',
      framework: 'ElizaOS',
      skills: [{ skillType: 'ImageAnalysis', pricePerCall: 1.0, currency: 'TRAC' }],
    });

    await store.insert(quads);

    const agents = await discovery.findAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('DiscoverableBot');
    expect(agents[0].peerId).toBe('QmDiscoverable');
  });

  it('finds skill offerings', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const { quads } = buildAgentProfile({
      peerId: 'QmSkilled',
      name: 'SkilledBot',
      skills: [
        { skillType: 'ImageAnalysis', pricePerCall: 0.5, currency: 'TRAC', successRate: 0.99 },
      ],
    });

    await store.insert(quads);

    const offerings = await discovery.findSkillOfferings({ skillType: 'ImageAnalysis' });
    expect(offerings).toHaveLength(1);
    expect(offerings[0].agentName).toBe('SkilledBot');
    expect(offerings[0].skillType).toBe('ImageAnalysis');
  });

  it('finds agent by peerId', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const { quads } = buildAgentProfile({
      peerId: 'QmFindMe',
      name: 'FindMeBot',
      skills: [],
    });

    await store.insert(quads);

    const agent = await discovery.findAgentByPeerId('QmFindMe');
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe('FindMeBot');

    const notFound = await discovery.findAgentByPeerId('QmNonExistent');
    expect(notFound).toBeNull();
  });

  it('returns relayAddress when present in profile', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const relayAddr = '/ip4/1.2.3.4/tcp/9090/p2p/QmRelay';
    const { quads } = buildAgentProfile({
      peerId: 'QmWithRelay',
      name: 'RelayBot',
      skills: [],
      relayAddress: relayAddr,
    });

    await store.insert(quads);

    const agents = await discovery.findAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].relayAddress).toBe(relayAddr);

    const byPeerId = await discovery.findAgentByPeerId('QmWithRelay');
    expect(byPeerId).not.toBeNull();
    expect(byPeerId!.relayAddress).toBe(relayAddr);

    // Agent without relayAddress should have undefined
    const store2 = new OxigraphStore();
    const engine2 = new DKGQueryEngine(store2);
    const discovery2 = new DiscoveryClient(engine2);
    const { quads: q2 } = buildAgentProfile({
      peerId: 'QmNoRelay',
      name: 'NoRelayBot',
      skills: [],
    });
    await store2.insert(q2);
    const agents2 = await discovery2.findAgents();
    expect(agents2[0].relayAddress).toBeUndefined();
  });

  it('filters agents by framework', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const { quads: q1 } = buildAgentProfile({
      peerId: 'QmOC', name: 'OCBot', framework: 'OpenClaw', skills: [],
    });
    const { quads: q2 } = buildAgentProfile({
      peerId: 'QmEL', name: 'ELBot', framework: 'ElizaOS', skills: [],
    });

    await store.insert([...q1, ...q2]);

    const ocAgents = await discovery.findAgents({ framework: 'OpenClaw' });
    expect(ocAgents).toHaveLength(1);
    expect(ocAgents[0].name).toBe('OCBot');
  });

  it('returns empty when no agents in store', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const discovery = new DiscoveryClient(engine);

    const agents = await discovery.findAgents();
    expect(agents).toHaveLength(0);

    const offerings = await discovery.findSkillOfferings();
    expect(offerings).toHaveLength(0);
  });
});

describe('Encryption', () => {
  it('encrypts and decrypts with XChaCha20-Poly1305', () => {
    const key = sha256(new TextEncoder().encode('test-key'));
    const plaintext = new TextEncoder().encode('Hello, encrypted world!');

    const { ciphertext, nonce } = encrypt(key, plaintext);
    expect(ciphertext).not.toEqual(plaintext);
    expect(nonce).toHaveLength(24);

    const decrypted = decrypt(key, ciphertext, nonce);
    expect(new TextDecoder().decode(decrypted)).toBe('Hello, encrypted world!');
  });

  it('derives X25519 keys from Ed25519', async () => {
    const wallet = await DKGAgentWallet.generate();
    const x25519Priv = ed25519ToX25519Private(wallet.keypair.secretKey);
    const x25519Pub = ed25519ToX25519Public(wallet.keypair.publicKey);

    expect(x25519Priv).toHaveLength(32);
    expect(x25519Pub).toHaveLength(32);
  });

  it('X25519 key agreement produces shared secret', async () => {
    const walletA = await DKGAgentWallet.generate();
    const walletB = await DKGAgentWallet.generate();

    const privA = ed25519ToX25519Private(walletA.keypair.secretKey);
    const pubA = ed25519ToX25519Public(walletA.keypair.publicKey);
    const privB = ed25519ToX25519Private(walletB.keypair.secretKey);
    const pubB = ed25519ToX25519Public(walletB.keypair.publicKey);

    const sharedAB = x25519SharedSecret(privA, pubB);
    const sharedBA = x25519SharedSecret(privB, pubA);

    expect(sharedAB).toHaveLength(32);
    expect(Buffer.from(sharedAB).toString('hex')).toBe(Buffer.from(sharedBA).toString('hex'));
  });

  it('decrypt with wrong key fails', () => {
    const key = sha256(new TextEncoder().encode('correct-key'));
    const wrongKey = sha256(new TextEncoder().encode('wrong-key'));
    const plaintext = new TextEncoder().encode('secret');

    const { ciphertext, nonce } = encrypt(key, plaintext);
    expect(() => decrypt(wrongKey, ciphertext, nonce)).toThrow();
  });

  it('encrypts empty payload', () => {
    const key = sha256(new TextEncoder().encode('key'));
    const { ciphertext, nonce } = encrypt(key, new Uint8Array(0));
    const decrypted = decrypt(key, ciphertext, nonce);
    expect(decrypted).toHaveLength(0);
  });

  it('encrypts large payload', () => {
    const key = sha256(new TextEncoder().encode('key'));
    const large = new Uint8Array(100_000).fill(42);
    const { ciphertext, nonce } = encrypt(key, large);
    const decrypted = decrypt(key, ciphertext, nonce);
    expect(decrypted).toHaveLength(100_000);
    expect(decrypted[0]).toBe(42);
    expect(decrypted[99_999]).toBe(42);
  });
});

describe('PeerId key extraction', () => {
  it('extracts Ed25519 public key from libp2p PeerId', async () => {
    const agent = await DKGAgent.create({
      name: 'KeyTest',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();

    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(agent.peerId);
    const digest = peerId.toMultihash().digest;

    // Ed25519 PeerId protobuf: [08 01 12 20 <32 bytes of Ed25519 public key>]
    expect(digest[0]).toBe(0x08);
    expect(digest[1]).toBe(0x01);
    expect(digest[2]).toBe(0x12);
    expect(digest[3]).toBe(0x20);

    const extractedKey = digest.slice(4, 36);
    expect(extractedKey.length).toBe(32);
    expect(Buffer.from(extractedKey).toString('hex')).toBe(
      Buffer.from(agent.wallet.keypair.publicKey).toString('hex'),
    );

    await agent.stop();
  }, 10000);
});

describe('DKGAgent (integration)', () => {
  it('creates an agent with the facade API', async () => {
    const agent = await DKGAgent.create({
      name: 'TestAgent',
      framework: 'OpenClaw',
      skills: [
        {
          skillType: 'ImageAnalysis',
          pricePerCall: 1.0,
          handler: async () => ({ success: true, outputData: new Uint8Array([42]) }),
        },
      ],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    expect(agent.wallet).toBeDefined();
    expect(agent.publisher).toBeDefined();
    expect(agent.queryEngine).toBeDefined();
    expect(agent.discovery).toBeDefined();
  });

  it('starts, publishes profile, discovers self, and stops', async () => {
    const agent = await DKGAgent.create({
      name: 'SelfDiscoverer',
      framework: 'DKG',
      listenPort: 0,
      skills: [
        {
          skillType: 'TextAnalysis',
          pricePerCall: 0.1,
          handler: async () => ({ success: true }),
        },
      ],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    await agent.start();

    const result = await agent.publishProfile();
    expect(result.kcId).toBeDefined();
    expect(result.kaManifest.length).toBeGreaterThan(0);

    const agents = await agent.findAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents[0].name).toBe('SelfDiscoverer');

    const offerings = await agent.findSkills({ skillType: 'TextAnalysis' });
    expect(offerings.length).toBeGreaterThanOrEqual(1);

    await agent.stop();
  }, 10000);
});

describe('Genesis Knowledge', () => {
  it('produces deterministic genesis quads', () => {
    const quads = getGenesisQuads();
    expect(quads.length).toBeGreaterThan(20);

    const networkDef = quads.filter(q => q.subject === 'did:dkg:network:v9-testnet');
    expect(networkDef.length).toBeGreaterThan(0);

    const agentsParanet = quads.filter(q => q.graph === 'did:dkg:context-graph:agents');
    expect(agentsParanet.length).toBeGreaterThan(0);

    const ontology = quads.filter(q => q.graph === 'did:dkg:context-graph:ontology');
    expect(ontology.length).toBeGreaterThan(0);
  });

  it('computes a stable networkId', async () => {
    const id1 = await computeNetworkId();
    const id2 = await computeNetworkId();
    expect(id1).toBe(id2);
    expect(id1.length).toBe(64);
  });

  it('loads genesis into store on DKGAgent.create()', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'GenesisTest',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }

    const paranets = await store.query(
      `SELECT ?p WHERE { <did:dkg:context-graph:agents> a <https://dkg.network/ontology#SystemParanet> }`,
    );
    expect(paranets.type).toBe('bindings');

    await agent.stop().catch(() => {});
  });

  it('genesis loading is idempotent', async () => {
    const store = new OxigraphStore();
    const agent1 = await DKGAgent.create({ name: 'Idempotent1', store, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
    const agent2 = await DKGAgent.create({ name: 'Idempotent2', store, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });

    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
    );
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }

    await agent1.stop().catch(() => {});
    await agent2.stop().catch(() => {});
  });

  it('publishes, approves, lists, and resolves CCL policies per paranet', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'PolicyBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();

    await agent.createContextGraph({ id: 'ops-policy', name: 'Ops Policy' });

    const published = await agent.publishCclPolicy({
      paranetId: 'ops-policy',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });

    expect(published.policyUri).toContain('did:dkg:policy:');
    expect(published.hash).toContain('sha256:');

    await agent.approveCclPolicy({ paranetId: 'ops-policy', policyUri: published.policyUri });

    const listed = await agent.listCclPolicies({ paranetId: 'ops-policy' });
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('incident-review');
    expect(listed[0].isActiveDefault).toBe(true);

    const resolved = await agent.resolveCclPolicy({ paranetId: 'ops-policy', name: 'incident-review', includeBody: true });
    expect(resolved?.policyUri).toBe(published.policyUri);
    expect(resolved?.body).toContain('rules: []');

    const evaluation = await agent.evaluateCclPolicy({
      paranetId: 'ops-policy',
      name: 'incident-review',
      facts: [['claim', 'c1']],
      snapshotId: 'snap-1',
    });
    expect(evaluation.policy.policyUri).toBe(published.policyUri);
    expect(evaluation.factSetHash).toContain('sha256:');
    expect(evaluation.result.derived).toEqual({});

    const publishedEval = await agent.evaluateAndPublishCclPolicy({
      paranetId: 'ops-policy',
      name: 'incident-review',
      facts: [['claim', 'c1']],
      snapshotId: 'snap-2',
    });
    expect(publishedEval.evaluationUri).toContain('did:dkg:ccl-eval:');
    expect(publishedEval.publish.status).toBeDefined();

    const storedEval = await store.query(
      `SELECT ?hash WHERE { GRAPH <did:dkg:context-graph:ops-policy> { <${publishedEval.evaluationUri}> <https://dkg.network/ontology#factSetHash> ?hash } }`,
    );
    expect(storedEval.type).toBe('bindings');
    if (storedEval.type === 'bindings') {
      expect(storedEval.bindings.length).toBe(1);
    }

    const listedEvals = await agent.listCclEvaluations({
      paranetId: 'ops-policy',
      snapshotId: 'snap-2',
    });
    expect(listedEvals).toHaveLength(1);
    expect(listedEvals[0].evaluationUri).toBe(publishedEval.evaluationUri);
    expect(listedEvals[0].results).toEqual([]);

    await agent.stop().catch(() => {});
  });

  it('prefers stricter per-context policy overrides when resolving CCL policy', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'ContextPolicyBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();

    await agent.createContextGraph({ id: 'ops-context', name: 'Ops Context' });

    const base = await agent.publishCclPolicy({
      paranetId: 'ops-context',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });
    await agent.approveCclPolicy({ paranetId: 'ops-context', policyUri: base.policyUri });

    const override = await agent.publishCclPolicy({
      paranetId: 'ops-context',
      name: 'incident-review',
      version: '0.2.0',
      contextType: 'incident_review',
      content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
    });
    await agent.approveCclPolicy({ paranetId: 'ops-context', policyUri: override.policyUri, contextType: 'incident_review' });

    const resolvedDefault = await agent.resolveCclPolicy({ paranetId: 'ops-context', name: 'incident-review' });
    expect(resolvedDefault?.policyUri).toBe(base.policyUri);

    const resolvedContext = await agent.resolveCclPolicy({ paranetId: 'ops-context', name: 'incident-review', contextType: 'incident_review' });
    expect(resolvedContext?.policyUri).toBe(override.policyUri);
    expect(resolvedContext?.activeContexts).toContain('incident_review');

    const evaluatedContext = await agent.evaluateCclPolicy({
      paranetId: 'ops-context',
      name: 'incident-review',
      contextType: 'incident_review',
      facts: [['claim', 'c2']],
    });
    expect(evaluatedContext.policy.policyUri).toBe(override.policyUri);

    const publishedContextEval = await agent.evaluateAndPublishCclPolicy({
      paranetId: 'ops-context',
      name: 'incident-review',
      contextType: 'incident_review',
      facts: [['claim', 'c2']],
      snapshotId: 'snap-ctx',
    });
    const listedByContext = await agent.listCclEvaluations({
      paranetId: 'ops-context',
      contextType: 'incident_review',
      snapshotId: 'snap-ctx',
    });
    expect(listedByContext.some(entry => entry.evaluationUri === publishedContextEval.evaluationUri)).toBe(true);

    await agent.stop().catch(() => {});
  });

  it('falls back to the previous default policy after revoking a superseding binding', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'RevokeDefaultBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();

    await agent.createContextGraph({ id: 'ops-revoke-default', name: 'Ops Revoke Default' });

    const v1 = await agent.publishCclPolicy({
      paranetId: 'ops-revoke-default',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });
    const v2 = await agent.publishCclPolicy({
      paranetId: 'ops-revoke-default',
      name: 'incident-review',
      version: '0.2.0',
      content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
    });

    await agent.approveCclPolicy({ paranetId: 'ops-revoke-default', policyUri: v1.policyUri });
    await agent.approveCclPolicy({ paranetId: 'ops-revoke-default', policyUri: v2.policyUri });

    const resolvedLatest = await agent.resolveCclPolicy({ paranetId: 'ops-revoke-default', name: 'incident-review' });
    expect(resolvedLatest?.policyUri).toBe(v2.policyUri);

    const revoked = await agent.revokeCclPolicy({ paranetId: 'ops-revoke-default', policyUri: v2.policyUri });
    expect(revoked.status).toBe('revoked');

    const resolvedFallback = await agent.resolveCclPolicy({ paranetId: 'ops-revoke-default', name: 'incident-review' });
    expect(resolvedFallback?.policyUri).toBe(v1.policyUri);

    const listed = await agent.listCclPolicies({ paranetId: 'ops-revoke-default', name: 'incident-review' });
    const revokedRecord = listed.find(policy => policy.policyUri === v2.policyUri);
    const activeRecord = listed.find(policy => policy.policyUri === v1.policyUri);
    expect(revokedRecord?.status).toBe('revoked');
    expect(activeRecord?.status).toBe('approved');
    expect(activeRecord?.isActiveDefault).toBe(true);

    await agent.stop().catch(() => {});
  });

  it('falls back from a revoked context override to the default policy', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'RevokeContextBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();

    await agent.createContextGraph({ id: 'ops-revoke-context', name: 'Ops Revoke Context' });

    const base = await agent.publishCclPolicy({
      paranetId: 'ops-revoke-context',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });
    const override = await agent.publishCclPolicy({
      paranetId: 'ops-revoke-context',
      name: 'incident-review',
      version: '0.2.0',
      contextType: 'incident_review',
      content: `policy: incident-review
version: 0.2.0
rules: []
decisions: []
`,
    });

    await agent.approveCclPolicy({ paranetId: 'ops-revoke-context', policyUri: base.policyUri });
    await agent.approveCclPolicy({ paranetId: 'ops-revoke-context', policyUri: override.policyUri, contextType: 'incident_review' });

    const resolvedOverride = await agent.resolveCclPolicy({ paranetId: 'ops-revoke-context', name: 'incident-review', contextType: 'incident_review' });
    expect(resolvedOverride?.policyUri).toBe(override.policyUri);

    const revoked = await agent.revokeCclPolicy({
      paranetId: 'ops-revoke-context',
      policyUri: override.policyUri,
      contextType: 'incident_review',
    });
    expect(revoked.contextType).toBe('incident_review');

    const resolvedFallback = await agent.resolveCclPolicy({ paranetId: 'ops-revoke-context', name: 'incident-review', contextType: 'incident_review' });
    expect(resolvedFallback?.policyUri).toBe(base.policyUri);
    expect(resolvedFallback?.isActiveDefault).toBe(true);

    await agent.stop().catch(() => {});
  });

  it('restricts CCL policy approval to the paranet owner', async () => {
    const store = new OxigraphStore();
    const owner = await DKGAgent.create({
      name: 'OwnerBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const other = await DKGAgent.create({
      name: 'OtherBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    await owner.start();
    await other.start();
    await owner.createContextGraph({ id: 'ops-owner', name: 'Ops Owner' });

    const published = await owner.publishCclPolicy({
      paranetId: 'ops-owner',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });

    await expect(other.approveCclPolicy({ paranetId: 'ops-owner', policyUri: published.policyUri }))
      .rejects.toThrow(/Only the paranet owner can manage policies/);

    await expect(owner.approveCclPolicy({ paranetId: 'ops-owner', policyUri: published.policyUri }))
      .resolves.toBeTruthy();

    await owner.stop().catch(() => {});
    await other.stop().catch(() => {});
  });

  it('restricts CCL policy revocation to the paranet owner', async () => {
    const store = new OxigraphStore();
    const owner = await DKGAgent.create({
      name: 'OwnerRevokeBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const other = await DKGAgent.create({
      name: 'OtherRevokeBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    await owner.start();
    await other.start();
    await owner.createContextGraph({ id: 'ops-owner-revoke', name: 'Ops Owner Revoke' });

    const published = await owner.publishCclPolicy({
      paranetId: 'ops-owner-revoke',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });
    await owner.approveCclPolicy({ paranetId: 'ops-owner-revoke', policyUri: published.policyUri });

    await expect(other.revokeCclPolicy({ paranetId: 'ops-owner-revoke', policyUri: published.policyUri }))
      .rejects.toThrow(/Only the paranet owner can manage policies/);

    await expect(owner.revokeCclPolicy({ paranetId: 'ops-owner-revoke', policyUri: published.policyUri }))
      .resolves.toMatchObject({ status: 'revoked' });

    await owner.stop().catch(() => {});
    await other.stop().catch(() => {});
  });

  it('validates CCL policy content before publish', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'ValidateBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();
    await agent.createContextGraph({ id: 'ops-validate', name: 'Ops Validate' });

    await expect(agent.publishCclPolicy({
      paranetId: 'ops-validate',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: wrong-name
version: 0.1.0
rules: []
decisions: []
`,
    })).rejects.toThrow(/name mismatch/);

    await expect(agent.publishCclPolicy({
      paranetId: 'ops-validate',
      name: 'incident-review',
      version: '0.1.0',
      content: 'rules: []',
    })).rejects.toThrow(/must define a string "policy" name/);

    await agent.stop().catch(() => {});
  });

  it('rejects conflicting CCL republish for the same name and version', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'CollisionBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();
    await agent.createContextGraph({ id: 'ops-collision', name: 'Ops Collision' });

    await agent.publishCclPolicy({
      paranetId: 'ops-collision',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules: []
decisions: []
`,
    });

    await expect(agent.publishCclPolicy({
      paranetId: 'ops-collision',
      name: 'incident-review',
      version: '0.1.0',
      content: `policy: incident-review
version: 0.1.0
rules:
  - name: flagged
    params: [Claim]
    all:
      - atom: { pred: claim, args: ["$Claim"] }
decisions: []
`,
    })).rejects.toThrow(/already exists with different content/);

    await agent.stop().catch(() => {});
  });

  it('resolves canonical snapshot facts and evaluates bundled policies without caller facts', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotBot',
      store,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    await agent.start();
    await agent.createContextGraph({ id: 'ops-snapshot', name: 'Ops Snapshot' });

    const published = await agent.publishCclPolicy({
      paranetId: 'ops-snapshot',
      name: 'owner_assertion',
      version: '0.1.0',
      content: `policy: owner_assertion
version: 0.1.0
rules:
  - name: owner_asserted
    params: [Claim]
    all:
      - atom: { pred: claim, args: ["$Claim"] }
      - exists:
          where:
            - atom: { pred: owner_of, args: ["$Claim", "$Agent"] }
            - atom: { pred: signed_by, args: ["$Claim", "$Agent"] }
decisions:
  - name: propose_accept
    params: [Claim]
    all:
      - atom: { pred: owner_asserted, args: ["$Claim"] }
`,
    });
    await agent.approveCclPolicy({ paranetId: 'ops-snapshot', policyUri: published.policyUri });

    await store.insert(buildSnapshotFactQuads({
      paranetId: 'ops-snapshot',
      snapshotId: 'snap-owner-01',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
      facts: [
        ['signed_by', 'p1', '0xalice'],
        ['claim', 'p1'],
        ['owner_of', 'p1', '0xalice'],
      ],
    }));

    const resolved = await agent.resolveFactsFromSnapshot({
      paranetId: 'ops-snapshot',
      policyName: 'owner_assertion',
      snapshotId: 'snap-owner-01',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
    });

    expect(resolved.factResolutionMode).toBe('snapshot-resolved');
    expect(resolved.factResolverVersion).toBe('canonical-input-facts/v1');
    expect(resolved.facts).toEqual([
      ['claim', 'p1'],
      ['owner_of', 'p1', '0xalice'],
      ['signed_by', 'p1', '0xalice'],
    ]);

    const evaluation = await agent.evaluateCclPolicy({
      paranetId: 'ops-snapshot',
      name: 'owner_assertion',
      snapshotId: 'snap-owner-01',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
    });

    expect(evaluation.factResolutionMode).toBe('snapshot-resolved');
    expect(evaluation.factQueryHash).toContain('sha256:');
    expect(evaluation.result.derived.owner_asserted).toEqual([['p1']]);
    expect(evaluation.result.decisions.propose_accept).toEqual([['p1']]);

    await agent.stop().catch(() => {});
  });

  it('resolves the same snapshot facts deterministically across nodes', async () => {
    const snapshotFacts: Array<[string, ...unknown[]]> = [
      ['signed_by', 'p1', '0xalice'],
      ['claim', 'p1'],
      ['owner_of', 'p1', '0xalice'],
    ];
    const quads = buildSnapshotFactQuads({
      paranetId: 'ops-deterministic',
      snapshotId: 'snap-owner-02',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
      facts: snapshotFacts,
    });

    const storeA = new OxigraphStore();
    const storeB = new OxigraphStore();
    await storeA.insert(quads);
    await storeB.insert(quads);

    const agentA = await DKGAgent.create({ name: 'DeterministicA', store: storeA, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });
    const agentB = await DKGAgent.create({ name: 'DeterministicB', store: storeB, chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP) });

    const resolvedA = await agentA.resolveFactsFromSnapshot({
      paranetId: 'ops-deterministic',
      policyName: 'owner_assertion',
      snapshotId: 'snap-owner-02',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
    });
    const resolvedB = await agentB.resolveFactsFromSnapshot({
      paranetId: 'ops-deterministic',
      policyName: 'owner_assertion',
      snapshotId: 'snap-owner-02',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:owner-assertion',
    });

    expect(resolvedA.facts).toEqual(resolvedB.facts);
    expect(resolvedA.factSetHash).toBe(resolvedB.factSetHash);
    expect(resolvedA.factQueryHash).toBe(resolvedB.factQueryHash);
    expect(resolvedA.factResolverVersion).toBe(resolvedB.factResolverVersion);
  });

  it('matches the reference evaluator across bundled CCL cases', async () => {
    const casesDir = fileURLToPath(new URL('../../../ccl_v0_1/tests/cases', import.meta.url));
    const policiesDir = fileURLToPath(new URL('../../../ccl_v0_1/policies', import.meta.url));
    const caseFiles = (await readdir(casesDir)).filter(name => name.endsWith('.yaml')).sort();

    for (const caseFile of caseFiles) {
      const testCase = loadYaml(join(casesDir, caseFile));
      const policyBody = await readFile(join(policiesDir, testCase.policy), 'utf8');
      const parsed = parseCclPolicy(policyBody);
      const agentResult = new CclEvaluator(parsed, testCase.facts).run();
      const referenceResult = new ReferenceEvaluator(parsed, testCase.facts).run();
      expect(agentResult).toEqual(referenceResult);
      expect(agentResult).toEqual(testCase.expected);
    }
  });
});

describe('Node Roles', () => {
  it('profile includes node role and ontology types', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmEdge',
      name: 'EdgeBot',
      nodeRole: 'edge',
      skills: [],
    });

    const types = quads
      .filter(q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
      .map(q => q.object);
    expect(types).toContain('https://dkg.network/ontology#Agent');
    expect(types).toContain('https://dkg.network/ontology#EdgeNode');

    const roles = quads.filter(q => q.predicate === 'https://dkg.network/ontology#nodeRole');
    expect(roles.length).toBe(1);
    expect(roles[0].object).toBe('"edge"');
  });

  it('core node profile uses CoreNode type', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmCore',
      name: 'CoreBot',
      nodeRole: 'core',
      skills: [],
    });

    const types = quads
      .filter(q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
      .map(q => q.object);
    expect(types).toContain('https://dkg.network/ontology#CoreNode');
  });

  it('profile includes PROV provenance activity', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmProv',
      name: 'ProvBot',
      skills: [],
    });

    const provTriples = quads.filter(q =>
      q.predicate === 'http://www.w3.org/ns/prov#wasGeneratedBy',
    );
    expect(provTriples.length).toBe(1);

    const activityUri = provTriples[0].object;
    const activityType = quads.find(
      q => q.subject === activityUri &&
        q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    expect(activityType?.object).toBe('http://www.w3.org/ns/prov#Activity');
  });

  it('profile includes ERC-8004 capabilities for skills', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmSkills',
      name: 'SkillBot',
      skills: [{ skillType: 'ImageAnalysis' }],
    });

    const caps = quads.filter(q =>
      q.predicate === 'https://eips.ethereum.org/erc-8004#capabilities',
    );
    expect(caps.length).toBe(1);

    const capType = quads.find(
      q => q.subject === caps[0].object &&
        q.object === 'https://eips.ethereum.org/erc-8004#Capability',
    );
    expect(capType).toBeDefined();
  });
});

describe('DKGAgent config — syncContextGraphs and queryAccess warning', () => {
  it('DKGAgentConfig accepts syncContextGraphs array', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncConfigTest',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      syncContextGraphs: ['my-custom-paranet', 'another-paranet'],
    });
    expect(agent).toBeDefined();
    await agent.stop().catch(() => {});
  });

  it('adds runtime subscriptions to sync scope', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeSyncScope',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    try {
      await agent.start();
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain('runtime-paranet');

      agent.subscribeToContextGraph('runtime-paranet');

      expect((agent as any).config.syncContextGraphs ?? []).toContain('runtime-paranet');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not add discovery subscriptions to sync scope when tracking is disabled', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeSyncScopeNoTrack',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    try {
      await agent.start();
      expect((agent as any).config.syncContextGraphs ?? []).not.toContain('discovered-paranet');

      agent.subscribeToContextGraph('discovered-paranet', { trackSyncScope: false });

      expect((agent as any).config.syncContextGraphs ?? []).not.toContain('discovered-paranet');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('syncContextGraphFromConnectedPeers returns empty stats without peers', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeCatchupNoPeers',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });

    try {
      await agent.start();
      agent.subscribeToContextGraph('runtime-paranet');
      const result = await agent.syncContextGraphFromConnectedPeers('runtime-paranet', {
        includeSharedMemory: true,
      });

      expect(result.connectedPeers).toBe(0);
      expect(result.syncCapablePeers).toBe(0);
      expect(result.peersTried).toBe(0);
      expect(result.dataSynced).toBe(0);
      expect(result.sharedMemorySynced).toBe(0);
      expect(result.diagnostics.noProtocolPeers).toBe(0);
      expect(result.diagnostics.durable.emptyResponses).toBe(0);
      expect(result.diagnostics.sharedMemory.emptyResponses).toBe(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('syncContextGraphFromConnectedPeers retries until sync protocol is visible', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeCatchupProtocolRetry',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      agent.subscribeToContextGraph('runtime-paranet');

      const remotePeer = agent.node.peerId;
      vi.spyOn(agent.node.libp2p, 'getConnections').mockReturnValue([
        { remotePeer } as any,
      ]);

      let peerStoreReads = 0;
      vi.spyOn(agent.node.libp2p.peerStore, 'get').mockImplementation(async () => {
        peerStoreReads += 1;
        if (peerStoreReads < 3) {
          return { protocols: [] } as any;
        }
        return { protocols: [PROTOCOL_SYNC] } as any;
      });

      // `syncContextGraphFromConnectedPeers` dispatches through the private
      // `*Detailed` variants (see packages/agent/src/dkg-agent.ts #1441/1453)
      // because it consumes the per-phase diagnostics, not just the plain
      // `insertedTriples` count exposed by `syncFromPeer` / `syncSharedMemoryFromPeer`.
      // Mock those so we can assert both the call shape and the reported totals
      // without spinning up a remote peer.
      const syncFromPeerDetailed = vi.spyOn(agent as any, 'syncFromPeerDetailed').mockResolvedValue({
        insertedTriples: 5,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 5,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      });
      const syncSharedMemoryFromPeerDetailed = vi.spyOn(agent as any, 'syncSharedMemoryFromPeerDetailed').mockResolvedValue({
        insertedTriples: 2,
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 2,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      });

      const result = await agent.syncContextGraphFromConnectedPeers('runtime-paranet', {
        includeSharedMemory: true,
      });

      expect(peerStoreReads).toBe(3);
      expect(syncFromPeerDetailed).toHaveBeenCalledWith(remotePeer.toString(), ['runtime-paranet']);
      expect(syncSharedMemoryFromPeerDetailed).toHaveBeenCalledWith(remotePeer.toString(), ['runtime-paranet']);
      expect(result.connectedPeers).toBe(1);
      expect(result.syncCapablePeers).toBe(1);
      expect(result.peersTried).toBe(1);
      expect(result.dataSynced).toBe(5);
      expect(result.sharedMemorySynced).toBe(2);
      expect(result.diagnostics.noProtocolPeers).toBe(0);
      expect(result.diagnostics.durable.failedPeers).toBe(0);
      expect(result.diagnostics.sharedMemory.failedPeers).toBe(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('reports no-protocol peers in catchup diagnostics', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeCatchupNoProtocolDiagnostics',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      agent.subscribeToContextGraph('runtime-paranet');

      const remotePeer = agent.node.peerId;
      vi.spyOn(agent.node.libp2p, 'getConnections').mockReturnValue([
        { remotePeer } as any,
      ]);
      vi.spyOn(agent.node.libp2p.peerStore, 'get').mockResolvedValue({ protocols: [] } as any);

      const result = await agent.syncContextGraphFromConnectedPeers('runtime-paranet', {
        includeSharedMemory: true,
      });

      expect(result.connectedPeers).toBe(1);
      expect(result.syncCapablePeers).toBe(0);
      expect(result.peersTried).toBe(0);
      expect(result.diagnostics.noProtocolPeers).toBe(1);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('allocates a fresh sync deadline per context graph', async () => {
    const agent = await DKGAgent.create({
      name: 'PerContextGraphDeadline',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();

      const deadlines: number[] = [];
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      (agent as any).fetchSyncPages = vi.fn(async (
        _ctx: unknown,
        _remotePeerId: string,
        _contextGraphId: string,
        _includeSharedMemory: boolean,
        _phase: 'data' | 'meta',
        _graphUri: string,
        deadline: number,
      ) => {
        deadlines.push(deadline);
        return [];
      });

      await agent.syncFromPeer('12D3KooWPerContextGraphDeadline111111111111111111111111', ['cg-a', 'cg-b']);

      expect(deadlines).toHaveLength(4);
      expect(deadlines[0]).toBe(1_060_000);
      expect(deadlines[1]).toBe(1_060_000);
      expect(deadlines[2]).toBe(1_120_000);
      expect(deadlines[3]).toBe(1_120_000);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not mark metaSynced true from sync scope alone', async () => {
    const agent = await DKGAgent.create({
      name: 'MetaSyncedScopeOnly',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('runtime-paranet', {
        name: 'Runtime Paranet',
        subscribed: true,
        synced: false,
        metaSynced: false,
      });
      agent.subscribeToContextGraph('runtime-paranet');
      agent.subscribeToContextGraph('runtime-paranet');

      const remotePeer = agent.node.peerId;
      vi.spyOn(agent.node.libp2p.peerStore, 'get').mockResolvedValue({
        protocols: [PROTOCOL_SYNC],
      } as any);
      vi.spyOn(agent, 'syncFromPeer').mockResolvedValue(0);
      vi.spyOn(agent, 'discoverContextGraphsFromStore').mockResolvedValue(0);
      vi.spyOn(agent, 'syncSharedMemoryFromPeer').mockResolvedValue(0);

      await (agent as any).trySyncFromPeer(remotePeer.toString());

      expect((agent as any).subscribedContextGraphs.get('runtime-paranet')?.metaSynced).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('marks metaSynced true when ontology confirms the context graph', async () => {
    const agent = await DKGAgent.create({
      name: 'MetaSyncedOntologyConfirmed',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('runtime-paranet', {
        name: 'Runtime Paranet',
        subscribed: true,
        synced: false,
        metaSynced: false,
      });
      agent.subscribeToContextGraph('runtime-paranet');

      await (agent as any).store.insert([
        {
          subject: paranetDataGraphUri('runtime-paranet'),
          predicate: DKG_ONTOLOGY.RDF_TYPE,
          object: DKG_ONTOLOGY.DKG_PARANET,
          graph: paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY),
        },
      ]);

      const remotePeer = agent.node.peerId;
      vi.spyOn(agent.node.libp2p.peerStore, 'get').mockResolvedValue({
        protocols: [PROTOCOL_SYNC],
      } as any);
      vi.spyOn(agent, 'syncFromPeer').mockResolvedValue(0);
      vi.spyOn(agent, 'discoverContextGraphsFromStore').mockResolvedValue(0);
      vi.spyOn(agent, 'syncSharedMemoryFromPeer').mockResolvedValue(0);

      await (agent as any).trySyncFromPeer(remotePeer.toString());

      expect((agent as any).subscribedContextGraphs.get('runtime-paranet')?.metaSynced).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('deduplicates concurrent sync-on-connect attempts per peer', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncDedupTest',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();

      const remotePeer = agent.node.peerId;
      let releaseSync: (() => void) | undefined;
      const syncGate = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });

      let syncCallCount = 0;
      const syncFromPeer = async () => {
        syncCallCount++;
        await syncGate;
        return 7;
      };

      const origGet = agent.node.libp2p.peerStore.get.bind(agent.node.libp2p.peerStore);
      (agent.node.libp2p.peerStore as any).get = async (peerId: any) => {
        try { return await origGet(peerId); } catch { return { protocols: [PROTOCOL_SYNC] }; }
      };
      (agent as any).syncFromPeer = syncFromPeer;
      (agent as any).discoverContextGraphsFromStore = async () => {};
      (agent as any).syncSharedMemoryFromPeer = async () => 0;

      const first = (agent as any).trySyncFromPeer(remotePeer);
      const second = (agent as any).trySyncFromPeer(remotePeer);

      // Wait for first sync call to register
      for (let i = 0; i < 50 && syncCallCount < 1; i++) {
        await new Promise(r => setTimeout(r, 20));
      }
      expect(syncCallCount).toBe(1);

      releaseSync?.();
      await Promise.all([first, second]);
      expect((agent as any).syncingPeers.has(remotePeer)).toBe(false);

      await (agent as any).trySyncFromPeer(remotePeer);
      expect(syncCallCount).toBe(2);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('builds authenticated sync requests for private context graphs', async () => {
    const agent = await DKGAgent.create({
      name: 'PrivateSyncAuthRequest',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('private-cg', {
        name: 'private-cg',
        subscribed: false,
        synced: true,
        onChainId: '1',
      });

      const chain = (agent as any).chain as EVMChainAdapter;
      const identityId = await chain.ensureProfile();
      const origSignMessage = chain.signMessage.bind(chain);
      (chain as any).signMessage = async (...args: unknown[]) => ({ r: new Uint8Array(32), vs: new Uint8Array(32) });

      const encoded = await (agent as any).buildSyncRequest('private-cg', 0, 50, false, 'peer-remote');
      const parsed = JSON.parse(new TextDecoder().decode(encoded));

      expect(parsed.contextGraphId).toBe('private-cg');
      expect(parsed.targetPeerId).toBe('peer-remote');
      expect(parsed.requesterPeerId).toBe(agent.peerId);
      expect(parsed.requestId).toBeDefined();
      expect(parsed.issuedAtMs).toBeDefined();
      expect(parsed.requesterIdentityId).toBe(identityId.toString());
      expect(parsed.requesterSignatureR).toBeDefined();
      expect(parsed.requesterSignatureVS).toBeDefined();
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('denies private sync requests when requester is not an allowed participant', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const agent = await DKGAgent.create({
      name: 'PrivateSyncAuthDeny',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
    });
    try {
      await agent.start();
      await chain.ensureProfile();
      (agent as any).subscribedContextGraphs.set('private-cg', {
        name: 'private-cg',
        subscribed: false,
        synced: true,
        onChainId: '1',
      });
      (agent as any).isPrivateContextGraph = async () => true;
      (agent as any).getPrivateContextGraphParticipants = async () => [999n];
      (chain as any).verifyACKIdentity = async () => true;

      const allowed = await (agent as any).authorizeSyncRequest({
        contextGraphId: 'private-cg',
        offset: 0,
        limit: 10,
        includeSharedMemory: false,
        targetPeerId: agent.peerId,
        requesterPeerId: agent.peerId,
        requestId: 'req-1',
        issuedAtMs: Date.now(),
        requesterIdentityId: '1',
        requesterSignatureR: '0x' + '00'.repeat(32),
        requesterSignatureVS: '0x' + '00'.repeat(32),
      }, agent.peerId);

      expect(allowed).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('rejects replayed private sync requests', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const wallet = ethers.Wallet.createRandom();
    const agent = await DKGAgent.create({
      name: 'PrivateSyncReplay',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
    });
    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('private-cg', {
        name: 'private-cg',
        subscribed: false,
        synced: true,
        onChainId: '1',
      });
      (agent as any).isPrivateContextGraph = async () => true;
      (chain as any).getContextGraphParticipants = async () => [1n];
      (chain as any).verifySyncIdentity = async () => true;
      (chain as any).verifyACKIdentity = async () => true;

      const request = {
        contextGraphId: 'private-cg',
        offset: 0,
        limit: 10,
        includeSharedMemory: false,
        targetPeerId: agent.peerId,
        requesterPeerId: 'peer-requester',
        requestId: 'req-1',
        issuedAtMs: Date.now(),
        requesterIdentityId: '1',
      } as const;

      const digest = (agent as any).computeSyncDigest(
        request.contextGraphId,
        request.offset,
        request.limit,
        request.includeSharedMemory,
        request.targetPeerId,
        request.requesterPeerId,
        request.requestId,
        request.issuedAtMs,
      );
      const sig = ethers.Signature.from(await wallet.signMessage(digest));

      const signedRequest = {
        ...request,
        requesterSignatureR: sig.r,
        requesterSignatureVS: sig.yParityAndS,
      };

      const first = await (agent as any).authorizeSyncRequest(signedRequest, 'peer-requester');
      const second = await (agent as any).authorizeSyncRequest(signedRequest, 'peer-requester');

      expect(first).toBe(true);
      expect(second).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('emits warning when queryAccess.defaultPolicy is explicitly "public"', async () => {
    const { Logger } = await import('@origintrail-official/dkg-core');
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push(entry));
    let agent: DKGAgent | undefined;

    try {
      agent = await DKGAgent.create({
        name: 'PublicWarnTest',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
        queryAccess: { defaultPolicy: 'public' },
      });
      await agent.start();

      const warning = logs.find(
        l => l.level === 'warn' && l.message.includes('Query access policy is "public"'),
      );
      expect(warning).toBeDefined();
    } finally {
      await agent?.stop().catch(() => {});
      Logger.setSink(null);
    }
  });

  it('does not emit public-query warning when queryAccess is omitted (deny default)', async () => {
    const { Logger } = await import('@origintrail-official/dkg-core');
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push(entry));
    let agent: DKGAgent | undefined;

    try {
      agent = await DKGAgent.create({
        name: 'DenyDefaultTest',
        listenHost: '127.0.0.1',
        chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      });
      await agent.start();

      const warning = logs.find(
        l => l.level === 'warn' && l.message.includes('Query access policy is "public"'),
      );
      expect(warning).toBeUndefined();
    } finally {
      await agent?.stop().catch(() => {});
      Logger.setSink(null);
    }
  });

  it('parseSyncRequest falls back to pipe-delimited on malformed JSON', async () => {
    const agent = await DKGAgent.create({
      name: 'ParseFallbackTest',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();
      const malformedJson = '{not valid json';
      const result = (agent as any).parseSyncRequest(
        new TextEncoder().encode(malformedJson),
      );
      // Falls back to pipe-delimited: the whole string becomes contextGraphId
      expect(result.contextGraphId).toBeDefined();
      expect(result.offset).toBe(0);
      expect(result.limit).toBeDefined();
      expect(result.phase).toBe('data');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('parseSyncRequest parses meta phase from pipe-delimited format', async () => {
    const agent = await DKGAgent.create({
      name: 'ParseMetaPhase',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();
      const msg = 'my-context-graph|10|50|meta';
      const result = (agent as any).parseSyncRequest(
        new TextEncoder().encode(msg),
      );
      expect(result.contextGraphId).toBe('my-context-graph');
      expect(result.offset).toBe(10);
      expect(result.limit).toBe(50);
      expect(result.phase).toBe('meta');
      expect(result.includeSharedMemory).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('parseSyncRequest handles workspace prefix in pipe-delimited format', async () => {
    const agent = await DKGAgent.create({
      name: 'ParseWorkspace',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();
      const msg = 'workspace:my-cg|0|100|data';
      const result = (agent as any).parseSyncRequest(
        new TextEncoder().encode(msg),
      );
      expect(result.contextGraphId).toBe('my-cg');
      expect(result.includeSharedMemory).toBe(true);
      expect(result.phase).toBe('data');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('canReadContextGraph allows locally subscribed private CGs when identityId is 0n', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    (chain as any).getIdentityId = async () => 0n;
    const agent = await DKGAgent.create({
      name: 'CanReadLocal',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
    });
    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('local-private-cg', {
        name: 'local-private-cg',
        subscribed: false,
        synced: true,
      });
      (agent as any).isPrivateContextGraph = async () => true;
      (agent as any).getPrivateContextGraphParticipants = async () => ['1'];

      const canRead = await (agent as any).canReadContextGraph('local-private-cg');
      expect(canRead).toBe(true);

      const cannotRead = await (agent as any).canReadContextGraph('unsubscribed-private-cg');
      expect(cannotRead).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('authorizeSyncRequest uses verifySyncIdentity when available', async () => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const wallet = ethers.Wallet.createRandom();
    const agent = await DKGAgent.create({
      name: 'SyncIdentityTest',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
    });
    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('private-cg', {
        name: 'private-cg',
        subscribed: false,
        synced: true,
        onChainId: '1',
        participantIdentityIds: [1n],
      });
      (agent as any).isPrivateContextGraph = async () => true;
      (agent as any).getPrivateContextGraphParticipants = async () => [
        wallet.address, '1',
      ];
      let syncIdentityCalled = false;
      let ackIdentityCalled = false;
      (chain as any).verifySyncIdentity = async () => { syncIdentityCalled = true; return true; };
      const origVerifyACK = chain.verifyACKIdentity?.bind(chain);
      (chain as any).verifyACKIdentity = async (...args: unknown[]) => { ackIdentityCalled = true; return origVerifyACK?.(...args); };

      const request = {
        contextGraphId: 'private-cg',
        offset: 0,
        limit: 10,
        includeSharedMemory: false,
        targetPeerId: agent.peerId,
        requesterPeerId: 'peer-req',
        requestId: `req-${Date.now()}`,
        issuedAtMs: Date.now(),
        requesterIdentityId: '1',
      };

      const digest = (agent as any).computeSyncDigest(
        request.contextGraphId, request.offset, request.limit,
        request.includeSharedMemory, request.targetPeerId,
        request.requesterPeerId, request.requestId, request.issuedAtMs,
      );
      const sig = ethers.Signature.from(await wallet.signMessage(digest));

      const signed = {
        ...request,
        requesterSignatureR: sig.r,
        requesterSignatureVS: sig.yParityAndS,
      };

      const result = await (agent as any).authorizeSyncRequest(signed, 'peer-req');
      expect(result).toBe(true);
      expect(syncIdentityCalled).toBe(true);
      expect(ackIdentityCalled).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('buildSyncRequest uses pipe-delimited format for public CGs', async () => {
    const agent = await DKGAgent.create({
      name: 'BuildReqPublic',
      listenHost: '127.0.0.1',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    try {
      await agent.start();
      (agent as any).subscribedContextGraphs.set('public-cg', {
        name: 'public-cg', subscribed: true, synced: true,
      });
      const bytes = await (agent as any).buildSyncRequest('public-cg', 5, 100, false, 'peer-remote', 'meta');
      const text = new TextDecoder().decode(bytes);
      expect(text).toBe('public-cg|5|100|meta');
    } finally {
      await agent.stop().catch(() => {});
    }
  });
});
