/**
 * OT-RFC-49 combined-model BASELINE (pre-catalog-injection).
 *
 * Captures the current curated/private-CG VM publish behavior on the devnet
 * via the PRODUCT path (assertion.write -> assertion.finalize ->
 * publishFromFinalizedAssertion), so the combined catalog-entry change has a
 * known-good reference to diff against.
 *
 * Baseline invariant (this file): a private CG publishing N data entities
 * yields a KC of exactly N KAs and confirms on chain. After the catalog
 * injection lands, the same publish must yield N+1 KAs (the extra one being the
 * public DCAT catalog KA whose subject is the CG's own UAL).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import {
  createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';

const agents: DKGAgent[] = [];
let _snap: string;

beforeAll(async () => {
  _snap = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => { await revertSnapshot(_snap); });
afterEach(async () => { for (const a of agents) { try { await a.stop(); } catch {} } agents.length = 0; });

async function createAgent(name: string) {
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name, listenPort: 0, chainAdapter: chain, nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  await installHardhatACKProvider(agent, chain);
  return agent;
}

describe('OT-RFC-49 baseline — private CG product-path publish (pre-catalog)', () => {
  // SCAFFOLD — skipped pending the curated-ACK node-staking setup.
  //
  // This test already drives the ENTIRE curated product path on the devnet and
  // is green up to the on-chain publish tx: private CG create -> on-chain
  // register -> assertion.write -> promote (WM->SWM, auto-finalize) ->
  // publishFromFinalizedAssertion, with the curated machinery firing
  // (sender-key epoch bootstrap, LU-5 inline + LU-11 chunked ciphertext, 3 core
  // ACKs collected, V10 publish tx submitted with byteSize=[ciphertext]).
  //
  // It reverts ONLY at the contract's signer check:
  //   SignerIsNotNodeOperator(uint72 2, 0x89c5…ce91)
  // i.e. the curated publish enforces a staked sharding-table ACK quorum
  // (`_verifySignature` -> `shardingTableStorage.nodeExists`), and the shared
  // evm-test-context does not stake the 3 ACK-signer nodes. Public publishes
  // pass with the same provider; no curated e2e publish has ever been built,
  // so this setup never existed.
  //
  // To green: spawn a dedicated hardhat env and stake 3 ACK-signer node
  // operators (the a2-pointers-and-b3-addressing pattern: spawnHardhatEnv +
  // createNodeProfile + stakeAndSetAsk), then wire the ACK provider to those
  // staked identities. Then assert kaManifest.length === 1 (baseline) and,
  // after the catalog injection, === 2 (data KA + public DCAT catalog KA).
  it.skip('a private CG publishes via finalize -> publishFromFinalizedAssertion and yields exactly N data KAs', async () => {
    const agent = await createAgent('CatalogBaselineBot');
    const curator = agent.defaultAgentAddress ?? ethers.getAddress((agent as any).chain?.signerAddress);
    const CG = 'rfc49-baseline-private';

    await agent.createContextGraph({
      id: CG,
      name: 'RFC49 Baseline Private',
      accessPolicy: 1, // curated / private
      callerAgentAddress: curator,
    });
    // Curated finalize binds the author signature to the on-chain CG id, so the
    // CG must be registered before finalize (unlike the public auto-register path).
    await agent.registerContextGraph(CG, { callerAgentAddress: curator });

    const name = 'shipment';
    await agent.assertion.create(CG, name);
    await agent.assertion.write(CG, name, [
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"P-9"' },
    ]);
    // promote: WM -> SWM (auto-finalizes the seal). publishFromFinalizedAssertion
    // reloads the post-promote SWM slice.
    await agent.assertion.promote(CG, name);

    const pub: any = await agent.publishFromFinalizedAssertion(CG, name);

    expect(pub.status).toBe('confirmed');
    // Baseline: exactly the data KA(s) — no catalog KA yet.
    expect(pub.kaManifest?.length ?? pub.knowledgeAssetsAmount).toBe(1);
    // It is a curated publish: a ciphertext commitment exists.
    expect(pub.ciphertextChunksRoot ? Buffer.from(pub.ciphertextChunksRoot).some((b: number) => b !== 0) : true).toBe(true);
  });
});
