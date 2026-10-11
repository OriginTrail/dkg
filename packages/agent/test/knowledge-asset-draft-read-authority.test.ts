// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataGraphUri, contextGraphMetaUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, KaNumberAllocator } from '../src/index.js';
import { makeTestKaNumberStore } from './_helpers/ka-allocator.js';
import { resolveKnowledgeAssetDraftReadAuthority } from '../src/context-graph-read-authority.js';

const CG = 'draft-read-authority-owner';

describe('dedicated draft authority retains the general graph-read contract', () => {
  const store = new OxigraphStore();
  let agent: DKGAgent;
  let owner: string;
  let other: string;
  beforeAll(async () => {
    agent = await DKGAgent.create({ name: CG, store, chainAdapter: new MockChainAdapter(),
      kaNumberAllocator: new KaNumberAllocator(makeTestKaNumberStore()), nodeRole: 'edge', listenHost: '127.0.0.1', listenPort: 0 });
    await agent.start();
    owner = (await agent.registerAgent('owner')).agentAddress;
    other = (await agent.registerAgent('other')).agentAddress;
    await agent.createContextGraph({ id: CG, name: CG, accessPolicy: 1, callerAgentAddress: owner });
    await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: contextGraphDataGraphUri(CG),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT });
    await agent.renameContextGraph(CG, CG, owner);
    await agent.assertion.create(CG, `${other}:5`, { agentAddress: owner });
    expect(await agent.resolveContextGraphReadAuthority(CG, { callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'node', source: 'legacy-local' });
  });
  afterAll(async () => { try { await agent?.stop(); } finally { await store.close(); } });

  it('narrows the node grant only for the real curator own draft lane', async () => {
    expect(await resolveKnowledgeAssetDraftReadAuthority(agent, CG, { callerAgentAddress: owner, draft: { agentAddress: owner } }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'caller', reason: 'local-curator-draft' });
    for (const options of [{ callerAgentAddress: owner },
      { callerAgentAddress: owner, draft: { agentAddress: other } },
      { callerAgentAddress: other, draft: { agentAddress: other } }]) {
      expect(await resolveKnowledgeAssetDraftReadAuthority(agent, CG, options))
        .toMatchObject({ outcome: 'allowed', grantScope: 'node' });
    }
    expect(await agent.resolveContextGraphReadAuthority(CG, { callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'node' });
  });

  it('requires the caller-lane literal lifecycle before overriding a foreign compact alias', async () => {
    expect(await resolveKnowledgeAssetDraftReadAuthority(agent, CG, {
      callerAgentAddress: owner, draft: { agentAddress: owner, literalName: `${other}:5` },
    })).toMatchObject({ outcome: 'allowed', grantScope: 'caller' });
    expect(await resolveKnowledgeAssetDraftReadAuthority(agent, CG, {
      callerAgentAddress: owner, draft: { agentAddress: owner, literalName: `${other}:6` },
    })).toMatchObject({ outcome: 'allowed', grantScope: 'node' });
  });

  it('returns unavailable when later provenance read fails after real node authority settled', async () => {
    const originalAuthority = agent.resolveContextGraphReadAuthority.bind(agent);
    const originalMeta = agent.getCgMeta.bind(agent);
    let settled = false;
    const authority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async (...args) => {
      const decision = await originalAuthority(...args);
      expect(decision).toMatchObject({ outcome: 'allowed', grantScope: 'node' });
      settled = true;
      return decision;
    });
    const meta = vi.spyOn(agent, 'getCgMeta').mockImplementation(async (...args) => {
      if (settled) throw new Error('draft metadata unavailable');
      return originalMeta(...args);
    });
    try {
      expect(await resolveKnowledgeAssetDraftReadAuthority(agent, CG, { callerAgentAddress: owner, draft: { agentAddress: owner } }))
        .toMatchObject({ outcome: 'unavailable', source: 'legacy-local', reason: 'draft-provenance-unavailable' });
    } finally { meta.mockRestore(); authority.mockRestore(); }
  });

  it('keeps caller cancellation after held provenance as cancellation', async () => {
    const controller = new AbortController();
    const originalMeta = agent.getCgMeta.bind(agent);
    const originalAuthority = agent.resolveContextGraphReadAuthority.bind(agent);
    let settled = false;
    const authority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async (...args) => {
      const decision = await originalAuthority(...args); settled = true; return decision;
    });
    const reason = new Error('caller disconnected');
    const meta = vi.spyOn(agent, 'getCgMeta').mockImplementation(async (...args) => {
      const result = await originalMeta(...args);
      if (settled) controller.abort(reason);
      return result;
    });
    try {
      await expect(resolveKnowledgeAssetDraftReadAuthority(agent, CG, {
        callerAgentAddress: owner, draft: { agentAddress: owner }, signal: controller.signal,
      })).rejects.toBe(reason);
    } finally { meta.mockRestore(); authority.mockRestore(); }
  });
});
