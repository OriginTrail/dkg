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
  Object.defineProperty(agent, 'assertion', { value: { history: entered } });
  return { agent, entered, submit, sign, consume, reserve };
}
describe('catalog-compatible named publication admission', () => {
  for (const lane of lanes) {
    it.each(invalidIdentities)(`${lane.name} rejects $name/$contextGraphId before publication preparation`, async identity => {
      const f = fixture();
      await expect(lane.run(f.agent, identity.contextGraphId, identity.name)).rejects.toMatchObject({
        name: 'AuthorCatalogCodecError',
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
      .rejects.toMatchObject({ name: 'AuthorCatalogCodecError' });
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
