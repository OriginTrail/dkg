/**
 * A node that signed with a local wallet keeps that wallet's key in its agent
 * keystore, as the key of its first (default) agent. When the wallet moves
 * into an external signer as one of its payers, the node refuses to load its
 * agents, since a payer never signs as an agent, until that key is removed;
 * the node's other agents keep their keys, and the former wallet stays a
 * registered agent without a key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { connectRemoteSigners } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, assertKeystoreHoldsNoPayerKey } from '../src/index.js';
import { createEVMAdapter, createProvider, getSharedContext, HARDHAT_KEYS, revertSnapshot, takeSnapshot } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner } from '../../chain/test/helpers/fake-remote-signer.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

const PAYER_TOKEN = 'migration-payer-credential-5a6b7c8d9e0f';
const AUTHOR_TOKEN = 'migration-author-credential-0f9e8d7c6b5a';
const formerWallet = new ethers.Wallet(HARDHAT_KEYS.EXTRA1);
const signerAuthor = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const CG = 'migrated-node-graph';
const EARLIER_CG = 'pre-migration-graph';
const NAME = 'after-migration';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('moving a node\'s local wallet into an external signer as a payer', () => {
  it('reads a payer key stored without its 0x prefix as that payer\'s key, whatever entry holds it', () => {
    const path = join(tmpdir(), 'agent-keystore.json');
    for (const filedUnder of [formerWallet.address.toLowerCase(), signerAuthor.address.toLowerCase()]) {
      const keystore = { [filedUnder]: { authToken: 'former-token', privateKey: formerWallet.privateKey.slice(2) } };
      expect(() => assertKeystoreHoldsNoPayerKey(keystore, [formerWallet.address], path))
        .toThrow(`${path} holds the private key of ${formerWallet.address}`);
    }
  });

  it('refuses to load the payer\'s key, then loads the other agents and publishes as the default author', async () => {
    const snapshot = await takeSnapshot();
    cleanups.push(() => revertSnapshot(snapshot));
    const dir = await mkdtemp(join(tmpdir(), 'dkg-keystore-migration-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const storePath = join(dir, 'store.nq');
    const keystorePath = join(dir, 'agent-keystore.json');

    // A node signing with its local wallet: the wallet's key becomes the default agent's.
    const local = await DKGAgent.create({
      name: 'MigratingNode',
      store: new OxigraphStore(storePath),
      dataDir: dir,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.EXTRA1),
      nodeRole: 'edge',
    });
    await local.start();
    expect(local.getDefaultAgentAddress()).toBe(formerWallet.address);
    const author = await local.registerAgent('local-author');
    expect(author.privateKey).toBeDefined();
    // A draft its default agent opened.
    await local.assertion.create(EARLIER_CG, 'before-migration');
    await local.stop();

    // The same node, its former wallet now a payer of the external signer.
    const fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: [formerWallet.privateKey] },
        { token: AUTHOR_TOKEN, keys: [signerAuthor.privateKey] },
      ],
    });
    const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    cleanups.push(async () => {
      remote.destroy();
      await fake.close();
    });
    const { rpcUrl, hubAddress } = getSharedContext();
    const restart = () => DKGAgent.create({
      name: 'MigratingNode',
      store: new OxigraphStore(storePath),
      dataDir: dir,
      chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational },
      authorSigners: remote.authors,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      nodeRole: 'edge',
    });

    const refused = await restart();
    await expect(refused.start()).rejects.toThrow(
      `${keystorePath} holds the private key of ${formerWallet.address}, which the external signer serves as a payer account`,
    );
    await refused.stop().catch(() => {});
    expect(refused.getCustodialAgentPrivateKey(formerWallet.address)).toBeUndefined();

    // Kept only as a payer: without its key the node starts, and its other agents load as before.
    const keystore = JSON.parse(await readFile(keystorePath, 'utf8')) as Record<string, unknown>;
    delete keystore[formerWallet.address.toLowerCase()];
    await writeFile(keystorePath, JSON.stringify(keystore));
    const migrated = await restart();
    try {
      await migrated.start();
      expect(migrated.getCustodialAgentPrivateKey(author.agentAddress)).toBe(author.privateKey);
      expect(migrated.getLocalAgentMode(formerWallet.address)).toBe('custodial');
      expect(migrated.getCustodialAgentPrivateKey(formerWallet.address)).toBeUndefined();
      // The signer's default author, which can sign, is now the default agent instead of the keyless former wallet,
      // whose draft keeps its author.
      expect(migrated.getDefaultAgentAddress()).toBe(signerAuthor.address);
      expect(await migrated.assertion.history(EARLIER_CG, 'before-migration', { agentAddress: formerWallet.address })).not.toBeNull();
      expect(await migrated.assertion.history(EARLIER_CG, 'before-migration')).toBeNull();

      // With no agent selected the node opens, seals and publishes a new asset as the default author; the payer pays.
      await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, formerWallet.address, ethers.parseEther('50000000'));
      await installHardhatACKProvider(migrated);
      await migrated.createContextGraph({ id: CG, name: 'Migrated node graph' });
      await migrated.registerContextGraph(CG);
      await migrated.assertion.create(CG, NAME);
      await migrated.assertion.write(CG, NAME, [
        { subject: 'urn:migration:asset', predicate: 'http://schema.org/name', object: '"after"', graph: '' },
      ]);
      const before = fake.requests.length;
      const seal = await migrated.assertion.finalize(CG, NAME);
      expect(ethers.getAddress(seal.authorAddress)).toBe(signerAuthor.address);
      expect(seal.reservedKaId >> 96n).toBe(BigInt(signerAuthor.address));
      await migrated.assertion.promote(CG, NAME);
      const published = await migrated.publishFromFinalizedAssertion(CG, NAME);
      expect(published.status).toBe('confirmed');
      expect(published.kaId! >> 96n).toBe(BigInt(signerAuthor.address));
      const signed = fake.requests.slice(before).filter((request) => request.method !== 'eth_accounts');
      const attestations = signed.filter((request) => request.method === 'eth_signTypedData_v4');
      expect(attestations.length).toBeGreaterThan(0);
      expect(attestations.every((request) => request.authorization === `Bearer ${AUTHOR_TOKEN}`)).toBe(true);
      const transactions = signed.filter((request) => request.method === 'eth_signTransaction');
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions.every((request) => request.authorization === `Bearer ${PAYER_TOKEN}`)).toBe(true);
    } finally {
      await migrated.stop().catch(() => {});
    }
  }, 300_000);
});
