import { describe, it, expect } from 'vitest';
import {
  DKGAgentWallet,
  buildAgentProfile,
  DiscoveryClient,
  encrypt,
  decrypt,
  ed25519ToX25519Private,
  ed25519ToX25519Public,
  x25519SharedSecret,
  DKGAgent,
} from '../src/index.js';
import { OxigraphStore } from '@dkg/storage';
import { DKGQueryEngine } from '@dkg/query';
import { sha256 } from '@noble/hashes/sha2.js';

describe('AgentWallet', () => {
  it('generates a wallet with keypair', async () => {
    const wallet = await DKGAgentWallet.generate();
    expect(wallet.masterKey).toHaveLength(32);
    expect(wallet.keypair.secretKey).toBeDefined();
    expect(wallet.keypair.publicKey).toBeDefined();
    expect(wallet.peerId()).toBeDefined();
  });

  it('derives deterministic EVM wallet', async () => {
    const wallet = await DKGAgentWallet.generate();
    const evm1 = wallet.deriveEvmWallet();
    const evm2 = wallet.deriveEvmWallet();
    expect(evm1.address).toBe(evm2.address);
    expect(evm1.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('derives deterministic Solana wallet', async () => {
    const wallet = await DKGAgentWallet.generate();
    const sol1 = wallet.deriveSolanaWallet();
    const sol2 = wallet.deriveSolanaWallet();
    expect(sol1.address).toBe(sol2.address);
    expect(sol1.address).toHaveLength(64);
  });

  it('EVM wallet can sign data', async () => {
    const wallet = await DKGAgentWallet.generate();
    const evm = wallet.deriveEvmWallet();
    const sig = evm.sign(new TextEncoder().encode('hello'));
    expect(sig.length).toBeGreaterThan(0);
  });

  it('Solana wallet can sign data', async () => {
    const wallet = await DKGAgentWallet.generate();
    const sol = wallet.deriveSolanaWallet();
    const sig = sol.sign(new TextEncoder().encode('hello'));
    expect(sig).toHaveLength(64);
  });

  it('signs with Ed25519 master key', async () => {
    const wallet = await DKGAgentWallet.generate();
    const sig = await wallet.sign(new TextEncoder().encode('test'));
    expect(sig).toHaveLength(64);
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
    expect(predicates).toContain('http://schema.org/name');
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
