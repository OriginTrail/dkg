import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  DKGAgentWallet,
  buildAgentProfile,
  collectPublishableMultiaddrs,
  CclEvaluator,
  CclResourceNotFoundError,
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
import { getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphWorkspaceGraphUri, contextGraphMetaUri, sparqlString } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  EVMChainAdapter,
  MockChainAdapter,
  type ChainAdapter,
  type CreateOnChainContextGraphParams,
  type CreateOnChainContextGraphResult,
  type OnChainPublishResult,
  type V10PublishDirectParams,
} from '@origintrail-official/dkg-chain';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapPublisherForTest, mockSealCtx } from '../../publisher/test/_helpers/seal.js';
import { mockChainStubACKProvider } from '../../publisher/test/_helpers/acks.js';

const require = createRequire(import.meta.url);
const { Evaluator: ReferenceEvaluator, loadYaml } = require(fileURLToPath(new URL('../../../ccl_v0_1/evaluator/reference_evaluator.js', import.meta.url)));
const CCL_FACT_NS = 'https://example.org/ccl-fact#';

/**
 * Wrap an agent's internal publisher so its on-chain publish() calls
 * auto-inject a precomputedAttestation (Phase C requirement). Used by
 * the ACK signer-gating tests below where the test directly invokes
 * `agent.publisher.publish(...)` against a MockChainAdapter and
 * expects `result.status === 'confirmed'`.
 *
 * Mutates `agent.publisher` in place — the property is `readonly` in
 * production but the test bypass is intentional and contained.
 *
 * The seal context is read from the agent's actual chain adapter:
 * different test adapters return different kav10 addresses
 * (`MockChainAdapter` -> `0x...c10a`,
 * `OperationalKeyOnlyPublishChainAdapter` -> `0x...00A1`, etc.).
 * Using a fixed `mockSealCtx()` would make the publisher's
 * seal-integrity preflight rebuild typed-data with the chain's address
 * (not ours) and reject the seal as a signer mismatch.
 */
async function _wrapAgentPublisherForSeal(agent: DKGAgent): Promise<void> {
  const chain = (agent as unknown as { chain: {
    getEvmChainId?: () => Promise<bigint>;
    getKnowledgeAssetsLifecycleAddress?: () => Promise<string>;
  } }).chain;
  const chainId = (await chain.getEvmChainId?.()) ?? 31337n;
  const kav10Address = (await chain.getKnowledgeAssetsLifecycleAddress?.()) ?? '0x000000000000000000000000000000000000c10a';
  const wrapped = wrapPublisherForTest(agent.publisher, {
    author: ethers.Wallet.createRandom(),
    ctx: mockSealCtx({ chainId, kav10Address }),
    v10ACKProvider: mockChainStubACKProvider(),
  });
  Object.defineProperty(agent, 'publisher', { value: wrapped, writable: true, configurable: true });
}

class CapturingContextGraphChainAdapter extends MockChainAdapter {
  createOnChainContextGraphCalls: CreateOnChainContextGraphParams[] = [];

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    this.createOnChainContextGraphCalls.push({
      ...params,
      participantAgents: params.participantAgents ? [...params.participantAgents] : undefined,
    });
    return super.createOnChainContextGraph(params);
  }
}

class AsyncSignerAddressContextGraphChainAdapter extends CapturingContextGraphChainAdapter {
  async getSignerAddress(): Promise<string> {
    return this.signerAddress;
  }
}

class SignerListContextGraphChainAdapter extends CapturingContextGraphChainAdapter {
  async getSignerAddress(): Promise<string> {
    throw new Error('signer address unavailable until publish');
  }

  async getSignerAddresses(): Promise<string[]> {
    return [this.signerAddress];
  }
}

class PcaCuratedRegistrationChainAdapter extends AsyncSignerAddressContextGraphChainAdapter {
  constructor(
    private readonly accountOwners: Map<bigint, string>,
    signerAddress?: string,
    private readonly agentAccounts: Map<string, bigint> = new Map(),
  ) {
    // Forward an explicit signer to MockChainAdapter. PCA registration
    // supports either an owner signer or a signer registered to the exact
    // account; in both cases msg.sender owns the minted Context Graph NFT.
    super('mock:31337', signerAddress);
  }

