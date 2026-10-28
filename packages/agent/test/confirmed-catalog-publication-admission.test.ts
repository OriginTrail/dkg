import { buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri, ASSERTION_SEAL_PREDICATES } from '@origintrail-official/dkg-core';
import { assertConfirmedCatalogPublicationAdmissionV1, normalizeConfirmedPublicationV1 } from '../src/internal/confirmed-catalog-obligation.js';
import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { confirmedPublicationCatalogConfigV1 } from './support/confirmed-publication-harness.js';

const CG = '0x1111111111111111111111111111111111111111/catalog-admission';
const invalidIdentities = [
  { name: '界'.repeat(100), contextGraphId: CG },
  { name: 'e\u0301', contextGraphId: CG },
  { name: '界'.repeat(85) + 'aa', contextGraphId: CG },
  { name: 'asset', contextGraphId: '0x1111111111111111111111111111111111111111/e\u0301' },
];
const request = (contextGraphId: string, name: string): KnowledgeAssetVmPublishRequest => ({
  contextGraphId, name, agentAddress: '0x1111111111111111111111111111111111111111',
  shareOperationId: 'retained-share', roots: [], contentScopeVersion: 2,
  kaUal: 'did:dkg:hardhat:31337/0x1111111111111111111111111111111111111111/1',
  assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0, accessPolicy: 'public',
  intentKey: `sha256:${'ab'.repeat(32)}`,
  seal: { merkleRoot: `0x${'ab'.repeat(32)}`, authorAddress: '0x1111111111111111111111111111111111111111',
    reservedKaId: '1', schemeVersion: 1, signature: { r: `0x${'01'.repeat(32)}`, vs: `0x${'02'.repeat(32)}` } },
  sealChainId: '31337', sealKav10Address: '0x2222222222222222222222222222222222222222',
  sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: `0x${'ab'.repeat(32)}`,
});
const lanes = [
  { name: 'synchronous create/update', run: (agent: DKGAgent, cg: string, name: string) => agent.publishFromFinalizedAssertion(cg, name) },
  { name: 'queue admission create/update', run: (agent: DKGAgent, cg: string, name: string) => agent.resolveFinalizedAssertionVmPublishIntent(cg, name) },
  { name: 'saved queue execution preflight', run: (agent: DKGAgent, cg: string, name: string) => agent.preflightQueuedKnowledgeAssetVmPublishExecution(request(cg, name)) },
  { name: 'saved queue snapshot admission', run: (agent: DKGAgent, cg: string, name: string) => agent.preflightKnowledgeAssetVmPublishSnapshot(request(cg, name)) },
  { name: 'saved queue direct execution', run: (agent: DKGAgent, cg: string, name: string) => agent.publishQueuedKnowledgeAssetVmPublish(request(cg, name), {}) },
];
function fixture(enabled = true) {
  const entered = vi.fn(() => { throw new Error('publication preparation entered'); });
  const submit = vi.fn(); const sign = vi.fn(); const consume = vi.fn(); const reserve = vi.fn();
  const agent = Object.assign(Object.create(DKGAgent.prototype), {
    config: confirmedPublicationCatalogConfigV1(enabled), resolveFinalizedAssertionPublishAuthor: entered,
    store: { query: entered, insert: consume },
    publisher: { publish: submit, update: submit, clearSwmShareComplete: consume, reserveKaId: reserve },
    chain: { publishToContextGraph: submit, updateKnowledgeAsset: submit },
    _buildPrecomputedUpdateAttestationForSeal: sign,
  }) as DKGAgent;
  Object.defineProperty(agent, 'assertion', { value: { history: entered }, configurable: true });
  return { agent, entered, submit, sign, consume, reserve };
}
describe('catalog-compatible named publication admission', () => {
  for (const lane of lanes) {
    it.each(invalidIdentities)(`${lane.name} rejects $name/$contextGraphId before publication preparation`, async identity => {
      const f = fixture();
      await expect(lane.run(f.agent, identity.contextGraphId, identity.name)).rejects.toMatchObject({
        name: 'CatalogPublicationAdmissionError', code: 'CATALOG_PUBLICATION_ADMISSION_INVALID',
      });
      expect(f.entered).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    });
  }
  it('refuses an incompatible graph before raw publishAsync stages or reserves an assertion', async () => {
    const f = fixture();
    const exists = vi.fn(); Object.assign(f.agent, { contextGraphExists: exists });
    await expect(f.agent.publishAsync(invalidIdentities[3].contextGraphId, { publicQuads: [], privateQuads: [] }))
      .rejects.toMatchObject({ name: 'CatalogPublicationAdmissionError', code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' });
    expect(exists).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it.each(['界'.repeat(85), '界'.repeat(85) + 'a', 'é', 'a'.repeat(256)])('keeps the exact valid UTF8/NFC identity %s', async name => {
    const f = fixture();
    await expect(f.agent.publishFromFinalizedAssertion(CG, name)).rejects.toThrow('publication preparation entered');
    expect(f.entered).toHaveBeenCalledWith(CG, name, undefined);
  });
  it.each(invalidIdentities)('preserves excluded catalog publication identity $name', async identity => {
    const f = fixture(false);
    await expect(f.agent.publishFromFinalizedAssertion(identity.contextGraphId, identity.name))
      .rejects.toThrow('publication preparation entered');
    expect(f.entered).toHaveBeenCalledWith(identity.contextGraphId, identity.name, undefined);
  });
});

it.each(['snapshot', 'preflight', 'execute'] as const)('honors persisted exclusion after catalog enablement at %s', async boundary => {
  const f = fixture(true);
  const saved = { ...request(CG, '界'.repeat(100)), catalogObligationRequired: false };
  const error = await (boundary === 'snapshot' ? f.agent.preflightKnowledgeAssetVmPublishSnapshot(saved)
    : boundary === 'preflight' ? f.agent.preflightQueuedKnowledgeAssetVmPublishExecution(saved)
    : f.agent.publishQueuedKnowledgeAssetVmPublish(saved, {})).catch(error => error);
  expect(error).not.toMatchObject({ name: 'CatalogPublicationAdmissionError', code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' });
  const required = { ...saved, catalogObligationRequired: true };
  Object.assign((f.agent as any).config, confirmedPublicationCatalogConfigV1(false));
  await expect(boundary === 'snapshot' ? f.agent.preflightKnowledgeAssetVmPublishSnapshot(required)
    : boundary === 'preflight' ? f.agent.preflightQueuedKnowledgeAssetVmPublishExecution(required)
    : f.agent.publishQueuedKnowledgeAssetVmPublish(required, {})).rejects.toMatchObject({ name: 'CatalogPublicationAdmissionError', code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' });
});


it.each(lanes)('$name maps invalid graph identities under default responsibility selection', async lane => {
  const f = fixture();
  Object.assign((f.agent as any).config, { rfc64CatalogAuthoringPolicy: undefined });
  await expect(lane.run(f.agent, invalidIdentities[3].contextGraphId, 'asset')).rejects.toMatchObject({
    name: 'CatalogPublicationAdmissionError', code: 'CATALOG_PUBLICATION_ADMISSION_INVALID',
  });
  expect(f.entered).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});

it('preserves unrelated authority errors during default responsibility selection', async () => {
  const f = fixture(), failure = new Error('authority storage unavailable');
  Object.assign((f.agent as any).config, { rfc64CatalogAuthoringPolicy: undefined });
  vi.spyOn(f.agent, 'readRfc64CatalogResponsibilityV1').mockImplementation(() => { throw failure; });
  await expect(f.agent.publishFromFinalizedAssertion(CG, 'asset')).rejects.toBe(failure);
  expect(f.entered).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
});

it('refuses persisted root obligations attached to a named subgraph at both boundaries', () => {
  const f = fixture(), identity = { contextGraphId: CG, assertionCoordinate: 'asset', subGraphName: 'documents', catalogObligationRequired: true };
  const config = (f.agent as any).config;
  expect(() => assertConfirmedCatalogPublicationAdmissionV1(f.agent,
    { plan: config.rfc64CatalogExecutionPlan, authoring: config.rfc64CatalogAuthoringPolicy }, identity))
    .toThrow('root graph identity');
  // The normalization guard runs before any seal, persistence or placement work.
  expect(() => normalizeConfirmedPublicationV1(identity as Parameters<typeof normalizeConfirmedPublicationV1>[0],
    () => { throw new Error('persisted selection must not be recomputed'); })).toThrow('root graph identity');
});


it.each(lanes)('$name rejects a catalog-incompatible legacy seal before sending', async lane => {
  const f = fixture(), saved = request(CG, 'asset');
  const assertionUri = contextGraphAssertionUri(CG, saved.agentAddress!, saved.name);
  const rows = buildAssertionSealQuads({ assertionUri, metaGraph: contextGraphMetaUri(CG),
    merkleRoot: new Uint8Array(32).fill(0xab), authorAddress: saved.seal.authorAddress,
    authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1, chainId: 31337n, kav10Address: saved.sealKav10Address,
    reservedKaId: (BigInt(saved.seal.authorAddress) << 96n) | 1n,
    finalizedAtIso: saved.sealFinalizedAtIso, contentScopeVersion: 2, kaUal: saved.kaUal!,
    assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0 })
    .filter(q => q.predicate !== ASSERTION_SEAL_PREDICATES.RESERVED_KA_ID);
  const legacy = { ...saved, seal: { ...saved.seal, reservedKaId: undefined } };
  Object.assign(f.agent, { resolveFinalizedAssertionPublishAuthor: async () => saved.agentAddress,
    store: { query: vi.fn(async () => ({ type: 'quads', quads: rows })) } });
  Object.defineProperty(f.agent, 'assertion', { value: { history: async () => ({}) }, configurable: true });
  Object.assign(f.agent.publisher, { hasSwmShareComplete: async () => true });
  const operation = lane.name === 'saved queue execution preflight' ? f.agent.preflightQueuedKnowledgeAssetVmPublishExecution(legacy)
    : lane.name === 'saved queue snapshot admission' ? f.agent.preflightKnowledgeAssetVmPublishSnapshot(legacy)
    : lane.name === 'saved queue direct execution' ? f.agent.publishQueuedKnowledgeAssetVmPublish(legacy, {})
    : lane.run(f.agent, CG, 'asset');
  await expect(operation).rejects.toMatchObject({ code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' });
  expect(f.submit).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});


it.each([true, false])('refuses empty subgraphs before publication preparation (catalog enabled=%s)', async enabled => {
  const f = fixture(enabled);
  const operations = [
    () => f.agent.publishFromFinalizedAssertion(CG, 'asset', { subGraphName: '' }),
    () => f.agent.resolveFinalizedAssertionVmPublishIntent(CG, 'asset', { subGraphName: '' }),
    ...[undefined, false, true].flatMap(catalogObligationRequired => {
      const saved = { ...request(CG, 'asset'), subGraphName: '', catalogObligationRequired };
      return [() => f.agent.preflightQueuedKnowledgeAssetVmPublishExecution(saved),
        () => f.agent.preflightKnowledgeAssetVmPublishSnapshot(saved),
        () => f.agent.publishQueuedKnowledgeAssetVmPublish(saved, {})];
    }),
  ];
  for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' });
  expect(f.entered).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
});
