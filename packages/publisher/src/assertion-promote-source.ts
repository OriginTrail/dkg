// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri, isTrustLevelQuad, MemoryLayer, type GraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type { GraphManager, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { SHARE_OPERATION_ID_PRED, PROMOTE_OPERATION_INTENT_PRED } from './metadata.js';
import { parsePromoteOperationIntent, serializePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';
import { tagPromoteStep } from './promote-step-tag.js';
import { isReservedSubject } from './reserved-subjects.js';
import { tryResolveKnowledgeAssetWorkspaceHead, type KnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { publisherWorkspaceOperationSemanticsKey, workspaceHeadIncludesShareOperationId } from './workspace-operation-equivalence.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';

export interface AssertionPromoteSourceHost {
  readonly store: TripleStore;
  readonly graphManager: GraphManager;
  readQuads(graph: string): Promise<Quad[]>;
  readPrivateQuads(): Promise<Quad[]>;
  hasCompletionMarker(): Promise<boolean>;
  maintainMarker(complete: boolean): Promise<void>;
  dropWorkingMemory(): Promise<void>;
  hasDurableTail(operationId: string): Promise<boolean>;
  validatePayload(publicQuads: readonly Quad[], privateQuads: readonly Quad[], label: string): Promise<unknown>;
}

export interface AssertionPromoteSourceContext {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly contentScope: GraphKnowledgeAssetScope;
  readonly promoteMetaGraph: string;
  readonly lifecycleSubject: string;
  readonly sealSubject: string;
  readonly graphUri: string;
  readonly swmGraphUri: string;
  readonly vmGraphUri: string;
}

export function parsePromoteLifecycleLiteral(raw: string | undefined, code: string, lifecycleSubject: string): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // Fall through to the typed corruption error below.
  }
  throw Object.assign(
    new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> contains malformed state`),
    { code },
  );
}

/** Coherent source and recovery inspection; caller holds the exact KA SWM lock. */
export async function readAssertionPromoteSource(host: AssertionPromoteSourceHost, context: AssertionPromoteSourceContext) {
  const { promoteMetaGraph, lifecycleSubject, sealSubject, graphUri, swmGraphUri, vmGraphUri } = context;
  const immutablePrivateQuads = await host.readPrivateQuads();
  const maintainMarker = host.maintainMarker;
  let assertionQuads = await tagPromoteStep(
    'assertionScopedQuads',
    () => host.readQuads(graphUri),
  );
  const parsePlainLiteral = (raw: string | undefined, code: string) =>
    parsePromoteLifecycleLiteral(raw, code, lifecycleSubject);
  // Read the layer first. On empty-WM recovery the exact SWM graph must be
  // validated and any stale completion marker cleared before operation
  // metadata is parsed: corrupt IDs/intents must never leave a publishable
  // marker exposed.
  const layerResult = await readLifecycleLayer(host, context);
  if (layerResult.type !== 'bindings') {
    throw Object.assign(
      new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
      { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
    );
  }
  if (layerResult.bindings.length > 1) {
    throw Object.assign(
      new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting memory layers`),
      { code: 'KA_LIFECYCLE_LAYER_CONFLICT' },
    );
  }
  const lifecycleLayer = parsePlainLiteral(
    layerResult.bindings[0]?.['layer'],
    'KA_LIFECYCLE_LAYER_CORRUPT',
  );
  const hasCompletionMarker = await host.hasCompletionMarker();
  let resumingCommittedSwm = false;
  let sourceIsSwm = false;
  let preserveLegacyCompletionMarker = false;
  if (assertionQuads.length > 0 && hasCompletionMarker) {
    // A live WM source means this is either a reopened draft or an
    // interrupted promote whose exact SWM write landed before WM cleanup.
    // In both cases the old marker is not proof that the current durable
    // tail is complete. Clear it before parsing fallible operation metadata
    // so malformed recovery state can never leave a publishable marker.
    await maintainMarker(false);
  }
  if (lifecycleLayer === MemoryLayer.VerifiableMemory) {
    // Confirmed VM owns this version even if an older interrupted promotion
    // left stale WM behind. Never re-promote that copy or regress VM lifecycle.
    // A sanctioned reopened draft has a new WM lifecycle/seal instead.
    // Validate the exact VM payload before accepting the stale retry as a no-op.
    const existingVmQuads = (await host.readQuads(vmGraphUri)).filter(
      (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
    );
    const existingPrivateQuads = immutablePrivateQuads.filter(
      (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
    );
    await host.validatePayload(
      existingVmQuads,
      existingPrivateQuads,
      'verifiable-memory',
    );
    // A legacy marker-before-cleanup promotion may leave this exact WM
    // family behind after publish. VM has just been seal-verified, so retire
    // only that stale copy under the lifecycle lock before reporting success.
    // Propagate cleanup errors: proven non-started drops retry, while typed
    // indeterminate drops remain terminal under the existing storage contract.
    await host.dropWorkingMemory();
    await maintainMarker(false);
    return { kind: 'complete' as const, result: { promotedCount: 0, promotedAllRoots: false } };
  }
  if (assertionQuads.length === 0) {
    const existingSwmQuads = (await host.readQuads(swmGraphUri)).filter(
      (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
    );
    if (
      hasCompletionMarker
      || lifecycleLayer === MemoryLayer.SharedWorkingMemory
      || existingSwmQuads.length > 0
    ) {
      // A completed promote deliberately removes WM. A crash can also land
      // the exact SWM graph before the lifecycle, operation snapshot, head,
      // or completion marker. Validate the complete sealed payload and then
      // run the idempotent commit tail again so a retry repairs every durable
      // record and returns gossip for replay instead of merely saying no-op.
      const existingPrivateQuads = immutablePrivateQuads.filter(
        (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
      );
      try {
        await host.validatePayload(
          existingSwmQuads,
          existingPrivateQuads,
          'shared-memory',
        );
      } catch (error) {
        await maintainMarker(false);
        throw error;
      }
      // A marker inherited from an older commit ordering is not proof that
      // the immutable operation snapshot and monotonic head are durable.
      // Clear it immediately after the exact SWM payload validates, before
      // parsing any fallible operation metadata. The sole exception is a
      // completed pre-intent promotion: those rows have a durable operation
      // ID, snapshot, head, and marker but no promoteOperationIntent. Keep
      // that already-published state readable as a non-mutating no-op once
      // its complete durable tail is verified below; it cannot be replayed
      // because its original wire timestamp is unavailable.
      if (hasCompletionMarker) {
        const intentPresence = await host.store.query(
          `ASK { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
            <${assertSafeIri(lifecycleSubject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?intent
          } }`,
        );
        if (intentPresence.type !== 'boolean') {
          await maintainMarker(false);
          throw Object.assign(
            new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
            { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
          );
        }
        preserveLegacyCompletionMarker = !intentPresence.value;
      }
      if (!preserveLegacyCompletionMarker) await maintainMarker(false);
      assertionQuads = existingSwmQuads;
      sourceIsSwm = true;
      resumingCommittedSwm = true;
    }
  }

  // Keep the operation cardinality checks separate and bounded. Combining
  // OPTIONALs creates a Cartesian product on corrupt rows — precisely the
  // sort of recovery path that should not double as an accidental OOM test.
  const [operationIdResult, promoteIntentResult] = await readOperationRows(host, context);
  if (preserveLegacyCompletionMarker) {
    if (
      operationIdResult.type === 'bindings'
      && operationIdResult.bindings.length === 1
      && promoteIntentResult.type === 'bindings'
      && promoteIntentResult.bindings.length === 0
    ) {
      let legacyOperationId: string | undefined;
      try {
        legacyOperationId = parsePlainLiteral(
          operationIdResult.bindings[0]?.['shareOperationId'],
          'KA_SHARE_OPERATION_ID_CORRUPT',
        );
      } catch (error) {
        await maintainMarker(false);
        throw error;
      }
      if (
        legacyOperationId
        && await host.hasDurableTail(legacyOperationId)
      ) {
        return { kind: 'complete' as const, result: {
          promotedCount: 0,
          promotedAllRoots: false,
          shareOperationId: legacyOperationId,
        } };
      }
    }
    // The shape was not a complete legacy commit. Remove the stale marker
    // before the normal conflict/corruption path reports the exact reason.
    await maintainMarker(false);
  }
  if (operationIdResult.type !== 'bindings' || promoteIntentResult.type !== 'bindings') {
    throw Object.assign(
      new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> could not be read safely`),
      { code: 'KA_LIFECYCLE_STATE_CORRUPT' },
    );
  }
  if (operationIdResult.bindings.length > 1) {
    throw Object.assign(
      new Error(
        `Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting durable share operation IDs`,
      ),
      { code: 'KA_SHARE_OPERATION_ID_CONFLICT' },
    );
  }
  if (promoteIntentResult.bindings.length > 1) {
    throw Object.assign(
      new Error(
        `Graph-scoped assertion lifecycle <${lifecycleSubject}> has conflicting durable promote intent`,
      ),
      { code: 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' },
    );
  }
  const durableShareOperationId = parsePlainLiteral(
    operationIdResult.bindings[0]?.['shareOperationId'],
    'KA_SHARE_OPERATION_ID_CORRUPT',
  );
  const durablePromoteIntentValue = parsePlainLiteral(
    promoteIntentResult.bindings[0]?.['promoteIntent'],
    'KA_PROMOTE_OPERATION_INTENT_CORRUPT',
  );
  if (!durableShareOperationId && durablePromoteIntentValue) {
    throw Object.assign(
      new Error(
        `Graph-scoped assertion lifecycle <${lifecycleSubject}> has promote intent without an operation ID`,
      ),
      { code: 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' },
    );
  }
  const durablePromoteIntent = durablePromoteIntentValue && durableShareOperationId
    ? parsePromoteOperationIntent(durablePromoteIntentValue, durableShareOperationId)
    : undefined;
  if (assertionQuads.length > 0 && durableShareOperationId) {
    // The exact SWM graph may have committed before a later snapshot/head
    // write failed, while WM is intentionally retained for retry. Recognize
    // that old-or-new atomic outcome only when it matches this sealed KA and
    // a durable operation claim exists; an older mismatching SWM version is
    // simply replaced by the normal path below.
    const existingSwmQuads = (await host.readQuads(swmGraphUri)).filter(
      (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
    );
    if (existingSwmQuads.length > 0) {
      try {
        await host.validatePayload(
          existingSwmQuads,
          immutablePrivateQuads.filter(
            (quad) => !isReservedSubject(quad.subject) && !isTrustLevelQuad(quad),
          ),
          'shared-memory',
        );
        resumingCommittedSwm = true;
      } catch {
        // A previous SWM version is not an interrupted commit of this seal.
      }
    }
  }
  if (assertionQuads.length === 0 && immutablePrivateQuads.length === 0) {
    await maintainMarker(false);
    throw Object.assign(
      new Error(
        `Finalized graph-scoped assertion <${sealSubject}> has no materialized public or private content`,
      ),
      { code: 'KA_GRAPH_CONTENT_MISSING' },
    );
  }
  return { kind: 'prepared' as const, assertionQuads, immutablePrivateQuads, sourceIsSwm, lifecycleLayer,
    resumingCommittedSwm, durableShareOperationId, durablePromoteIntent,
    head: await readHead(host, context) };
}

function readLifecycleLayer(host: AssertionPromoteSourceHost, context: AssertionPromoteSourceContext) {
  const { promoteMetaGraph, lifecycleSubject } = context;
  return host.store.query(
    `SELECT ?layer WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
      <${assertSafeIri(lifecycleSubject)}> <http://dkg.io/ontology/memoryLayer> ?layer
    } } LIMIT 2`,
  );
}

function readOperationRows(host: AssertionPromoteSourceHost, context: AssertionPromoteSourceContext) {
  const { promoteMetaGraph, lifecycleSubject } = context;
  return Promise.all([
    host.store.query(
      `SELECT ?shareOperationId WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
        <${assertSafeIri(lifecycleSubject)}> <${SHARE_OPERATION_ID_PRED}> ?shareOperationId
      } } LIMIT 2`,
    ),
    host.store.query(
      `SELECT ?promoteIntent WHERE { GRAPH <${assertSafeIri(promoteMetaGraph)}> {
        <${assertSafeIri(lifecycleSubject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?promoteIntent
      } } LIMIT 2`,
    ),
  ]);
}

async function readHead(host: AssertionPromoteSourceHost, context: AssertionPromoteSourceContext) {
  const resolution = await tryResolveKnowledgeAssetWorkspaceHead({
    store: host.store, graphManager: host.graphManager, contextGraphId: context.contextGraphId,
    kaUal: context.contentScope.ual, subGraphName: context.subGraphName,
  });
  if (resolution.status === 'corrupt') throw resolution.error;
  return resolution.status === 'resolved' ? resolution.head : undefined;
}

function headKey(head: KnowledgeAssetWorkspaceHead) {
  return `${head.assertionVersion}\0${publisherWorkspaceOperationSemanticsKey({
    ...head, privateMerkleRoot: head.privateMerkleRoot?.toLowerCase(), publisherIdentity: head.publisherPeerId,
  })}`;
}

/** Recheck storage assumptions after network confirmation, under the reacquired SWM lock. */
export async function revalidateAssertionPromoteSource(
  host: AssertionPromoteSourceHost,
  context: AssertionPromoteSourceContext,
  prepared: Extract<Awaited<ReturnType<typeof readAssertionPromoteSource>>, { kind: 'prepared' }>,
  intent: PromoteOperationIntent,
  publicQuads: readonly Quad[],
  privateMerkleRoot: string | undefined,
  privateTripleCount: number,
): Promise<void> {
  // The lifecycle lease is process-local. Another owner must not replace our
  // durable claim or advance VM while confirmation is outside the store lock.
  const [[ids, intents], layer] = await Promise.all([
    readOperationRows(host, context), readLifecycleLayer(host, context),
  ]);
  if (ids.type !== 'bindings' || intents.type !== 'bindings'
    || ids.bindings.length !== 1 || intents.bindings.length !== 1
    || parsePromoteLifecycleLiteral(ids.bindings[0]?.['shareOperationId'], 'KA_SHARE_OPERATION_ID_CORRUPT', context.lifecycleSubject) !== intent.operationId
    || parsePromoteLifecycleLiteral(intents.bindings[0]?.['promoteIntent'], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT', context.lifecycleSubject) !== serializePromoteOperationIntent(intent)) {
    throw Object.assign(new Error('Durable promote claim changed during confirmation'), { code: 'KA_PROMOTE_OPERATION_INTENT_CONFLICT' });
  }
  if (layer.type !== 'bindings' || layer.bindings.length > 1
    || parsePromoteLifecycleLiteral(layer.bindings[0]?.['layer'], 'KA_LIFECYCLE_LAYER_CORRUPT', context.lifecycleSubject) !== prepared.lifecycleLayer) {
    throw Object.assign(new Error('Assertion lifecycle layer changed during confirmation'), { code: 'KA_LIFECYCLE_STATE_CHANGED' });
  }
  const current = await readHead(host, context);
  if (current !== undefined) {
    const samePreparedHead = prepared.head !== undefined && headKey(current) === headKey(prepared.head)
      && current.operationAliases.some(alias => workspaceHeadIncludesShareOperationId(prepared.head!, alias.shareOperationId));
    const expectedKey = `${context.contentScope.assertionVersion}\0${publisherWorkspaceOperationSemanticsKey({
      publicQuadsDigest: workspacePublicQuadsDigest(publicQuads), publicTripleCount: publicQuads.length,
      privateMerkleRoot: privateMerkleRoot?.toLowerCase(), privateTripleCount, publisherIdentity: intent.publisherPeerId ?? '',
      access: { kind: 'persisted', accessPolicy: intent.accessPolicy, allowedPeers: intent.allowedPeers },
    })}`;
    const ownConfirmedHead = workspaceHeadIncludesShareOperationId(current, intent.operationId)
      && headKey(current) === expectedKey;
    if (BigInt(current.assertionVersion) > BigInt(context.contentScope.assertionVersion)
      || (!samePreparedHead && !ownConfirmedHead)) {
      throw Object.assign(new Error('KA SWM head changed while promotion awaited confirmation'), { code: 'KA_PROMOTE_SWM_HEAD_CHANGED' });
    }
  }
  // A prior publication may retire its head while a fresh WM draft waits. That
  // absence is safe, but an empty-WM recovery must still prove its SWM source
  // exists; restoring captured bytes after cleanup would resurrect a publication.
  const source = prepared.sourceIsSwm ? context.swmGraphUri : context.graphUri;
  const publicSource = (await host.readQuads(source)).filter(q => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
  const privateSource = (await host.readPrivateQuads()).filter(q => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
  await host.validatePayload(publicSource, privateSource, prepared.sourceIsSwm ? 'shared-memory' : 'working-memory');
}
