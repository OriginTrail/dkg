import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SemanticRuntimeStore, hashCanonicalPlan } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';
import { expect, it, vi } from 'vitest';
import { createAssetCreationAdapter } from '../src/semantic-runtime-asset-adapter.js';
const graph = 'native-assets';
const dt = (value: string) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
const quad = (object: string) => ({ subject: 'urn:asset:1', predicate: 'urn:observed', object });
async function fixture(object: string) {
  const dir = mkdtempSync(join(tmpdir(), 'native-assets-')), path = join(dir, 'journal.sqlite');
  let journal = new SemanticRuntimeStore(path);
  const store = new OxigraphStore(), chain = new MockChainAdapter();
  const executor = new ethers.Wallet('0x' + '11'.repeat(32)), fallback = new ethers.Wallet('0x' + '22'.repeat(32));
  const publisher = new DKGPublisher({ store, chain, eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair(), publisherPrivateKey: fallback.privateKey });
  const agent = Object.create(DKGAgent.prototype);
  Object.assign(agent, { store, publisher, chain, config: {}, defaultAgentAddress: fallback.address,
    reconciledKaAuthors: new Set(), localAgents: new Map([[executor.address, { name: 'executor', agentAddress: executor.address, mode: 'custodial', privateKey: executor.privateKey }]]),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    probeContextGraphWritePreflight: async () => ({ storeAvailable: true, exists: true, callerAuthorized: true, hasLocalContent: true }) });
  Object.defineProperty(agent, 'peerId', { value: 'native-assets-node' });
  let next = 1n;
  agent.kaNumberAllocator = new KaNumberAllocator({ allocate: () => next++, reconcileFloor() {}, peekNext: () => next });
  const native = agent.assertion;
  const assertion = Object.fromEntries(Object.entries(native).map(([key, fn]) => [key, typeof fn === 'function' ? vi.fn((...args: any[]) => (fn as any)(...args)) : fn])) as any;
  Object.defineProperty(agent, 'assertion', { value: assertion });
  const bytes = new Uint8Array(32).fill(1), plan = new Uint8Array([1]), planId = hashCanonicalPlan(plan);
  journal.registerStrategyArtifact({ artifactHash: planId, strategyId: 'native', version: '1', canonicalPlan: plan, sourceRef: 'urn:native', reviewState: 'approved', createdAt: 1 });
  journal.createExecution({ executionId: 'exec', planId, partitionId: 'native', status: 'active', graphRevision: 'pinned', policyEpoch: 1n, rootProcessId: 'root', leaseEpoch: 0n });
  journal.putCapability({ capabilityId: 'cap', executionId: 'exec', metadataCbor: bytes, hostBindingKey: 'native', policyEpoch: 1n, notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER, oneShot: false, consumedAt: null, revokedAt: null });
  journal.prepareEffect({ effectId: 'effect', executionId: 'exec', processId: 'root', stepId: 'step', attemptId: 'attempt', idempotencyKey: 'effect', idempotencyClass: 'conditionally_idempotent', requestDigest: bytes, normalizedInput: bytes, capabilityId: 'cap', policyDecisionId: 'decision', approvalId: null, adapterId: 'dkg/asset-create', adapterVersion: '1', verb: 'create-asset', resource: graph, reconciliationRule: 'readback', compensationRule: null, budgetReservation: 0n, preparedAt: 1, authorization: { decisionId: 'decision', policyId: 'policy', policyEpoch: 1n, factsDigest: bytes, principal: executor.address, reasonCode: 'ALLOW' } });
  let allowed = true;
  const adapter = () => createAssetCreationAdapter(agent, graph, 'wm', executor.address, journal, async () => { if (!allowed) throw new Error('revoked'); });
  const input = adapter().validateInput({ quads: [quad(object)] });
  return { assertion, executor, input, store, journal: () => journal,
    run: () => adapter().dispatch({ effectId: 'effect', requestDigest: bytes } as any, input),
    reopen() { journal.close(); journal = new SemanticRuntimeStore(path); }, revoke() { allowed = false; },
    async close() { journal.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
it.each(['.000', '.100', '.300', '.630', '.3001'])('seals typed-date %s with non-default executor and recovers a committed write across reopen', async fraction => {
  const f = await fixture(dt(`2026-11-03T10:40:28${fraction}Z`));
  try {
    const write = f.assertion.write.getMockImplementation();
    f.assertion.write.mockImplementationOnce(async (...args: any[]) => { await write(...args); throw new Error('lost write response'); });
    await expect(f.run()).rejects.toThrow('lost write response');
    const before = f.journal().effect('effect')!.requestDigest; f.reopen();
    const result = await f.run(); expect(result.status).toBe('succeeded');
    const receipt = JSON.parse((result as any).output);
    expect(receipt.authorAgentAddress).toBe(f.executor.address);
    expect(f.assertion.finalize).toHaveBeenCalledWith(graph, receipt.name, { agentAddress: f.executor.address, authorAgentAddress: f.executor.address });
    expect((await f.assertion.history(graph, receipt.name, { agentAddress: f.executor.address })).wmCurrentAssertion).toBe(receipt.assertion);
    expect(f.assertion.create).toHaveBeenCalledTimes(1); expect(f.assertion.write).toHaveBeenCalledTimes(1);
    expect(f.journal().effect('effect')!.requestDigest).toEqual(before);
    f.reopen(); expect(await f.run()).toEqual(result); expect(f.assertion.finalize).toHaveBeenCalledTimes(1);
    f.revoke(); await expect(f.run()).rejects.toThrow('revoked');
  } finally { await f.close(); }
});
it.each([
  [dt('2026-11-03T11:40:28.300+01:00'), true], [dt('2026-11-03T10:40:28.301Z'), false],
  [dt('2026-11-03T10:40:28.3001Z'), false], ['"2026-11-03T10:40:28.300Z"', false], ['urn:different', false],
] as const)('compares owned partial writes by exact typed value: %s', async (stored, equal) => {
  const f = await fixture(dt('2026-11-03T10:40:28.300Z'));
  try {
    const write = f.assertion.write.getMockImplementation();
    f.assertion.write.mockImplementationOnce(async (g: string, n: string, _q: unknown, lane: unknown) => { await write(g, n, [quad(stored)], lane); throw new Error('lost response'); });
    await expect(f.run()).rejects.toThrow('lost response'); f.reopen();
    if (equal) expect((await f.run()).status).toBe('succeeded');
    else { await expect(f.run()).rejects.toThrow('ASSET_CONTENT_CONFLICT'); expect(f.assertion.finalize).not.toHaveBeenCalled(); }
    expect(f.assertion.write).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
