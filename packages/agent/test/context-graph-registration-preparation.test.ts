import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  MockChainAdapter,
  type CreateOnChainContextGraphParams,
  type CreateOnChainContextGraphResult,
  type PrepareContextGraphRegistrationOptions,
  type PreparedContextGraphRegistration,
} from '@origintrail-official/dkg-chain';
import { ContextGraphRegistrationPreparationUnsupportedError } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

class LegacyDirectContextGraphAdapter extends MockChainAdapter {
  readonly createCalls: CreateOnChainContextGraphParams[] = [];

  constructor(signerAddress: string) {
    super('mock:31337', signerAddress);
    // Model an out-of-tree adapter compiled before prepared registration was
    // added: the optional method is genuinely absent at runtime.
    Object.defineProperty(this, 'prepareOnChainContextGraphRegistration', {
      configurable: true,
      value: undefined,
    });
  }

  override async createOnChainContextGraph(
    params: CreateOnChainContextGraphParams,
  ): Promise<CreateOnChainContextGraphResult> {
    this.createCalls.push({ ...params });
    return super.createOnChainContextGraph(params);
  }
}

class CuratedPoolPreparationAdapter extends MockChainAdapter {
  readonly prepareCalls: PrepareContextGraphRegistrationOptions[] = [];
  readonly submitCalls: CreateOnChainContextGraphParams[] = [];

  constructor(
    readonly authorizedSigner: string,
    readonly unrelatedCoveredSigner: string,
    readonly authorityOwner: string,
    readonly authorityAccountId: bigint,
  ) {
    super('mock:31337', authorizedSigner);
  }

  override async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    if (accountId !== this.authorityAccountId) throw new Error(`Mock: PCA account ${accountId} does not exist`);
    return this.authorityOwner;
  }

  override async getConvictionAgentAccountId(address: string): Promise<bigint> {
    return address.toLowerCase() === this.authorizedSigner.toLowerCase()
      ? this.authorityAccountId
      : 17n;
  }

  override async prepareOnChainContextGraphRegistration(
    options: PrepareContextGraphRegistrationOptions = {},
  ): Promise<PreparedContextGraphRegistration> {
    this.prepareCalls.push({ ...options });
    // This deliberately models the regression: without an app-supplied pin,
    // pool coverage optimization would choose an unrelated covered wallet.
    const signerAddress = options.registrationSignerAddress
      ? ethers.getAddress(options.registrationSignerAddress)
      : this.unrelatedCoveredSigner;
    const coverage = options.registrationSignerAddress
      ? { source: 'none' as const }
      : { source: 'owned' as const, accountId: 17n };
    return {
      signerAddress,
      coverage,
      submit: async (params) => {
        this.submitCalls.push({ ...params });
        return { contextGraphId: 1n, txHash: `0x${'11'.repeat(32)}` };
      },
    };
  }
}

class AdvisoryInferredPreparationAdapter extends MockChainAdapter {
  readonly prepareCalls: PrepareContextGraphRegistrationOptions[] = [];
  readonly submitCalls: CreateOnChainContextGraphParams[] = [];

  constructor(
    readonly inferredPrimarySigner: string,
    readonly pcaCoveredSecondarySigner: string,
  ) {
    super('mock:31337', inferredPrimarySigner);
  }

  override async prepareOnChainContextGraphRegistration(
    options: PrepareContextGraphRegistrationOptions = {},
  ): Promise<PreparedContextGraphRegistration> {
    this.prepareCalls.push({ ...options });
    const signerAddress = options.registrationSignerAddress
      ? ethers.getAddress(options.registrationSignerAddress)
      : ethers.getAddress(this.pcaCoveredSecondarySigner);
    return {
      signerAddress,
      coverage: signerAddress.toLowerCase() === this.pcaCoveredSecondarySigner.toLowerCase()
        ? { source: 'owned' as const, accountId: 23n }
        : { source: 'none' as const },
      submit: async (params) => {
        this.submitCalls.push({ ...params });
        return { contextGraphId: 1n, txHash: `0x${'33'.repeat(32)}` };
      },
    };
  }
}

const agents: DKGAgent[] = [];

async function createAgent(name: string, chainAdapter: MockChainAdapter): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    store: new OxigraphStore(),
    chainAdapter,
    nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

afterEach(async () => {
  await Promise.allSettled(agents.splice(0).map((agent) => agent.stop()));
});

