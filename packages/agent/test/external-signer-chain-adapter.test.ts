/**
 * The chain adapter of a node whose wallets sign through an external signer:
 * how external signing is decided, whatever built the adapter; the one
 * configured source of operational wallets; reading a supplied adapter's
 * operational key; building the adapter (edge nodes only, and no local keys
 * beside external signers); and the VERIFY handler a node without an
 * operational key does not register.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EVMChainAdapter, MockChainAdapter, operationalSigningOf } from '@origintrail-official/dkg-chain';
import { Logger } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { constructConfiguredChainAdapter } from '../src/configured-chain-adapter.js';
import { operationalSignerSourceOf } from '../src/agent-chain-signer-source.js';
import { adapterOperationalPrivateKey, adapterOperationalPrivateKeyAddress } from '../src/dkg-agent-helpers.js';
import { signsThroughExternalSigner } from '../src/external-author-signing.js';
import { isExternalAuthorCurator } from '../src/external-author-curator.js';
import { planAuthorityIndexBootstrap } from '../src/authority-index-config.js';
import {
  ExternallySignedMockChain,
  agentKey,
  closeStartedSigners,
  externalSigners,
  payer,
} from './_helpers/external-signers.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';

afterEach(closeStartedSigners);

describe('the chain adapter of a node signing through an external signer', () => {
  it('decides external signing from the chain adapter, however it was made', async () => {
    const { remote } = await externalSigners();
    const authors = remote.authors;
    const external = { operationalSigning: () => ({ external: true, payerAddresses: [payer.address] }) };
    expect(signsThroughExternalSigner(external)).toBe(true);
    expect(signsThroughExternalSigner({ operationalSigning: () => ({ external: false, payerAddresses: [] }) })).toBe(false);
    // An adapter that does not report its operational signing is taken to sign locally.
    expect(signsThroughExternalSigner({})).toBe(false);
    expect(signsThroughExternalSigner(undefined)).toBe(false);
    // Configured signers build the agent's own adapter, which then says so; a supplied adapter brings its own wallets.
    const built = constructConfiguredChainAdapter({
      chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: '0x00000000000000000000000000000000000000d4', signers: remote.operational },
    });
    // The same signers given in an adapter the node is supplied report the same payers.
    const supplied = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x00000000000000000000000000000000000000d4',
      signers: remote.operational,
      allowNoAdminSigner: true,
    });
    try {
      expect(signsThroughExternalSigner(built.chain)).toBe(true);
      expect(operationalSigningOf(built.chain)).toEqual({ external: true, payerAddresses: [payer.address] });
      const injected = constructConfiguredChainAdapter({ chainAdapter: supplied }).chain;
      expect(operationalSigningOf(injected)).toEqual(operationalSigningOf(built.chain));
    } finally {
      (built.chain as EVMChainAdapter).destroy();
      supplied.destroy();
    }
    expect(() => constructConfiguredChainAdapter({
      chainAdapter: new MockChainAdapter('mock:31337', payer.address),
      chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: ethers.ZeroAddress, signers: remote.operational },
    })).toThrow(/cannot be combined with a supplied chainAdapter/);
    expect(await isExternalAuthorCurator(authors, external, agentKey.address, payer.address)).toBe(true);
    expect(await isExternalAuthorCurator(authors, undefined, agentKey.address, payer.address)).toBe(false);

  });

  it('registers no VERIFY proposal handler when the node holds no operational key', async () => {
    const messages: string[] = [];
    Logger.setSink((record) => { messages.push(record.message); });
    const agent = await DKGAgent.create({
      name: 'ExternalSignerVerify',
      store: new OxigraphStore(),
      chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
      nodeRole: 'edge',
    });
    try {
      await agent.start();
      expect(messages).toContain('VERIFY proposal handler not registered: EVM signing is delegated to an external signer');
      expect(messages).not.toContain('Registered VERIFY proposal handler');
    } finally {
      Logger.setSink(null);
      await agent.stop().catch(() => {});
    }
  });

  it('normalizes the one configured source of operational wallets for the adapter', async () => {
    const { remote } = await externalSigners();
    const [primary, additional] = [HARDHAT_KEYS.CORE_OP, HARDHAT_KEYS.PUBLISHER];
    expect(operationalSignerSourceOf({ operationalKeys: [primary, additional] }))
      .toEqual({ privateKey: primary, additionalKeys: [additional] });
    expect(operationalSignerSourceOf({ signers: remote.operational })).toEqual({ signers: remote.operational });
    expect(operationalSignerSourceOf({})).toBeUndefined();
    expect(operationalSignerSourceOf({ operationalKeys: [], signers: [] })).toBeUndefined();
    // Untyped callers that name both are refused.
    expect(() => operationalSignerSourceOf({ operationalKeys: [primary], signers: remote.operational }))
      .toThrow(/either operationalKeys or signers/);
  });

  it('reads an adapter\'s operational key in one place, for its construction and its publisher address alike', () => {
    const adapterWith = (getOperationalPrivateKey?: () => unknown) =>
      (getOperationalPrivateKey === undefined ? {} : { getOperationalPrivateKey }) as Parameters<typeof adapterOperationalPrivateKey>[0];
    const key = HARDHAT_KEYS.CORE_OP;
    expect(adapterOperationalPrivateKey(adapterWith(() => key))).toBe(key);
    expect(adapterOperationalPrivateKeyAddress(adapterWith(() => key))).toBe(new ethers.Wallet(key).address);
    // No getter, one that throws (an adapter that signs externally), or no key: no key and no address.
    for (const getter of [undefined, () => { throw new Error('signs through an external signer'); }, () => '', () => 7]) {
      expect(adapterOperationalPrivateKey(adapterWith(getter))).toBeUndefined();
      expect(adapterOperationalPrivateKeyAddress(adapterWith(getter))).toBeUndefined();
    }
    // A key that is not one has no address.
    expect(adapterOperationalPrivateKeyAddress(adapterWith(() => '0x1234'))).toBeUndefined();
  });

  it('builds the agent adapter from external signers on edge nodes only', async () => {
    const { remote } = await externalSigners();
    const chainConfig = {
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x00000000000000000000000000000000000000d4',
      chainId: 'evm:31337',
      signers: remote.operational,
    };
    const edge = constructConfiguredChainAdapter({ chainConfig, nodeRole: 'edge' });
    try {
      expect(edge.operationalKeys).toBeUndefined();
      expect((edge.chain as EVMChainAdapter).getSignerAddresses()).toEqual([payer.address]);
      expect(() => (edge.chain as EVMChainAdapter).getOperationalPrivateKey()).toThrow(/external signer/);
      // An injected adapter that signs externally contributes no key either, and runs an edge node only.
      expect(constructConfiguredChainAdapter({ chainAdapter: edge.chain }).operationalKeys).toBeUndefined();
      expect(constructConfiguredChainAdapter({ chainAdapter: edge.chain, nodeRole: 'edge' }).chain).toBe(edge.chain);
      expect(() => constructConfiguredChainAdapter({ chainAdapter: edge.chain, nodeRole: 'core' })).toThrow(/edge nodes only/);
      await expect(DKGAgent.create({
        name: 'SuppliedExternalCore',
        store: new OxigraphStore(),
        chainAdapter: edge.chain,
        nodeRole: 'core',
      })).rejects.toThrow(/edge nodes only/);
      // Nor does it take local operational keys, such as its payer's key left in the configuration:
      // a fresh node refuses them before any agent is registered, and keeps no keystore.
      const dir = await mkdtemp(join(tmpdir(), 'dkg-supplied-external-'));
      try {
        const refusal = await DKGAgent.create({
          name: 'SuppliedExternalWithKeys',
          store: new OxigraphStore(),
          dataDir: dir,
          chainAdapter: edge.chain,
          chainConfig: { rpcUrl: chainConfig.rpcUrl, hubAddress: chainConfig.hubAddress, operationalKeys: [payer.privateKey] },
          nodeRole: 'edge',
        }).then(() => undefined, (error: unknown) => error as Error);
        expect(refusal?.message).toMatch(/operationalKeys are local wallet keys and cannot be combined with a supplied chainAdapter/);
        expect(refusal?.message).not.toContain(payer.privateKey.slice(2));
        await expect(readFile(join(dir, 'agent-keystore.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        // Nor an adapter that reports external signing yet exposes a local operational key of its own.
        const exposing = Object.assign(new ExternallySignedMockChain('mock:31337', payer.address), {
          getOperationalPrivateKey: () => payer.privateKey,
        });
        const exposed = await DKGAgent.create({
          name: 'SuppliedExternalExposingKey',
          store: new OxigraphStore(),
          dataDir: dir,
          chainAdapter: exposing,
          nodeRole: 'edge',
        }).then(() => undefined, (error: unknown) => error as Error);
        expect(exposed?.message).toMatch(/cannot also expose a local operational key/);
        expect(exposed?.message).not.toContain(payer.privateKey.slice(2));
        await expect(readFile(join(dir, 'agent-keystore.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      (edge.chain as EVMChainAdapter).destroy();
    }
    expect(() => constructConfiguredChainAdapter({ chainConfig, nodeRole: 'core' })).toThrow(/edge nodes only/);
    // An injected adapter with a local operational key still runs a core node.
    const { signers: _signers, ...localChainConfig } = chainConfig;
    const localCore = new EVMChainAdapter({ ...localChainConfig, privateKey: HARDHAT_KEYS.CORE_OP, allowNoAdminSigner: true });
    try {
      expect(constructConfiguredChainAdapter({ chainAdapter: localCore, nodeRole: 'core' }).operationalKeys)
        .toEqual([HARDHAT_KEYS.CORE_OP]);
    } finally {
      localCore.destroy();
    }
    expect(() => constructConfiguredChainAdapter({
      chainConfig: { ...chainConfig, operationalKeys: [payer.privateKey] },
    })).toThrow(/either operationalKeys or signers/);
    // An external signer counts as the agent's own EVM adapter for authority-index bootstrap.
    expect(planAuthorityIndexBootstrap({
      nodeRole: 'edge',
      chainConfig: { signers: remote.operational },
      localContextGraphAuthorityIndexStore: {},
      networkRelays: [],
    })).toMatchObject({ source: 'local-history', skipReason: 'no network relay is available to seed from' });
  });
});