  async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    const owner = this.accountOwners.get(accountId);
    if (!owner) {
      throw new Error(`No mock PCA owner for account ${accountId}`);
    }
    return owner;
  }

  async getConvictionAgentAccountId(agent: string): Promise<bigint> {
    return this.agentAccounts.get(agent.toLowerCase()) ?? 0n;
  }
}

class NonRegisteringACKChainAdapter extends MockChainAdapter {
  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }) {
    return {
      identityId: options?.identityId ?? (await this.getIdentityId()),
      registered: [],
      alreadyRegistered: [],
      taken: [],
    };
  }

  async isOperationalWalletRegistered(): Promise<boolean> {
    return false;
  }
}

class FlakyRegistrationACKChainAdapter extends MockChainAdapter {
  ensureCalls = 0;

  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }) {
    this.ensureCalls += 1;
    if (this.ensureCalls === 1) {
      throw new Error('temporary registration failure');
    }
    return super.ensureOperationalWalletsRegistered(options);
  }
}

// #894 / Codex PR #901: simulates a transient RPC outage during boot-time
// identity resolution. The seeded identity exists the whole time, but the
// first `failFor` `getIdentityId()` calls reject (RPC unreachable). Boot must
// still complete (HTTP readiness can't depend on chain reachability); the
// StorageACK path's background re-resolution then recovers the identity on a
// later call and registers the handler.
class TransientIdentityFailureChainAdapter extends MockChainAdapter {
  identityCalls = 0;

  constructor(chainId: string, signerAddress: string, private readonly failFor: number) {
    super(chainId, signerAddress);
  }

  override async getIdentityId(): Promise<bigint> {
    this.identityCalls += 1;
    if (this.identityCalls <= this.failFor) {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:8545 (simulated transient RPC outage, call #${this.identityCalls})`);
    }
    return super.getIdentityId();
  }
}

// #894 / Codex PR #901 round 2 (:1757): a brand-new core node that has NO
// on-chain identity yet and hits a transient RPC outage during boot, BEFORE
// `ensureProfile()` ever runs. `getIdentityId()` fails for the first
// `identityFailFor` calls (RPC down), then returns 0n (still no profile).
// Re-probing `getIdentityId()` alone would loop forever at 0n; the retry path
// must call `ensureProfile()` to provision the profile once the chain is back.
class BrandNewCoreTransientChainAdapter extends MockChainAdapter {
  identityCalls = 0;
  ensureProfileCalls = 0;

  constructor(chainId: string, signerAddress: string, private readonly identityFailFor: number) {
    super(chainId, signerAddress);
  }

  override async getIdentityId(): Promise<bigint> {
    this.identityCalls += 1;
    if (this.identityCalls <= this.identityFailFor) {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:8545 (simulated transient RPC outage, getIdentityId #${this.identityCalls})`);
    }
    // Chain reachable now, but no profile exists until ensureProfile runs.
    return super.getIdentityId();
  }

  override async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    this.ensureProfileCalls += 1;
    return super.ensureProfile(options);
  }
}

// Codex PR #901 round-3 :1714: a core node whose boot provisioning fails
// PERMANENTLY/deterministically (here: insufficient funds — not an RPC outage).
// This must NOT arm the StorageACK retry loop; the node stays 'disabled' and
// `ensureProfile()` is called exactly once (no 30s-forever re-submission).
class PermanentProfileFailureChainAdapter extends MockChainAdapter {
  ensureProfileCalls = 0;

  override async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    this.ensureProfileCalls += 1;
    throw new Error('insufficient funds for intrinsic transaction cost');
  }
}

// Codex PR #901 round-4 :1838: boot fails TRANSIENTLY (RPC down) so the retry
// loop arms, but once the chain is back the RETRY-path provisioning fails
// PERMANENTLY (insufficient funds). The retry-path catch must reclassify and
// go 'disabled' — `ensureProfile()` must NOT keep re-running every interval.
class RetryPathPermanentFailureChainAdapter extends MockChainAdapter {
  identityCalls = 0;
  ensureProfileCalls = 0;

  constructor(chainId: string, signerAddress: string, private readonly identityFailFor: number) {
    super(chainId, signerAddress);
  }

