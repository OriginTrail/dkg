import { describe, it, expect, afterEach } from 'vitest';
import {
  DKGAgentWallet,
  buildAgentProfile,
  DiscoveryClient,
  ProfileManager,
  encrypt,
  decrypt,
  ed25519ToX25519Private,
  ed25519ToX25519Public,
  x25519SharedSecret,
  DKGAgent,
  AGENT_REGISTRY_PARANET,
} from '../src/index.js';
import { OxigraphStore } from '@dkg/storage';
import { getGenesisQuads, computeNetworkId, SYSTEM_PARANETS } from '@dkg/core';
import { DKGQueryEngine } from '@dkg/query';
import { sha256 } from '@noble/hashes/sha2.js';
import { MockChainAdapter } from '@dkg/chain';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
      const agent1 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: new MockChainAdapter() });
      const peerId1 = agent1.wallet.keypair.publicKey;

      const agent2 = await DKGAgent.create({ name: 'PersistBot', dataDir: dir, chainAdapter: new MockChainAdapter() });
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
      expect(q.graph).toBe('did:dkg:paranet:agents');
    }
  });

  it('includes hosting profile when paranetsServed is set', () => {
    const { quads } = buildAgentProfile({
      peerId: 'QmHost',
      name: 'HostBot',
      skills: [],
      paranetsServed: ['agent-skills', 'climate'],
    });

    const hostingQuads = quads.filter(q =>
      q.predicate === 'https://dkg.origintrail.io/skill#hostingProfile',
    );
    expect(hostingQuads).toHaveLength(1);

    const paranetsQuad = quads.find(q =>
      q.predicate === 'https://dkg.origintrail.io/skill#paranetsServed',
    );
    expect(paranetsQuad).toBeDefined();
    expect(paranetsQuad!.object).toContain('agent-skills,climate');
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
    const { MockChainAdapter } = await import('@dkg/chain');
    const { DKGPublisher } = await import('@dkg/publisher');
    const { TypedEventBus, generateEd25519Keypair } = await import('@dkg/core');
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus, keypair });

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
    const { MockChainAdapter } = await import('@dkg/chain');
    const { DKGPublisher } = await import('@dkg/publisher');
    const { TypedEventBus, generateEd25519Keypair } = await import('@dkg/core');
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus, keypair });

    const manager = new ProfileManager(publisher, store);

    // First publish
    await manager.publishProfile({
      peerId: 'QmStale',
      name: 'OldName',
      framework: 'DKG',
      skills: [],
    });

    // Verify OldName is stored in the data graph
    const graph = 'did:dkg:paranet:agents';
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
      expect(nameTriples.some(b => b['o']?.includes('NewName'))).toBe(true);
      expect(nameTriples.every(b => !b['o']?.includes('OldName'))).toBe(true);
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
      chainAdapter: new MockChainAdapter(),
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
      chainAdapter: new MockChainAdapter(),
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
      chainAdapter: new MockChainAdapter(),
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

    const agentsParanet = quads.filter(q => q.graph === 'did:dkg:paranet:agents');
    expect(agentsParanet.length).toBeGreaterThan(0);

    const ontology = quads.filter(q => q.graph === 'did:dkg:paranet:ontology');
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
      chainAdapter: new MockChainAdapter(),
    });

    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }

    const paranets = await store.query(
      `SELECT ?p WHERE { <did:dkg:paranet:agents> a <https://dkg.network/ontology#SystemParanet> }`,
    );
    expect(paranets.type).toBe('bindings');

    await agent.stop().catch(() => {});
  });

  it('genesis loading is idempotent', async () => {
    const store = new OxigraphStore();
    const agent1 = await DKGAgent.create({ name: 'Idempotent1', store, chainAdapter: new MockChainAdapter() });
    const agent2 = await DKGAgent.create({ name: 'Idempotent2', store, chainAdapter: new MockChainAdapter() });

    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v }`,
    );
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBe(1);
    }

    await agent1.stop().catch(() => {});
    await agent2.stop().catch(() => {});
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

describe('DKGAgent config — syncParanets and queryAccess warning', () => {
  it('DKGAgentConfig accepts syncParanets array', async () => {
    const agent = await DKGAgent.create({
      name: 'SyncConfigTest',
      chainAdapter: new MockChainAdapter(),
      syncParanets: ['my-custom-paranet', 'another-paranet'],
    });
    expect(agent).toBeDefined();
    await agent.stop().catch(() => {});
  });

  it('adds runtime subscriptions to sync scope', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeSyncScope',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      expect((agent as any).config.syncParanets ?? []).not.toContain('runtime-paranet');

      agent.subscribeToParanet('runtime-paranet');

      expect((agent as any).config.syncParanets ?? []).toContain('runtime-paranet');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not add discovery subscriptions to sync scope when tracking is disabled', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeSyncScopeNoTrack',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      expect((agent as any).config.syncParanets ?? []).not.toContain('discovered-paranet');

      agent.subscribeToParanet('discovered-paranet', { trackSyncScope: false });

      expect((agent as any).config.syncParanets ?? []).not.toContain('discovered-paranet');
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('syncParanetFromConnectedPeers returns empty stats without peers', async () => {
    const agent = await DKGAgent.create({
      name: 'RuntimeCatchupNoPeers',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });

    try {
      await agent.start();
      agent.subscribeToParanet('runtime-paranet');
      const result = await agent.syncParanetFromConnectedPeers('runtime-paranet', {
        includeWorkspace: true,
      });

      expect(result.connectedPeers).toBe(0);
      expect(result.syncCapablePeers).toBe(0);
      expect(result.peersTried).toBe(0);
      expect(result.dataSynced).toBe(0);
      expect(result.workspaceSynced).toBe(0);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('emits warning when queryAccess.defaultPolicy is explicitly "public"', async () => {
    const { Logger } = await import('@dkg/core');
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push(entry));
    let agent: DKGAgent | undefined;

    try {
      agent = await DKGAgent.create({
        name: 'PublicWarnTest',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
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
    const { Logger } = await import('@dkg/core');
    const logs: Array<{ level: string; message: string }> = [];
    Logger.setSink((entry) => logs.push(entry));
    let agent: DKGAgent | undefined;

    try {
      agent = await DKGAgent.create({
        name: 'DenyDefaultTest',
        listenHost: '127.0.0.1',
        chainAdapter: new MockChainAdapter(),
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
});
