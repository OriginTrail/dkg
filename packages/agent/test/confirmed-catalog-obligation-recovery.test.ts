// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, type CanonicalFinalizationReceipt } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  contextGraphPrivateUri } from '@origintrail-official/dkg-core';
import { ConfirmedCatalogObligationErrorV1, parseConfirmedCatalogObligationRecoveryV1 } from '../src/confirmed-catalog-obligation-error.js';
import { DKGAgent } from '../src/index.js';
import { recoverConfirmedCatalogObligationV1 } from '../src/internal/confirmed-catalog-obligation-recovery.js';
import { authorSealV1, assertionSealV1, AUTHOR, CONTEXT_GRAPH_ID } from './support/rfc64-local-catalog-repair-fixture.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });
async function fixture(archived = false, assertionVersion = '1') {
  const store = new OxigraphStore(); stores.push(store);
  const seal = await authorSealV1(103n, assertionVersion); const raw = assertionSealV1(seal);
  const name = 'confirmed-recovery'; const subject = contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, name);
  const rows = buildAssertionSealQuads({ assertionUri: subject, metaGraph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    merkleRoot: raw.merkleRoot, authorAddress: raw.authorAddress, authorAttestationR: raw.authorAttestationR,
    authorAttestationVS: raw.authorAttestationVS, authorSchemeVersion: raw.authorSchemeVersion,
    chainId: raw.chainId, kav10Address: raw.kav10Address, reservedKaId: raw.reservedKaId!,
    finalizedAtIso: raw.finalizedAtIso, contentScopeVersion: 2, kaUal: raw.kaUal!,
    assertionVersion: raw.assertionVersion!, publicTripleCount: raw.publicTripleCount!, privateTripleCount: raw.privateTripleCount! });
  await store.insert(archived ? rows.map(q => ({ ...q, subject: `${subject}/_recovery_seal`, graph: contextGraphPrivateUri(CONTEXT_GRAPH_ID) })) : rows);
  const chain = new MockChainAdapter(); const txHash = `0x${'ab'.repeat(32)}`;
  const receipt: CanonicalFinalizationReceipt = { txHash, blockNumber: 101, blockHash: `0x${'cd'.repeat(32)}`,
    txIndex: 0, merkleRoot: raw.merkleRoot, publisherAddress: AUTHOR, authorAddress: AUTHOR,
    batchId: raw.reservedKaId!, kaId: raw.reservedKaId!, startKAId: raw.reservedKaId!, endKAId: raw.reservedKaId!,
    knowledgeAssetsContract: raw.kav10Address };
  vi.spyOn(chain, 'resolveCanonicalFinalizationReceipt').mockResolvedValue({ status: 'confirmed', receipt });
  vi.spyOn(chain, 'getKAContextGraphId').mockResolvedValue(1n);
  vi.spyOn(chain, 'getEvmChainId').mockResolvedValue(raw.chainId);
  vi.spyOn(chain, 'getKnowledgeAssetsLifecycleAddress').mockResolvedValue(raw.kav10Address);
  vi.spyOn(chain, 'getDKGKnowledgeAssetsAddress').mockResolvedValue(raw.kav10Address);
  const submit = vi.spyOn(chain, 'publishToContextGraph');
  const observe = vi.fn<Parameters<typeof recoverConfirmedCatalogObligationV1>[1]['observe']>().mockResolvedValue();
  const controller = new AbortController();
  const ports: Parameters<typeof recoverConfirmedCatalogObligationV1>[1] = { chain, store, signal: controller.signal,
    resolveBinding: async () => ({ onChainId: '1' }), assertCurrent: () => controller.signal.throwIfAborted(), observe };
  const evidence = { version: 1 as const, contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: name,
    subGraphName: null, seal, transactionHash: txHash, blockNumber: receipt.blockNumber };
  return { store, chain, submit, observe, controller, ports, evidence, receipt };
}

