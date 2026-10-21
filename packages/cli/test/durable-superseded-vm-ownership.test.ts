import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-agent', () => import('../../agent/src/index.js'));
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import { ASSERTION_SEAL_PREDICATES, assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri,
  contextGraphMetaUri, createOperationContext, type AssertionSeal, type TimestampMsV1 } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata, skolemizeKnowledgeAssetParts } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../../agent/src/index.js';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { AUTHOR, AUTHOR_WALLET, CONTEXT_GRAPH_ID, NETWORK_ID, PROJECTION_QUADS, assertionSealV1, authorSealV1,
  catalogScopeDigestV1, seedDurableWorkspaceAssetV1, startRepairAgentV1 } from '../../agent/test/support/rfc64-local-catalog-repair-fixture.js';
import { startPlacementAgentV1, untilV1, type PlacementAgentV1 } from '../../agent/test/support/rfc64-publication-placement-fixture.js';
import { durableSynchronousShare } from '../src/daemon/routes/durable-synchronous-share.js';
import { daemonState } from '../src/daemon/state.js';
import { runPromoteJob } from '../src/daemon/worker/async-promote-worker.js';
import { executePromoteRequest } from '../src/daemon/worker/execute-promote-request.js';

const NAME = 'superseded-asset', KA_NUMBER = 77n;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = '<http://www.w3.org/2001/XMLSchema#integer>';
const META = contextGraphMetaUri(CONTEXT_GRAPH_ID);
const LIFECYCLE = assertionLifecycleUri(CONTEXT_GRAPH_ID, AUTHOR, NAME);
const OWNER = { contextGraphId: CONTEXT_GRAPH_ID, assertionName: NAME, agentAddress: AUTHOR };

afterEach(() => { daemonState.promoteWorkerAvailable = false; });

/** Queue timing only: the replay below is claimed and run explicitly. */
function configureQueue(agent: DKGAgent) { agent.configurePromoteQueue({ backoff: () => 0, maxRetries: 1 }); }

/** The author's assertion, finalized through the real publisher and sealed with the deployment's signed attestation. */
async function finalizeAuthorAsset(agent: DKGAgent) {
  const { publisher, store } = agent;
  const canonical = await authorSealV1(KA_NUMBER);
  await publisher.assertionCreate(CONTEXT_GRAPH_ID, NAME, AUTHOR);
  // The deployment's reserved identity, as a KA-number allocator records it at creation.
  for (const predicate of [`${DKG}kaId`, `${DKG}reservedUal`]) await store.deleteByPattern({ graph: META, subject: LIFECYCLE, predicate });
  await store.insert([
    { graph: META, subject: LIFECYCLE, predicate: `${DKG}kaId`, object: `"${KA_NUMBER}"^^${XSD_INTEGER}` },
    { graph: META, subject: LIFECYCLE, predicate: `${DKG}reservedUal`, object: `"${canonical.kaUal}"` },
  ]);
  await publisher.assertionWrite(CONTEXT_GRAPH_ID, NAME, AUTHOR, PROJECTION_QUADS.map(q => ({ ...q })));
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CONTEXT_GRAPH_ID, name: NAME, agentAddress: AUTHOR });
  const seal = assertionSealV1(canonical);
  expect(finalized).toMatchObject({ kaUal: seal.kaUal, assertionVersion: seal.assertionVersion });
  const assertionUri = contextGraphAssertionUri(CONTEXT_GRAPH_ID, AUTHOR, NAME);
  for (const predicate of Object.values(ASSERTION_SEAL_PREDICATES)) await store.deleteByPattern({ graph: META, subject: assertionUri, predicate });
  await store.insert(buildAssertionSealQuads({ assertionUri, metaGraph: META, merkleRoot: seal.merkleRoot,
    authorAddress: seal.authorAddress, authorAttestationR: seal.authorAttestationR, authorAttestationVS: seal.authorAttestationVS,
    authorSchemeVersion: seal.authorSchemeVersion, chainId: seal.chainId, kav10Address: seal.kav10Address,
    reservedKaId: seal.reservedKaId!, finalizedAtIso: seal.finalizedAtIso, contentScopeVersion: seal.contentScopeVersion!,
    kaUal: seal.kaUal!, assertionVersion: seal.assertionVersion!, publicTripleCount: seal.publicTripleCount!,
    privateTripleCount: seal.privateTripleCount! }));
  return { finalized, seal };
}

async function graphContent(agent: DKGAgent, graph: string) {
  return agent.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
}