describe('context-graph registration preparation boundary', () => {
  it('keeps generic adapter inference advisory in a normally constructed agent', async () => {
    const inferredPrimarySigner = ethers.Wallet.createRandom();
    const pcaCoveredSecondarySigner = ethers.Wallet.createRandom();
    const chain = new AdvisoryInferredPreparationAdapter(
      inferredPrimarySigner.address,
      pcaCoveredSecondarySigner.address,
    );
    const agent = await createAgent('AdvisoryAdapterInference', chain);

    await agent.createContextGraph({
      id: 'advisory-adapter-inference',
      name: 'Advisory adapter inference',
      callerAgentAddress: inferredPrimarySigner.address,
    });

    await expect(agent.registerContextGraph('advisory-adapter-inference', {
      callerAgentAddress: inferredPrimarySigner.address,
      publisher: agent.publisher,
    })).resolves.toMatchObject({ onChainId: '1' });

    expect(chain.prepareCalls).toEqual([{
      registrationPcaAccountId: undefined,
      registrationSignerAddress: undefined,
      preferPcaCoveredSigner: true,
    }]);
    expect(chain.submitCalls).toHaveLength(1);
    expect(chain.submitCalls[0]).toMatchObject({
      publishPolicy: 1,
    });
    expect(chain.submitCalls[0]).not.toHaveProperty('publishAuthority');
    expect(chain.submitCalls[0]).not.toHaveProperty('publishAuthorityAccountId');
  });

  it('normalizes public registration PCA inputs once before chain preparation', async () => {
    const primarySigner = ethers.Wallet.createRandom();
    const coveredSigner = ethers.Wallet.createRandom();
    const chain = new AdvisoryInferredPreparationAdapter(
      primarySigner.address,
      coveredSigner.address,
    );
    const agent = await createAgent('RegistrationPcaInputBoundary', chain);

    await agent.createContextGraph({
      id: 'registration-pca-input-boundary',
      name: 'Registration PCA input boundary',
      callerAgentAddress: primarySigner.address,
    });

    await expect(agent.registerContextGraph('registration-pca-input-boundary', {
      callerAgentAddress: primarySigner.address,
      registrationPcaAccountId: '23',
    })).resolves.toMatchObject({ onChainId: '1' });
    expect(chain.prepareCalls[0]?.registrationPcaAccountId).toBe(23n);

    await agent.createContextGraph({
      id: 'registration-pca-out-of-range',
      name: 'Registration PCA out of range',
      callerAgentAddress: primarySigner.address,
    });
    await expect(agent.registerContextGraph('registration-pca-out-of-range', {
      callerAgentAddress: primarySigner.address,
      registrationPcaAccountId: (1n << 256n).toString(),
    })).rejects.toThrow(
      'Registration PCA account id must be a positive integer within uint256 range.',
    );
    expect(chain.prepareCalls).toHaveLength(1);
  });

  it('preserves ordinary direct registration for a custom adapter without optional preparation', async () => {
    const signer = ethers.Wallet.createRandom();
    const chain = new LegacyDirectContextGraphAdapter(signer.address);
    const agent = await createAgent('LegacyDirectRegistration', chain);
    const prepareLegacy = vi.spyOn(agent.publisher, 'prepareLegacyContextGraphRegistration');

    await agent.createContextGraph({
      id: 'legacy-direct-registration',
      name: 'Legacy direct registration',
      callerAgentAddress: signer.address,
    });

    await expect(agent.registerContextGraph('legacy-direct-registration', {
      callerAgentAddress: signer.address,
    })).resolves.toMatchObject({ onChainId: '1' });
    expect(chain.createCalls).toHaveLength(1);

    await agent.createContextGraph({
      id: 'legacy-auto-registration',
      name: 'Legacy auto registration',
      callerAgentAddress: signer.address,
    });
    await expect(agent.registerContextGraph('legacy-auto-registration', {
      callerAgentAddress: signer.address,
      publisher: agent.publisher,
    })).resolves.toMatchObject({ onChainId: '2' });
    expect(chain.createCalls).toHaveLength(2);
    expect(prepareLegacy).toHaveBeenCalledTimes(1);

    await agent.createContextGraph({
      id: 'legacy-explicit-coverage',
      name: 'Legacy explicit coverage',
      callerAgentAddress: signer.address,
    });
    await expect(agent.registerContextGraph('legacy-explicit-coverage', {
      callerAgentAddress: signer.address,
      publisher: agent.publisher,
      registrationPcaAccountId: 8n,
    })).rejects.toBeInstanceOf(ContextGraphRegistrationPreparationUnsupportedError);
    expect(chain.createCalls).toHaveLength(2);

    const selectedPreparer = {
      prepareContextGraphRegistration: vi.fn(),
      prepareLegacyContextGraphRegistration: vi.fn(),
    };
    await expect(agent.registerContextGraph('legacy-direct-registration', {
      callerAgentAddress: signer.address,
      publisher: selectedPreparer as never,
    })).rejects.toThrow(/already registered on-chain/i);
    expect(selectedPreparer.prepareContextGraphRegistration).not.toHaveBeenCalled();
    expect(selectedPreparer.prepareLegacyContextGraphRegistration).not.toHaveBeenCalled();
    expect(chain.createCalls).toHaveLength(2);

    await agent.createContextGraph({
      id: 'selected-preparer-no-fallback',
      name: 'Selected preparer no fallback',
      callerAgentAddress: signer.address,
    });
    selectedPreparer.prepareContextGraphRegistration.mockRejectedValueOnce(
      new Error('selected preparation unavailable'),
    );
    await expect(agent.registerContextGraph('selected-preparer-no-fallback', {
      callerAgentAddress: signer.address,
      publisher: selectedPreparer as never,
    })).rejects.toThrow('selected preparation unavailable');
    expect(selectedPreparer.prepareContextGraphRegistration).toHaveBeenCalledTimes(1);
    expect(chain.createCalls).toHaveLength(2);
  });

  it('pins PCA-curated preparation to the exact authorized signer and preserves paid fallback', async () => {
    const authorizedSigner = ethers.Wallet.createRandom();
    const unrelatedCoveredSigner = ethers.Wallet.createRandom();
    const authorityOwner = ethers.Wallet.createRandom();
    const authorityAccountId = 8n;
    const chain = new CuratedPoolPreparationAdapter(
      authorizedSigner.address,
      unrelatedCoveredSigner.address,
      authorityOwner.address,
      authorityAccountId,
    );
    const agent = await createAgent('PcaCuratedPinnedRegistration', chain);

    await agent.createContextGraph({
      id: 'pca-curated-paid-fallback',
      name: 'PCA curated paid fallback',
      accessPolicy: 1,
      callerAgentAddress: authorizedSigner.address,
    });

    await expect(agent.registerContextGraph('pca-curated-paid-fallback', {
      callerAgentAddress: authorizedSigner.address,
      publishPolicy: 0,
      publishAuthorityAccountId: authorityAccountId,
    })).resolves.toMatchObject({ onChainId: '1' });

    expect(chain.prepareCalls).toEqual([{
      registrationSignerAddress: ethers.getAddress(authorizedSigner.address),
    }]);
    expect(chain.prepareCalls[0]?.registrationSignerAddress?.toLowerCase())
      .not.toBe(unrelatedCoveredSigner.address.toLowerCase());
    expect(chain.submitCalls).toHaveLength(1);
    expect(chain.submitCalls[0]).toMatchObject({
      publishPolicy: 0,
      publishAuthority: ethers.getAddress(authorityOwner.address),
      publishAuthorityAccountId: authorityAccountId,
    });
  });

  it('derives EOA-curated authority from the sealed registration signer', async () => {
    const localCurator = ethers.Wallet.createRandom();
    const advisoryAuthorHint = ethers.Wallet.createRandom();
    const selectedRegistrationSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', localCurator.address);
    const submit = vi.fn(async (_params: CreateOnChainContextGraphParams) => ({
      contextGraphId: 1n,
      txHash: `0x${'22'.repeat(32)}`,
    }));
    const selectedPreparer = {
      publisherFallbackAuthorAddress: vi.fn(async () => advisoryAuthorHint.address),
      prepareContextGraphRegistration: vi.fn(async (_options: PrepareContextGraphRegistrationOptions) => ({
        signerAddress: selectedRegistrationSigner.address,
        coverage: { source: 'none' as const },
        submit,
      })),
      prepareLegacyContextGraphRegistration: vi.fn(),
    };
    const agent = await createAgent('EoaCuratedSelectedRegistration', chain);

    await agent.createContextGraph({
      id: 'eoa-curated-selected-publisher',
      name: 'EOA curated selected publisher',
      accessPolicy: 1,
      callerAgentAddress: localCurator.address,
    });

    await expect(agent.registerContextGraph('eoa-curated-selected-publisher', {
      callerAgentAddress: localCurator.address,
      publishPolicy: 0,
      publisher: selectedPreparer as never,
    })).resolves.toMatchObject({ onChainId: '1' });

    expect(selectedPreparer.prepareContextGraphRegistration).toHaveBeenCalledWith({});
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      publishPolicy: 0,
      publishAuthority: ethers.getAddress(selectedRegistrationSigner.address),
    }));
    expect(submit).not.toHaveBeenCalledWith(expect.objectContaining({
      publishAuthority: ethers.getAddress(advisoryAuthorHint.address),
    }));
    expect(selectedPreparer.publisherFallbackAuthorAddress).not.toHaveBeenCalled();
  });
});
