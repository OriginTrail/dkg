// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataGraphUri, contextGraphMetaUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, KaNumberAllocator } from '../src/index.js';
import { makeTestKaNumberStore } from './_helpers/ka-allocator.js';
import { resolveKnowledgeAssetRead, type KnowledgeAssetReadInput, type KnowledgeAssetReadOptions } from '../src/knowledge-asset-read-resolution.js';

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
  const readDraftAuthority = async (options: KnowledgeAssetReadOptions, target: Partial<KnowledgeAssetReadInput> = {}) =>
    (await resolveKnowledgeAssetRead(agent, { cg: CG, name: 'asset', agentAddress: owner, read: 'quads', ...target }, options)).decision;
  afterAll(async () => { try { await agent?.stop(); } finally { await store.close(); } });

  it('narrows the node grant only for the real curator own draft lane', async () => {
    expect(await readDraftAuthority({ callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'caller', reason: 'local-curator-draft' });
    for (const [callerAgentAddress, agentAddress] of [[owner, undefined], [owner, other], [other, other]]) {
      expect(await readDraftAuthority({ callerAgentAddress }, { agentAddress }))
        .toMatchObject({ outcome: 'allowed', grantScope: 'node' });
    }
    expect(await agent.resolveContextGraphReadAuthority(CG, { callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'node' });
  });

  it('does not promote node scope from curator evidence without local-create provenance', async () => {
    expect(agent.curatorDidMatchesChecksumAgent((await agent.getContextGraphCurator(CG)) ?? undefined, owner)).toBe(true);
    const local = vi.spyOn(agent, 'isLocalFirstUnregisteredContextGraph').mockResolvedValue(false);
    try {
      expect(await readDraftAuthority({
        callerAgentAddress: owner,
      })).toMatchObject({ outcome: 'allowed', grantScope: 'node', source: 'legacy-local' });
      expect(local).toHaveBeenCalledWith(CG);
    } finally { local.mockRestore(); }
  });

  it('requires the caller-lane literal lifecycle before overriding a foreign compact alias', async () => {
    expect(await readDraftAuthority({
      callerAgentAddress: owner,
    }, { name: `${other}:5` })).toMatchObject({ outcome: 'allowed', grantScope: 'caller' });
    expect(await readDraftAuthority({
      callerAgentAddress: owner,
    }, { name: `${other}:6` })).toMatchObject({ outcome: 'allowed', grantScope: 'node' });
  });

  it('settles graph authority before any literal or curator lookup', async () => {
    const authority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValueOnce({
      outcome: 'denied', source: 'registered-chain', reason: 'not-a-member', grantScope: 'none', metadataBootstrap: 'forbidden',
    });
    const meta = vi.spyOn(agent, 'getCgMeta');
    const assertion = agent.assertion;
    const history = vi.spyOn(assertion, 'history');
    const facade = vi.spyOn(agent, 'assertion', 'get').mockReturnValue(assertion);
    try {
      expect(await resolveKnowledgeAssetRead(agent, { cg: CG, name: `${other}:5`, agentAddress: owner, read: 'descriptor' },
        { callerAgentAddress: owner })).toMatchObject({ decision: { outcome: 'denied' }, target: null });
      expect(meta).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    } finally { facade.mockRestore(); history.mockRestore(); meta.mockRestore(); authority.mockRestore(); }
  });

  it('uses one caller-lane literal lookup for admission and the resolved resource', async () => {
    const assertion = agent.assertion;
    const history = vi.spyOn(assertion, 'history');
    const facade = vi.spyOn(agent, 'assertion', 'get').mockReturnValue(assertion);
    try {
      expect(await resolveKnowledgeAssetRead(agent, { cg: CG, name: `${other}:5`, agentAddress: owner, read: 'descriptor' },
        { callerAgentAddress: owner })).toMatchObject({ decision: { grantScope: 'caller' }, target: { name: `${other}:5` } });
      expect(history).toHaveBeenCalledTimes(1);
    } finally { facade.mockRestore(); history.mockRestore(); }
  });

  it('admits extraction as an actor-owned literal without an assertion lookup', async () => {
    const name = `${other}:987654`;
    const assertion = agent.assertion;
    const history = vi.spyOn(assertion, 'history');
    const facade = vi.spyOn(agent, 'assertion', 'get').mockReturnValue(assertion);
    try {
      expect(await resolveKnowledgeAssetRead(agent, { cg: CG, name, agentAddress: other, layer: 'wm', read: 'extraction-status' },
        { callerAgentAddress: owner })).toMatchObject({ decision: { grantScope: 'caller' },
        target: { kind: 'name', name, agentAddress: owner, descriptor: null } });
      expect(history).not.toHaveBeenCalled();
    } finally { facade.mockRestore(); history.mockRestore(); }
  });

  it('does not fall through to an alias after cancellation during its literal lookup', async () => {
    const controller = new AbortController();
    const reason = new Error('caller disconnected during literal history');
    const assertion = agent.assertion;
    const history = vi.spyOn(assertion, 'history').mockImplementationOnce(async () => {
      controller.abort(reason);
      return null;
    });
    const alias = vi.spyOn(assertion, 'resolveByKaId');
    const facade = vi.spyOn(agent, 'assertion', 'get').mockReturnValue(assertion);
    try {
      await expect(resolveKnowledgeAssetRead(agent, { cg: CG, name: `${owner}:55`, agentAddress: owner, read: 'descriptor' },
        { callerAgentAddress: owner, signal: controller.signal })).rejects.toBe(reason);
      expect(alias).not.toHaveBeenCalled();
    } finally { facade.mockRestore(); alias.mockRestore(); history.mockRestore(); }
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
      expect(await readDraftAuthority({ callerAgentAddress: owner }))
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
      await expect(readDraftAuthority({
        callerAgentAddress: owner, signal: controller.signal,
      })).rejects.toBe(reason);
    } finally { meta.mockRestore(); authority.mockRestore(); }
  });
});