describe('caller-retained confirmed catalog evidence', () => {
  it.each([false, true])('authenticates the exact %s archived local seal without submitting a transaction', async archived => {
    const f = await fixture(archived);
    await recoverConfirmedCatalogObligationV1(f.evidence, f.ports);
    expect(f.observe).toHaveBeenCalledOnce();
    const params = f.observe.mock.calls[0][0];
    expect(params.seal.reservedKaId?.toString()).toBe(f.evidence.seal.reservedKaId);
    expect(params.seal.authorAttestationR).toEqual(ethers.getBytes(f.evidence.seal.authorAttestationR));
    expect(f.submit).not.toHaveBeenCalled();
  });
  it.each(['graph', 'author', 'root', 'ka', 'deployment', 'chain', 'storage', 'block', 'transaction'] as const)(
    'refuses a canonical receipt with mismatched %s identity', async field => {
      const f = await fixture();
      if (field === 'graph') vi.mocked(f.chain.getKAContextGraphId).mockResolvedValue(2n);
      if (field === 'author') f.receipt.authorAddress = ethers.ZeroAddress;
      if (field === 'root') f.receipt.merkleRoot = ethers.getBytes(`0x${'00'.repeat(32)}`);
      if (field === 'ka') f.receipt.endKAId += 1n;
      if (field === 'deployment') vi.mocked(f.chain.getKnowledgeAssetsLifecycleAddress).mockResolvedValue(ethers.ZeroAddress);
      if (field === 'chain') vi.mocked(f.chain.getEvmChainId).mockResolvedValue(1n);
      if (field === 'storage') f.receipt.knowledgeAssetsContract = ethers.ZeroAddress;
      if (field === 'block') f.receipt.blockNumber += 1;
      if (field === 'transaction') f.receipt.txHash = `0x${'ef'.repeat(32)}`;
      await expect(recoverConfirmedCatalogObligationV1(f.evidence, f.ports)).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
      expect(f.observe).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    });
  it('binds repeated same-root updates to the receipt-specific assertion version', async () => {
    const f = await fixture(false, '3');
    for (const assertionVersion of [undefined, 1n, 2n, 4n]) {
      f.receipt.assertionVersion = assertionVersion;
      await expect(recoverConfirmedCatalogObligationV1(f.evidence, f.ports)).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
      expect(f.observe).not.toHaveBeenCalled();
    }
    f.receipt.assertionVersion = 3n;
    await recoverConfirmedCatalogObligationV1(f.evidence, f.ports);
    expect(f.observe).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.chain.resolveCanonicalFinalizationReceipt).toHaveBeenLastCalledWith(f.evidence.transactionHash,
      { signal: f.controller.signal, expectedBlockNumber: f.evidence.blockNumber, includeKnowledgeAssetUpdates: true });
  });
  it('refuses altered seal bytes, missing local evidence, unconfirmed receipt and invalid wire fields', async () => {
    const f = await fixture();
    for (const evidence of [ { ...f.evidence, seal: { ...f.evidence.seal, authorAttestationR: `0x${'11'.repeat(32)}` } },
      { ...f.evidence, assertionCoordinate: 'missing' }, { ...f.evidence, blockNumber: -1 },
      { ...f.evidence, seal: { ...f.evidence.seal, reservedKaId: 'invalid' } } ]) {
      await expect(Promise.resolve().then(() => recoverConfirmedCatalogObligationV1(parseConfirmedCatalogObligationRecoveryV1(evidence), f.ports))).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
    }
    vi.mocked(f.chain.resolveCanonicalFinalizationReceipt).mockResolvedValue({ status: 'pending' });
    await expect(recoverConfirmedCatalogObligationV1(f.evidence, f.ports)).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
    f.ports.resolveBinding = async () => null;
    await expect(recoverConfirmedCatalogObligationV1(f.evidence, f.ports)).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
    expect(f.observe).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it('owns validated wire fields and rejects accessors, extra fields and malformed seals at the public entry', async () => {
    const f = await fixture();
    const parsed = parseConfirmedCatalogObligationRecoveryV1(f.evidence);
    expect(parsed).toEqual(f.evidence);
    expect(parsed).not.toBe(f.evidence); expect(parsed.seal).not.toBe(f.evidence.seal);
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.seal)).toBe(true);
    const getter = vi.fn(() => f.evidence.seal.authorAddress);
    const accessorSeal = { ...f.evidence.seal };
    Object.defineProperty(accessorSeal, 'authorAddress', { enumerable: true, get: getter });
    const accessor = Object.defineProperty({ ...f.evidence }, 'seal', { enumerable: true, get: getter });
    const hiddenSeal = Object.defineProperty({ ...f.evidence.seal }, 'authorAddress', { enumerable: false, value: AUTHOR });
    const symbolSeal = { ...f.evidence.seal, [Symbol('unexpected')]: true };
    const inheritedSeal = Object.assign(Object.create({ unrelated: true }), f.evidence.seal);
    expect(parseConfirmedCatalogObligationRecoveryV1({ ...f.evidence, seal: Object.assign(Object.create(null), f.evidence.seal) })).toEqual(f.evidence);
    for (const input of [{ ...f.evidence, seal: hiddenSeal }, { ...f.evidence, seal: symbolSeal },
      { ...f.evidence, seal: inheritedSeal }, null, [], { ...f.evidence, extra: true }, accessor,
      { ...f.evidence, seal: accessorSeal }, { ...f.evidence, version: 2 },
      { ...f.evidence, transactionHash: '0x1234' }, { ...f.evidence, blockNumber: 1.5 },
      { ...f.evidence, subGraphName: 'named' }, { ...f.evidence, contextGraphId: 1 },
      { ...f.evidence, seal: { ...f.evidence.seal, reservedKaId: '-1' } }]) {
      await expect(DKGAgent.prototype.recoverRfc64ConfirmedCatalogObligationV1.call(
        Object.create(DKGAgent.prototype), input)).rejects.toMatchObject({ code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(f.chain.resolveCanonicalFinalizationReceipt).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
  });
  it('exports the exact JSON-safe evidence and refuses to imply confirmation without a receipt', async () => {
    const f = await fixture();
    await recoverConfirmedCatalogObligationV1(f.evidence, f.ports);
    const params = f.observe.mock.calls[0][0];
    const error = new ConfirmedCatalogObligationErrorV1(params, f.receipt, new Error('disk refusal'));
    expect(JSON.parse(JSON.stringify(error.recoveryEvidence))).toEqual(f.evidence);
    expect(Object.isFrozen(error.recoveryEvidence)).toBe(true);
    expect(new ConfirmedCatalogObligationErrorV1(params, undefined, new Error('unconfirmed')).recoveryEvidence).toBeUndefined();
  });
  it('retains the acceptance-time lifetime fence after the receipt read awaits', async () => {
    const f = await fixture(); const reason = new Error('generation retired');
    vi.mocked(f.chain.resolveCanonicalFinalizationReceipt).mockImplementation(async () => {
      f.controller.abort(reason); return { status: 'confirmed', receipt: f.receipt };
    });
    await expect(recoverConfirmedCatalogObligationV1(f.evidence, f.ports)).rejects.toBe(reason);
    expect(f.observe).not.toHaveBeenCalled();
  });
});