  override async getIdentityId(): Promise<bigint> {
    this.identityCalls += 1;
    if (this.identityCalls <= this.identityFailFor) {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:8545 (simulated transient RPC outage, getIdentityId #${this.identityCalls})`);
    }
    return super.getIdentityId(); // 0n — no profile yet
  }

  override async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
    this.ensureProfileCalls += 1;
    throw new Error('insufficient funds for intrinsic transaction cost');
  }
}

class ContextAuthorizedPublisherChainAdapter extends MockChainAdapter {
  capturedPublisherAddress?: string;

  constructor(
    private readonly primaryWallet: ethers.Wallet,
    private readonly authorizedWallet: ethers.Wallet,
  ) {
    super('mock:31337', primaryWallet.address);
    this.seedIdentity(authorizedWallet.address, 77n);
    this.minimumRequiredSignatures = 1;
  }

  getOperationalPrivateKey(): string {
    return this.primaryWallet.privateKey;
  }

  async getAuthorizedPublisherAddress(contextGraphId: bigint): Promise<string> {
    expect(contextGraphId).toBe(42n);
    return this.authorizedWallet.address;
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const normalized = ethers.getAddress(address);
    if (normalized.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error(`unexpected publisher signer ${address}`);
    }
    const sig = ethers.Signature.from(await this.authorizedWallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  override async createKnowledgeAssets(params: Parameters<MockChainAdapter['createKnowledgeAssets']>[0]) {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress?.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error('agent pinned publish to the primary operational key');
    }
    return super.createKnowledgeAssets(params);
  }
}



function buildSnapshotFactQuads(opts: {
  contextGraphId: string;
  snapshotId: string;
  view: 'accepted' | 'workspace';
  scopeUal?: string;
  facts: Array<[string, ...unknown[]]>;
}): Quad[] {
  const graph = opts.view === 'workspace'
    ? contextGraphWorkspaceGraphUri(opts.contextGraphId)
    : contextGraphDataGraphUri(opts.contextGraphId);

  return opts.facts.flatMap((fact, index) => {
    const [predicate, ...args] = fact;
    const subject = `did:dkg:ccl-fact:${opts.contextGraphId}:${opts.snapshotId}:${index}`;
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

export { describe, it, expect, beforeAll, afterAll, vi };
export { DKGAgentWallet, buildAgentProfile, collectPublishableMultiaddrs, CclEvaluator, CclResourceNotFoundError, DiscoveryClient, ProfileManager, encrypt, decrypt, ed25519ToX25519Private, ed25519ToX25519Public, x25519SharedSecret, DKGAgent, AGENT_REGISTRY_CONTEXT_GRAPH, parseCclPolicy };
export { OxigraphStore, getGenesisQuads, computeNetworkId, PROTOCOL_SYNC, PROTOCOL_STORAGE_ACK, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphWorkspaceGraphUri, contextGraphMetaUri, sparqlString, DKGQueryEngine, sha256 };
export { EVMChainAdapter, MockChainAdapter, createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS, mintTokens, ethers, tmpdir, mkdtemp, readFile, readdir, rm, join, fileURLToPath };
export { _wrapAgentPublisherForSeal, CapturingContextGraphChainAdapter, AsyncSignerAddressContextGraphChainAdapter, SignerListContextGraphChainAdapter, PcaCuratedRegistrationChainAdapter, NonRegisteringACKChainAdapter, FlakyRegistrationACKChainAdapter, TransientIdentityFailureChainAdapter, BrandNewCoreTransientChainAdapter, PermanentProfileFailureChainAdapter, RetryPathPermanentFailureChainAdapter, ContextAuthorizedPublisherChainAdapter, buildSnapshotFactQuads, ReferenceEvaluator, loadYaml, CCL_FACT_NS };
export type { Quad, ChainAdapter, CreateOnChainContextGraphParams, CreateOnChainContextGraphResult, OnChainPublishResult, V10PublishDirectParams };
export { OperationalKeyOnlyPublishChainAdapter, ExternalOperationalKeyPublishChainAdapter, AddressOnlyExternalOperationalKeyPublishChainAdapter, AsyncAddressSignMessageAsPublishChainAdapter, GenericSignMessageExternalOperationalKeyPublishChainAdapter, MultiSignerGenericSignMessagePublishChainAdapter, SingleAddressMismatchedGenericSignMessagePublishChainAdapter, SingleSignerAdapterPublishChainAdapter, ReservingAuthorityContextGraphChainAdapter } from './agent.publish-adapters.shared';