/** VM publish of the admitted version, then a confirmed update of a strictly newer version in the same per-asset VM graph. */
async function publishThenConfirmUpdate(agent: DKGAgent, finalized: Awaited<ReturnType<typeof finalizeAuthorAsset>>['finalized'], seal: AssertionSeal) {
  const { store } = agent;
  const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
  await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
  await store.deleteByPattern({ graph: META, subject: LIFECYCLE, predicate: `${DKG}memoryLayer` });
  await store.insert([{ graph: META, subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"VM"' }]);
  await agent.publisher.clearSwmShareComplete(CONTEXT_GRAPH_ID, NAME, AUTHOR);
  const updated: Quad[] = [{ subject: 'https://example.org/alice', predicate: 'https://schema.org/name', object: '"Alice, updated"', graph: '' }];
  await store.deleteByPattern({ graph: vm });
  await store.insert(updated.map(q => ({ ...q, graph: vm })));
  const normalized = await skolemizeKnowledgeAssetParts(updated, [], { allowCanonicalSkolemTerms: true });
  await store.insert(generateGraphKnowledgeAssetMetadata({ contextGraphId: CONTEXT_GRAPH_ID, ual: seal.kaUal!,
    merkleRoot: computeFlatKCRootV10(normalized.publicQuads, []), publisherPeerId: agent.peerId, authorAddress: AUTHOR,
    accessPolicy: 'public', allowedPeers: [], timestamp: new Date(seal.finalizedAtIso),
    assertionVersion: BigInt(seal.assertionVersion!) + 1n, publicTripleCount: updated.length, privateTripleCount: 0, assertionGraph: vm },
  { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: {
    batchId: seal.reservedKaId!, materializedVersion: { blockNumber: 2, txIndex: 0 } } } }));
  return { vm, content: await graphContent(agent, vm) };
}

/** A bound share whose inventory row committed while the catalog projection could not admit it. */
async function shareWithPendingProjection(agent: DKGAgent) {
  const { finalized, seal } = await finalizeAuthorAsset(agent);
  // Projection admission is closed at commit, so the bound job keeps its catalog handoff.
  await agent.closeRfc64SwmCatalogProjectionSupervisorV1();
  daemonState.promoteWorkerAvailable = true;
  const answer = await durableSynchronousShare(agent, CONTEXT_GRAPH_ID, NAME, { agentAddress: AUTHOR });
  const [job] = await agent.promoteQueue.list({});
  expect(answer).toMatchObject({ sealed: true, publishReady: true, catalogHandoff: { state: 'pending', reason: 'projection-admission', recoveryJobId: job.jobId } });
  expect(job).toMatchObject({ state: 'failed_retrying', request: { recoveryBinding: { inventoryRequired: true } } });
  return { finalized, seal, job, binding: job.request.recoveryBinding! };
}

async function replay(agent: DKGAgent, jobId: string) {
  const claim = (await agent.promoteQueue.claimNext('replay'))!;
  expect(claim.jobId).toBe(jobId);
  return runPromoteJob({ job: claim, queue: agent.promoteQueue, workerId: 'replay', now: Date.now, heartbeatIntervalMs: 60_000,
    log: () => undefined, runPromote: (request, executionAuthority) => executePromoteRequest(agent, request, { executionAuthority }) });
}

describe('bound share replay after a confirmed update of a newer version', () => {
  it('removes the admitted version\'s inventory row through the real ownership transfer before the job succeeds', async () => {
    const agent = await startRepairAgentV1({ name: 'superseded-public', beforeStart: configureQueue,
      autoPublish: { peers: [], catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1 } });
    vi.spyOn(agent, 'getCustodialAgentPrivateKey').mockReturnValue(AUTHOR_WALLET.privateKey);
    agent.acceptOpenContextGraphPolicyV1({ networkId: NETWORK_ID, contextGraphId: CONTEXT_GRAPH_ID, ownerAddress: AUTHOR });
    await agent.whenRfc64CatalogResponsibilitiesIdleV1(); await agent.whenRfc64CatalogSupervisorsIdleV1();
    const remaining = await seedDurableWorkspaceAssetV1(agent, 'remaining', 98n);
    await agent.commitRfc64SwmAuthorInventoryV1({ contextGraphId: CONTEXT_GRAPH_ID, assertionCoordinate: remaining.assertionCoordinate,
      lifecycleAgentAddress: AUTHOR, shareOperationId: remaining.shareOperationId });
    const { finalized, seal, job, binding } = await shareWithPendingProjection(agent);
    const inventory = () => agent.readRfc64SwmAuthorInventorySnapshotV1({ inventoryScopeDigest: remaining.scopeDigest, authorAddress: AUTHOR });
    const before = inventory()!;
    expect(before.rows.map(row => [row.kaUal, row.assertionVersion]).sort())
      .toEqual([[remaining.seal.kaUal, '1'], [seal.kaUal, seal.assertionVersion]].sort());
    const { vm, content } = await publishThenConfirmUpdate(agent, finalized, seal);
    expect(await (agent.publisher as any).promoteOwnershipReader(OWNER)).toMatchObject({ jobId: job.jobId });
    agent.startRfc64SwmCatalogProjectionSupervisorV1(createOperationContext('share'));
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1');
    const outcome = await replay(agent, job.jobId);
    // The durable catalog effect of the admitted version's confirmed ownership comes first.
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]![0]).toMatchObject({ shareOperationId: binding.intent.operationId,
      expectedWorkspaceAccessPolicy: 'public', seal: { kaUal: seal.kaUal, assertionVersion: seal.assertionVersion } });
    await expect(transfer.mock.results[0]!.value).resolves.toBe('owned');
    const after = inventory()!;
    expect(after.rows.map(row => row.kaUal)).toEqual([remaining.seal.kaUal]);
    expect(after.head.objectDigest).not.toBe(before.head.objectDigest);
    // The projection it admitted reconciles the author's catalog to the remaining row.
    await vi.waitFor(() => expect(agent.readRfc64SwmCatalogProjectionSupervisorStatusV1()?.repairs).toContainEqual(expect.objectContaining({
      outcome: 'reconciled', inventoryHeadObjectDigest: after.head.objectDigest, inventoryRowCount: '1' })), { timeout: 10_000 });
    expect(agent.readRfc64AppliedCatalogHeadV1({ catalogScopeDigest: catalogScopeDigestV1(), authorAddress: AUTHOR }))
      .toMatchObject({ inventoryRowCount: '1' });
    // Then the bound job completes and releases the lifecycle fence; the newer VM version is untouched.
    expect(outcome.outcome).toBe('succeeded');
    expect(await agent.promoteQueue.getStatus(job.jobId)).toMatchObject({ state: 'succeeded', request: { recoveryBinding: binding } });
    expect(await (agent.publisher as any).promoteOwnershipReader(OWNER)).toBeFalsy();
    expect(await graphContent(agent, vm)).toEqual(content);
  }, 60_000);

  it('records the admitted version\'s finalized placement repair through the real ownership transfer before the job succeeds', async () => {
    const placement: PlacementAgentV1 = await startPlacementAgentV1({ name: 'superseded-private', beforeStart: configureQueue });
    const { agent } = placement;
    await agent.whenRfc64CatalogResponsibilitiesIdleV1(); await agent.whenRfc64CatalogSupervisorsIdleV1();
    const { finalized, seal, job, binding } = await shareWithPendingProjection(agent);
    const { vm, content } = await publishThenConfirmUpdate(agent, finalized, seal);
    expect(placement.markers()).toHaveLength(0);
    expect(await (agent.publisher as any).promoteOwnershipReader(OWNER)).toMatchObject({ jobId: job.jobId });
    agent.startRfc64SwmCatalogProjectionSupervisorV1(createOperationContext('share'));
    // Park the placement inside its repair, so the durable marker is observable after the job ends.
    const gate = placement.holdPlacements();
    const transfer = vi.spyOn(agent, 'transferRfc64ConfirmedVmV1');
    const outcome = await replay(agent, job.jobId);
    expect(transfer).toHaveBeenCalledOnce();
    expect(transfer.mock.calls[0]![0]).toMatchObject({ shareOperationId: binding.intent.operationId,
      seal: { kaUal: seal.kaUal, assertionVersion: seal.assertionVersion } });
    await expect(transfer.mock.results[0]!.value).resolves.toBe('owned');
    await gate.entered();
    // The durable private repair obligation for the admitted version is recorded first.
    expect(placement.markers()).toEqual([expect.objectContaining({ assertionCoordinate: NAME, kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion, sealDigest: binding.sealDigest })]);
    expect(placement.events()).toContain(`marker-stored:${NAME}`);
    // Then the bound job completes and releases the lifecycle fence.
    expect(outcome.outcome).toBe('succeeded');
    expect(await agent.promoteQueue.getStatus(job.jobId)).toMatchObject({ state: 'succeeded', request: { recoveryBinding: binding } });
    expect(await (agent.publisher as any).promoteOwnershipReader(OWNER)).toBeFalsy();
    // The recorded obligation completes: the admitted version is placed and its marker retired.
    gate.release();
    await untilV1(() => placement.markers().length === 0, 'admitted placement retired');
    expect(placement.events()).toContain(`marker-retired:${NAME}`);
    expect(placement.catalogRows()).toBe('1');
    expect(await graphContent(agent, vm)).toEqual(content);
  }, 60_000);
});
