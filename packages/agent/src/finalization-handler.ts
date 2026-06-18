import {
  decodeFinalizationMessage,
  contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  sharedMemoryReadBothFilter,
  contextGraphDataUri, contextGraphMetaUri,
  contextGraphSubGraphUri, validateSubGraphName, validateContextGraphId,
  DKGEvent, Logger, createOperationContext,
  assertSafeIri, isSafeIri,
  type EventBus,
  type OperationContext,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  ENTITY_PRED_ALT,
} from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore, type Quad } from '@origintrail-official/dkg-storage';
import { type ChainAdapter, type EventFilter } from '@origintrail-official/dkg-chain';
import {
  computeFlatKCRootV10 as computeFlatKCRoot, skolemizeByEntity,
  generateConfirmedFullMetadata, getTentativeStatusQuad,
  generateSubGraphRegistration,
  shouldApplyMaterialization, writeMaterializedVersion, withMaterializationLock,
  type MaterializedVersion,
  type KCMetadata, type KAMetadata, type OnChainProvenance,
} from '@origintrail-official/dkg-publisher';
const DKG_NS = 'http://dkg.io/ontology/';
import { ethers } from 'ethers';

/**
 * Predicate for the durable per-root keep-root-copy signal the publisher
 * persists into SWM workspace meta at publish time (the chain-driven
 * reconcile path's equivalent of the gossip envelope's `keepRootCopyOnLabel`).
 * Shared with `DKGAgent` so the write and read sites can't drift.
 */
export const KEEP_ROOT_COPY_PREDICATE = `${DKG_NS}keepRootCopyOnLabel`;

/**
 * Resolves a local context-graph id (the topic/CG name used in gossip) to
 * its on-chain numeric id. Returns `null`/`undefined` for CGs that aren't
 * registered on-chain. Used as a fallback when a peer-finalization gossip
 * envelope omits `targetContextGraphId` (e.g. a pre-cd68fa689 publisher
 * still in the mesh).
 */
export type ResolveContextGraphOnChainId = (
  contextGraphId: string,
) => Promise<string | null | undefined>;

export type MarkContextGraphMetaDirtyFromQuads = (quads: readonly Quad[]) => void;

export class FinalizationHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly resolveContextGraphOnChainId: ResolveContextGraphOnChainId | undefined;
  private readonly markContextGraphMetaDirtyFromQuads: MarkContextGraphMetaDirtyFromQuads | undefined;
  private readonly log = new Logger('FinalizationHandler');
  private readonly processedUals = new Set<string>();

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    eventBus?: EventBus,
    resolveContextGraphOnChainId?: ResolveContextGraphOnChainId,
    markContextGraphMetaDirtyFromQuads?: MarkContextGraphMetaDirtyFromQuads,
  ) {
    this.store = store;
    this.chain = chain;
    this.eventBus = eventBus;
    this.resolveContextGraphOnChainId = resolveContextGraphOnChainId;
    this.markContextGraphMetaDirtyFromQuads = markContextGraphMetaDirtyFromQuads;
  }

  async handleFinalizationMessage(data: Uint8Array, contextGraphId: string): Promise<void> {
    let ctx = createOperationContext('gossip');
    try {
      const msg = decodeFinalizationMessage(data);
      if (msg.operationId) {
        ctx = createOperationContext('gossip', msg.operationId);
      }

      if (msg.contextGraphId && msg.contextGraphId !== contextGraphId) {
        // #1100: same guard as GossipPublishHandler — frames of other gossip
        // message types decode "successfully" with garbage in this field, so
        // only WARN when the mismatched value is a plausible CG id.
        if (!validateContextGraphId(msg.contextGraphId).valid) return;
        this.log.warn(ctx, `Finalization: contextGraphId "${msg.contextGraphId.slice(0, 120)}" does not match topic "${contextGraphId}", ignoring`);
        return;
      }

      // Deduplicate: skip if we already successfully processed this UAL
      const dedupeKey = `${msg.ual}:${msg.txHash}`;
      if (this.processedUals.has(dedupeKey)) {
        this.log.info(ctx, `Finalization: already processed ${msg.ual}, skipping duplicate`);
        return;
      }

      if (!msg.ual || !msg.txHash || msg.rootEntities.length === 0) {
        this.log.warn(ctx, `Finalization: incomplete message (ual=${msg.ual}, txHash=${msg.txHash}, roots=${msg.rootEntities.length}), ignoring`);
        return;
      }

      const blockNumber = protoToNumber(msg.blockNumber);
      const startKAId = protoToBigInt(msg.startKAId);
      const endKAId = protoToBigInt(msg.endKAId);

      // The publisher's `cd68fa689` fix threads the resolved on-chain CG id
      // into `targetContextGraphId` so receivers route SWM promotion into
      // the per-cgId `<cgName>/context/<cgId>/_meta` graph that the RS
      // prover reads from. Pre-fix publishers (or any publisher whose
      // `getContextGraphOnChainId` lookup returns null at gossip time) emit
      // `targetContextGraphId: undefined`, which used to silently downgrade
      // the receiver to legacy `<cgName>/_meta` promotion — leaving the
      // prover stuck on `kc-not-synced` until every publisher in the mesh
      // ships the fix. As a belt-and-braces for rolling upgrades we resolve
      // the id locally when the wire is empty; resolver failures or
      // not-on-chain CGs fall back to legacy behavior unchanged.
      let ctxGraphId = msg.targetContextGraphId || undefined;
      if (!ctxGraphId && this.resolveContextGraphOnChainId) {
        try {
          const resolved = await this.resolveContextGraphOnChainId(contextGraphId);
          if (resolved !== null && resolved !== undefined && String(resolved).length > 0) {
            ctxGraphId = String(resolved);
            this.log.info(ctx, `Finalization: gossip omitted targetContextGraphId; resolved locally to ${ctxGraphId} (defensive lookup)`);
          }
        } catch (err) {
          this.log.warn(ctx, `Finalization: defensive on-chain CG id lookup failed for ${contextGraphId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Validate sub-graph name from gossip — reject invalid names entirely
      let subGraphName: string | undefined;
      if (msg.subGraphName) {
        const sgVal = validateSubGraphName(msg.subGraphName);
        if (sgVal.valid) {
          subGraphName = msg.subGraphName;
        } else {
          this.log.warn(ctx, `Finalization: rejected message with invalid subGraphName "${msg.subGraphName}": ${sgVal.reason}`);
          return;
        }
      }

      // Dedup guard: skip if this batch was already promoted (e.g. by ChainEventPoller).
      // Read-both (review F5): also ASK the label `_meta` — the minimal
      // per-cgId partition shape carries no `dkg:status` row.
      const targetMetaGraph = ctxGraphId
        ? contextGraphMetaUri(contextGraphId, ctxGraphId)
        : `did:dkg:context-graph:${contextGraphId}/_meta`;
      const alreadyPromoted = await this.isAlreadyConfirmed(
        msg.ual, targetMetaGraph, `did:dkg:context-graph:${contextGraphId}/_meta`,
      );
      if (alreadyPromoted) {
        this.markProcessed(dedupeKey);
        this.log.info(ctx, `Finalization: ${msg.ual} already confirmed in ${ctxGraphId ? `context graph ${ctxGraphId}` : 'context graph'}, skipping`);
        return;
      }

      const sharedMemoryQuads = await this.getSharedMemoryQuadsForRoots(contextGraphId, msg.rootEntities, subGraphName);

      if (sharedMemoryQuads.length > 0) {
        const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msg.rootEntities, subGraphName);
        const merkleMatch = this.verifyMerkleMatch(sharedMemoryQuads, privateRoots, msg.kcMerkleRoot);

        if (merkleMatch) {
          const batchId = protoToBigInt(msg.batchId);
          // PR #845 review #9: derive `txIndex` from the verified receipt
          // (via `verifyOnChain`), NOT from gossip-supplied `msg.txIndex`.
          // The latter is trust-based; a peer can forge an inflated index
          // for a real publish `txHash` and lock out a legitimate
          // same-block update on the receiver. The verified value comes
          // from the on-chain log we matched (`log.transactionIndex`).
          const { verified, authorAddress, txIndex: verifiedTxIndex } = await this.verifyOnChain(
            msg.txHash, blockNumber, msg.kcMerkleRoot,
            msg.publisherAddress, startKAId, endKAId, ctx, ctxGraphId, batchId,
          );

          if (verified) {
            // Codex r5b — drop the rolling-upgrade legacy-publisher
            // fallback. Earlier rounds inferred same-graph intent from
            // `targetContextGraphId === local-on-chain-id-for(contextGraphId)`,
            // but Codex r5b correctly observed that signal is ambiguous:
            // it ALSO matches an explicit-remap-to-self publish (one where
            // the legacy publisher passed `subContextGraphId === ownCG's
            // own on-chain id` to deliberately drop the root copy). Both
            // shapes hit `targetContextGraphId === local id` on the wire,
            // so the fallback would re-add a root copy that the publisher
            // had intentionally removed — a data-isolation regression.
            //
            // The cure is worse than the disease: trading a hard
            // data-isolation bug for a soft query-discoverability gap is
            // unacceptable. Without an unambiguous version/intent signal
            // on the wire, a legacy publisher's same-graph publish stays
            // queryable on receivers via per-cgId partitions but not via
            // the bare `<cg>` label until the publisher upgrades to a
            // tristate-emitting build and re-emits. New publishers always
            // set the tristate (encoded with explicit KEEP/DROP) so the
            // gap is bounded by the upgrade window. PR #779 has not
            // shipped to any production peer yet, so this is the right
            // moment to harden the contract.
            const requestedKeepRootCopyOnLabel: boolean = msg.keepRootCopyOnLabel === true;
            // PR #845 review #9: tiebreaker comes from chain-truth.
            // verifyOnChain may not yield a txIndex if the matched event
            // shape didn't carry it (e.g. mocks). Fall back to 0 in that
            // case — matches pre-#845 ordering.
            const finalizationVersion: MaterializedVersion = {
              blockNumber,
              txIndex: typeof verifiedTxIndex === 'number' ? verifiedTxIndex : 0,
            };
            // PR #845 review #10: when same-graph dual-write is requested,
            // BOTH the per-cgId target meta and the root label meta
            // (`<cg>/_meta`) get rewritten. The pre-#845 code only guarded
            // the per-cgId target, so a stale finalization could pass that
            // check while an update had already stamped a newer version in
            // the root label meta — the dual-write then re-inserted the
            // old root-label data + meta on top of the update. Acquire the
            // label-meta lock too (when dual-writing), and downgrade to
            // per-cgId-only if the label projection is newer.
            const isDualWrite = requestedKeepRootCopyOnLabel
              && !!ctxGraphId
              && !subGraphName;
            const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
            // PR #845 review #7: TOCTOU — serialise check + promotion +
            // version stamp under the per-KA materialization lock so a
            // concurrent stale writer cannot interleave between our
            // `shouldApplyMaterialization` and `writeMaterializedVersion`.
            const outcome = await this.applyVerifiedFinalization({
              contextGraphId,
              sharedMemoryQuads,
              ual: msg.ual,
              rootEntities: msg.rootEntities,
              publisherAddress: msg.publisherAddress,
              txHash: msg.txHash,
              blockNumber,
              startKAId,
              endKAId,
              batchId: protoToBigInt(msg.batchId),
              ctxGraphId,
              subGraphName,
              authorAddress,
              finalizationVersion,
              targetMetaGraph,
              defaultMeta,
              isDualWrite,
              ctx,
            });
            if (outcome === 'stale-target') {
              this.markProcessed(dedupeKey);
              this.log.info(ctx, `Finalization: a newer update is already materialised for ${msg.ual}, skipping stale publish promotion`);
              return;
            }
            this.markProcessed(dedupeKey);
            this.log.info(ctx, `Finalization: promoted SWM snapshot to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'canonical'} for ${msg.ual} (tx=${msg.txHash.slice(0, 10)}…)`);
            return;
          }
          this.log.info(ctx, `Finalization: on-chain verification failed for ${msg.ual}, will retry via ChainEventPoller`);
          return;
        }
        this.log.info(ctx, `Finalization: merkle mismatch for ${msg.ual}, shared memory data differs from published`);
      } else {
        this.log.info(ctx, `Finalization: no shared memory data for ${msg.ual}, peer missed SWM sharing`);
      }

      // Fallback: no matching shared memory data. The data will arrive via
      // the regular publish topic broadcast or ChainEventPoller sync.
      this.log.info(ctx, `Finalization: ${msg.ual} requires full payload sync (no matching SWM snapshot)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Protobuf decode errors (wire type / index out of range) happen when receiving
      // a non-finalization message on this topic. Silently skip — not worth logging as WARN.
      if (/wire type|index out of range|offset|unexpected tag/i.test(msg)) return;
      this.log.warn(ctx, `Finalization: failed to process message: ${msg}`);
    }
  }

  private markProcessed(dedupeKey: string): void {
    this.processedUals.add(dedupeKey);
    if (this.processedUals.size > 10_000) {
      const first = this.processedUals.values().next().value;
      if (first) this.processedUals.delete(first);
    }
  }

  /**
   * Read-both (adversarial review F5, RFC ka-metadata-trim): the REQUIRED
   * `dkg:status "confirmed"` ASK used to target only the per-cgId partition
   * meta graph — but the minimal partition shape (`restateKaPartition`, the
   * publisher's own same-graph promote) no longer carries `dkg:status`; the
   * status row lives in the LABEL `_meta` graph. Without the fallback the
   * gossip/chain-reconcile dedup never fired on new-shape stores and the
   * publisher's own broadcast echo re-promoted. Old-shape stores (and the
   * replica full-move path, which still writes status into the partition)
   * keep their original semantics via the first GRAPH clause; `labelMetaGraph`
   * is only consulted as the UNION branch.
   */
  private async isAlreadyConfirmed(ual: string, metaGraph: string, labelMetaGraph?: string): Promise<boolean> {
    try {
      const safeUal = assertSafeIri(ual);
      const partitionPattern = `GRAPH <${assertSafeIri(metaGraph)}> { <${safeUal}> <http://dkg.io/ontology/status> "confirmed" }`;
      const ask = labelMetaGraph && labelMetaGraph !== metaGraph
        ? `ASK { { ${partitionPattern} } UNION { GRAPH <${assertSafeIri(labelMetaGraph)}> { <${safeUal}> <http://dkg.io/ontology/status> "confirmed" } } }`
        : `ASK { ${partitionPattern} }`;
      const result = await this.store.query(ask);
      return result.type === 'boolean' && result.value === true;
    } catch {
      return false;
    }
  }

  private async getSharedMemoryQuadsForRoots(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<Quad[]> {
    const graphManager = new GraphManager(this.store);
    const sharedMemoryGraph = subGraphName
      ? graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    // #1098/#1099: replicas store gossiped SWM shares in the PER-KA graphs
    // `…/_shared_memory/{author}/{number}` (workspace-handler.ts ~line 987),
    // not the bare bucket. Reading only the bucket made every replica report
    // "no shared memory data … peer missed SWM sharing" on finalization, so
    // the published KA was never materialized into VM on subscribed peers
    // (the VM-divergence half of #1098). Read-both: bucket + per-KA graphs.
    // CONSTRUCT (not SELECT) so literal terms keep full datatype/lang
    // fidelity for the merkle recompute, and so the same logical triple
    // present in BOTH the bucket and a per-KA graph collapses to one
    // (a constructed graph is a set).
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
      GRAPH ?g {
        VALUES ?root { ${values} }
        ?s ?p ?o .
        FILTER(
          ?s = ?root
          || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
        )
      }
      ${sharedMemoryReadBothFilter(sharedMemoryGraph)}
    }`;

    const result = await this.store.query(sparql, { source: 'agent.finalization.sharedMemorySlice' });
    return result.type === 'quads' ? result.quads : [];
  }

  private verifyMerkleMatch(sharedMemoryQuads: Quad[], privateRoots: Uint8Array[], expectedMerkleRoot: Uint8Array): boolean {
    const computedRoot = computeFlatKCRoot(sharedMemoryQuads, privateRoots);
    return ethers.hexlify(computedRoot) === ethers.hexlify(expectedMerkleRoot);
  }

  private async getPrivateRootsFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<Uint8Array[]> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return [];

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `SELECT ?entity ?root WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?entity { ${values} }
        ?entity <${DKG_NS}privateMerkleRoot> ?root .
      }
    }`;

    const roots: Uint8Array[] = [];
    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.privateRoots' });
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const hex = (row['root'] as string).replace(/^"(.*)".*$/, '$1').replace(/^0x/, '');
          if (hex.length === 64) {
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            roots.push(bytes);
          }
        }
      }
    } catch { /* metadata may not exist */ }
    return roots;
  }

  /**
   * Recover the publisher's `keepRootCopyOnLabel` decision for these roots from
   * SWM workspace meta. The publisher persists `<root> dkg:keepRootCopyOnLabel
   * "true"|"false"` at publish time — the durable equivalent of the gossip
   * envelope flag — and it replicates to subscribers alongside the per-root
   * `privateMerkleRoot`. Returns:
   *   - `true`      — a matched root explicitly kept the root-label copy,
   *   - `false`     — explicitly dropped (remap / explicit-subCG publish),
   *   - `undefined` — no signal persisted (legacy publish); the caller defaults
   *                   to per-cgId-only so a dropped root copy is never re-added.
   * An explicit `true` wins over `false` across the matched roots: a same-graph
   * publish demands the root copy exist.
   */
  private async getKeepRootCopySignal(
    contextGraphId: string,
    rootEntities: string[],
    subGraphName?: string,
  ): Promise<boolean | undefined> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return undefined;

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const sparql = `SELECT ?v WHERE {
      GRAPH <${assertSafeIri(wsMetaGraph)}> {
        VALUES ?root { ${values} }
        ?root <${KEEP_ROOT_COPY_PREDICATE}> ?v .
      }
    }`;
    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.keepRootCopySignal' });
      if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
      let sawFalse = false;
      for (const row of result.bindings) {
        const v = String(row['v']).replace(/^"(.*)".*$/, '$1');
        if (v === 'true') return true;
        if (v === 'false') sawFalse = true;
      }
      return sawFalse ? false : undefined;
    } catch {
      return undefined;
    }
  }

  private async getPublisherPeerIdFromMeta(contextGraphId: string, rootEntities: string[], subGraphName?: string): Promise<string | undefined> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const safeRoots = rootEntities.filter(isSafeIri);
    if (safeRoots.length === 0) return undefined;

    const values = safeRoots.map(r => `<${r}>`).join(' ');
    const PROV = 'http://www.w3.org/ns/prov#';
    // GH #748: prefer the dedicated `dkg:publisherPeerId` field (peer-ID
    // literal); fall back to literal-form `prov:wasAttributedTo` for legacy
    // un-migrated SWM rows. Skip URI form — that's an agent DID, not a
    // peer ID, and downstream dials a libp2p peer with this value.
    //
    // `FILTER(BOUND(?peerId))` guards the LIMIT 1: without it, an op with
    // `rootEntity` but neither peer-ID source produces an unbound `?peerId`
    // that LIMIT could pick. The caller's `wsPeerId || publisherAddress`
    // fallback would then store an EVM address where a libp2p peer ID is
    // expected. With BOUND, only ops carrying a real peer-ID match.
    const sparql = `SELECT ?peerId WHERE {
      GRAPH <${wsMetaGraph}> {
        VALUES ?root { ${values} }
        ?op <${DKG_NS}rootEntity> ?root .
        OPTIONAL { ?op <${DKG_NS}publisherPeerId> ?pidField }
        OPTIONAL { ?op <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
        BIND(COALESCE(?pidField, ?attrField) AS ?peerId)
        FILTER(BOUND(?peerId))
      }
    } LIMIT 1`;

    try {
      const result = await this.store.query(sparql, { source: 'agent.finalization.publisherPeerId' });
      if (result.type === 'bindings' && result.bindings.length > 0) {
        const raw = result.bindings[0]['peerId'] as string;
        const peerId = raw.replace(/^"(.*)".*$/, '$1');
        if (peerId && peerId !== 'unknown') return peerId;
      }
    } catch { /* shared memory metadata may not exist */ }
    return undefined;
  }

  /**
   * Shared SWM→VM promotion under the per-KA materialization lock(s).
   *
   * Extracted verbatim from the former `promoteUnderLocks`/`runUnderLocks`
   * inline closure in `handleFinalizationMessage` (PR #845's TOCTOU-safe
   * promotion) so BOTH the gossip path and the chain-driven reconciliation
   * path (`handleChainReconciledKC`) share one implementation. Behavior is
   * identical to the gossip path; the only change is that the captured locals
   * are now explicit params.
   *
   * Serialises check + promotion + version stamp under the per-KA lock so a
   * concurrent stale writer cannot interleave between `shouldApplyMaterialization`
   * and `writeMaterializedVersion`. When dual-writing (same-graph keep-root),
   * both the per-cgId target meta and the root-label meta are guarded; if the
   * root label has a newer projection (an applied update), the dual-write
   * portion is skipped so we don't clobber it.
   */
  private async applyVerifiedFinalization(input: {
    contextGraphId: string;
    sharedMemoryQuads: Quad[];
    ual: string;
    rootEntities: string[];
    publisherAddress: string;
    txHash: string;
    blockNumber: number;
    startKAId: bigint;
    endKAId: bigint;
    batchId: bigint;
    ctxGraphId?: string;
    subGraphName?: string;
    authorAddress?: string;
    finalizationVersion: MaterializedVersion;
    targetMetaGraph: string;
    defaultMeta: string;
    isDualWrite: boolean;
    ctx: OperationContext;
  }): Promise<'promoted' | 'stale-target'> {
    const {
      contextGraphId, sharedMemoryQuads, ual, rootEntities, publisherAddress,
      txHash, blockNumber, startKAId, endKAId, batchId, ctxGraphId, subGraphName,
      authorAddress, finalizationVersion, targetMetaGraph, defaultMeta, isDualWrite, ctx,
    } = input;

    const promoteUnderLocks = async (): Promise<'promoted' | 'stale-target'> => {
      if (!(await shouldApplyMaterialization(this.store, targetMetaGraph, ual, finalizationVersion))) {
        return 'stale-target';
      }
      let effectiveKeepRoot = isDualWrite;
      if (isDualWrite) {
        if (!(await shouldApplyMaterialization(this.store, defaultMeta, ual, finalizationVersion))) {
          // Per-cgId is stale-or-equal but ROOT label has a
          // newer projection (an applied update). Skip the
          // dual-write portion so we don't clobber it.
          effectiveKeepRoot = false;
          this.log.info(
            ctx,
            `Finalization: root-label projection is newer for ${ual}; downgrading to per-cgId-only promotion`,
          );
        }
      }
      await this.promoteSharedMemoryToCanonical(
        contextGraphId, sharedMemoryQuads, ual, rootEntities,
        publisherAddress, txHash, blockNumber, startKAId, endKAId,
        batchId, ctx, ctxGraphId, subGraphName,
        authorAddress,
        effectiveKeepRoot,
      );
      await writeMaterializedVersion(this.store, targetMetaGraph, ual, finalizationVersion);
      if (effectiveKeepRoot) {
        await writeMaterializedVersion(this.store, defaultMeta, ual, finalizationVersion);
      }
      return 'promoted';
    };
    // Nested per-graph locks. Acquired in sorted order to prevent
    // cross-deadlock with any other call site that might one day
    // also lock multiple metas.
    const lockOrder = isDualWrite
      ? [defaultMeta, targetMetaGraph].sort()
      : [targetMetaGraph];
    if (lockOrder.length === 1) {
      return withMaterializationLock(lockOrder[0], ual, promoteUnderLocks);
    }
    return withMaterializationLock(lockOrder[0], ual, () =>
      withMaterializationLock(lockOrder[1], ual, promoteUnderLocks),
    );
  }

  /**
   * Phase B — chain-driven VM reconciliation entry point.
   *
   * Promotes a chain-registered KC into VM WITHOUT a gossip FinalizationMessage.
   * The caller (the agent reconciler) has already established, from chain reads,
   * that this KC is registered to the CG and resolved its `merkleRoot` +
   * `publisherAddress` by kaId; it has also ensured the matching SWM snapshot is
   * present locally (fetching from the publisher/cores first if needed).
   *
   * Verification differs from the gossip path because the trigger here is
   * already chain truth, not an untrusted peer message:
   *   - `merkleRoot` + `publisherAddress` are DIRECT chain reads keyed by kaId
   *     (`getLatestMerkleRoot` / `getLatestMerkleRootPublisher`), so they need
   *     no re-scan of `KCCreated` events (that re-scan exists to defend the
   *     gossip wire, which we don't have).
   *   - the CG binding is confirmed by a direct `getKAContextGraphId(kaId)` read
   *     against the caller's `onChainCgId` — chain truth, no event scan, no
   *     `txHash`/block needed (the sweep path has neither).
   *   - integrity is the same flat-KC root recompute the gossip path verifies
   *     against: we find the local SWM operation whose recomputed root equals
   *     the chain `merkleRoot`.
   *
   * `getLatestMerkleRoot(kaId)` always returns the KA's LATEST state (after any
   * update), so the reconcile is "as of now" — we stamp the materialization
   * version with the current chain head block. A later real update (higher
   * block) supersedes correctly; a stale gossip for the original publish (lower
   * block) is correctly skipped. We do NOT re-broadcast on the finalization
   * topic — the chain has spoken.
   *
   * Returns:
   *   - `'promoted'`        — SWM snapshot verified + promoted to VM.
   *   - `'already-confirmed'` — VM already had it (idempotent; cursor may advance).
   *   - `'no-swm'`          — no local SWM snapshot matches the published
   *                            merkleRoot (caller leaves the cursor; sweep retries).
   *   - `'unverified'`      — chain couldn't confirm the CG binding (RPC lag /
   *                            reorg / no chain wired); caller leaves cursor.
   *   - `'stale-target'`    — a newer update is already materialised.
   */
  async handleChainReconciledKC(input: {
    /** Local CG id (topic/name), e.g. the value in `subscribedContextGraphs`. */
    contextGraphId: string;
    /** On-chain numeric CG id as a string. Required — drives the binding check + per-cgId meta routing. */
    onChainCgId: string;
    ual: string;
    merkleRoot: Uint8Array;
    publisherAddress: string;
    kaId: bigint;
    /** Chain head block at reconcile time — stamped as the materialization version. */
    versionBlock: number;
    /** Optional EIP-712 author recovered from chain (KnowledgeAssetCreated.author). */
    authorAddress?: string;
    /** Optional sub-graph the publish targeted (defaults to root workspace). */
    subGraphName?: string;
  }, ctx: OperationContext): Promise<
    'promoted' | 'already-confirmed' | 'no-swm' | 'unverified' | 'stale-target'
  > {
    const {
      contextGraphId, onChainCgId, ual, merkleRoot, publisherAddress,
      kaId, versionBlock, authorAddress, subGraphName,
    } = input;

    const ctxGraphId = onChainCgId.length > 0 ? onChainCgId : undefined;
    const targetMetaGraph = ctxGraphId
      ? contextGraphMetaUri(contextGraphId, ctxGraphId)
      : `did:dkg:context-graph:${contextGraphId}/_meta`;

    // Idempotency — VM may already hold this (gossip beat the chain path, or a
    // prior sweep promoted it). Treat as success so the cursor can advance.
    // Read-both (review F5): the minimal per-cgId partition shape carries no
    // `dkg:status` row — the status lives in the label `_meta` graph.
    if (await this.isAlreadyConfirmed(ual, targetMetaGraph, `did:dkg:context-graph:${contextGraphId}/_meta`)) {
      this.log.info(ctx, `Chain-reconcile: ${ual} already confirmed in VM, skipping`);
      return 'already-confirmed';
    }

    // Confirm the CG binding from chain truth (defends against a caller passing
    // a kaId that isn't actually registered to this CG, and against RPC lag /
    // reorg where the binding hasn't landed yet).
    if (!(await this.verifyChainCgBinding(kaId, onChainCgId, ctx))) {
      this.log.info(ctx, `Chain-reconcile: chain CG binding for ${ual} (ka=${kaId}) not confirmed against cg ${onChainCgId}; deferring to sweep retry`);
      return 'unverified';
    }

    // Recover the published roots from the local SWM snapshot. The gossip path
    // gets `rootEntities` from the wire; here there is no wire, and SWM meta
    // (created at share-time, before publish) carries no merkle root — so we
    // identify the matching WorkspaceOperation by RECOMPUTING each candidate's
    // KC root and comparing to the chain root. This is the same flat-KC root
    // the gossip path verifies against, so a match is an authoritative
    // merkle verification.
    const snapshot = await this.findSwmSnapshotForMerkleRoot(contextGraphId, merkleRoot, subGraphName);
    if (!snapshot) {
      this.log.info(ctx, `Chain-reconcile: no local SWM snapshot matches the published merkleRoot for ${ual}; deferring to sweep retry`);
      return 'no-swm';
    }
    const { rootEntities, sharedMemoryQuads } = snapshot;
    // The snapshot may have been found in a sub-graph the caller didn't know
    // about; promote into THAT namespace so the data lands in the right graph.
    const resolvedSubGraphName = snapshot.subGraphName ?? subGraphName;

    const finalizationVersion: MaterializedVersion = { blockNumber: versionBlock, txIndex: 0 };
    // Same-graph publishes dual-write the root `<cg>` label copy so label-scoped
    // reads (`agent.query(<cg label>)`) resolve. The gossip path learns this
    // from `keepRootCopyOnLabel` on the wire; the chain-driven path has no wire,
    // so the publisher persists the same decision into SWM workspace meta (which
    // replicates to subscribers alongside `privateMerkleRoot`). Recover it here
    // and mirror the gossip dual-write decision, so a subscriber that missed the
    // broadcast and recovers via the sweep still gets the root-label copy.
    // Absent (legacy publish, no persisted signal) → false: stay per-cgId only,
    // so a remap publish's deliberately-dropped root copy is never re-added.
    const keepRootCopyOnLabel = await this.getKeepRootCopySignal(
      contextGraphId, rootEntities, resolvedSubGraphName,
    );
    const isDualWrite = keepRootCopyOnLabel === true && !!ctxGraphId && !resolvedSubGraphName;
    const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;

    const outcome = await this.applyVerifiedFinalization({
      contextGraphId,
      sharedMemoryQuads,
      ual,
      rootEntities,
      publisherAddress,
      txHash: '',
      blockNumber: versionBlock,
      startKAId: kaId,
      endKAId: kaId,
      batchId: 0n,
      ctxGraphId,
      subGraphName: resolvedSubGraphName,
      authorAddress,
      finalizationVersion,
      targetMetaGraph,
      defaultMeta,
      isDualWrite,
      ctx,
    });

    if (outcome === 'stale-target') {
      this.log.info(ctx, `Chain-reconcile: a newer update is already materialised for ${ual}, skipping`);
      return 'stale-target';
    }
    this.log.info(ctx, `Chain-reconcile: promoted SWM snapshot to VM for ${ual} (ka=${kaId}, cg=${onChainCgId})`);
    return 'promoted';
  }

  /**
   * Confirm — from chain truth — that `kaId` is registered to `onChainCgId`,
   * via the direct `getKAContextGraphId(kaId)` storage read. Returns `false`
   * when no chain is wired, the read is unavailable, the binding doesn't match,
   * or the read throws (RPC lag) — all "can't confirm yet, retry later" cases.
   */
  private async verifyChainCgBinding(kaId: bigint, onChainCgId: string, ctx: OperationContext): Promise<boolean> {
    if (!this.chain || this.chain.chainId === 'none' || typeof this.chain.getKAContextGraphId !== 'function') {
      return false;
    }
    try {
      const boundCg = await this.chain.getKAContextGraphId(kaId);
      return boundCg.toString() === onChainCgId;
    } catch (err) {
      this.log.info(ctx, `Chain-reconcile: getKAContextGraphId(${kaId}) failed (RPC lag?): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Find the local SWM snapshot whose KC merkle root matches the chain
   * `merkleRoot`, returning its root entities + shared-memory quads.
   *
   * SWM workspace meta is written at share-time (before publish), so it carries
   * no merkle root to look up by — only `?op a dkg:WorkspaceOperation ;
   * dkg:rootEntity <root>`. We therefore enumerate the candidate operations,
   * gather each one's SWM quads + private roots, recompute the flat-KC root
   * (`computeFlatKCRoot`, the same function the gossip path verifies against),
   * and return the first operation whose computed root equals the chain root.
   * A match is an authoritative merkle verification.
   *
   * Returns `null` when no local operation matches — either the snapshot hasn't
   * been synced yet (the caller's active-fetch missed / is in flight) or this
   * KA belongs to a publish this node never shared. Either way the B.2 sweep
   * retries later.
   *
   * Cost note: O(#WorkspaceOperations) root recomputations per call. Fine for
   * typical CGs; if a CG grows large this can be optimised by stamping the KC
   * merkle root onto SWM meta at publish time (a publisher-side change, out of
   * scope here).
   */
  private async findSwmSnapshotForMerkleRoot(
    contextGraphId: string,
    merkleRoot: Uint8Array,
    subGraphName?: string,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[]; subGraphName?: string } | null> {
    // Caller knows the exact namespace → search only that one.
    if (subGraphName) {
      const hit = await this.findSwmSnapshotInNamespace(contextGraphId, merkleRoot, subGraphName);
      return hit ? { ...hit, subGraphName } : null;
    }

    // No namespace supplied (the chain-driven path never knows it). Try the
    // root workspace first, then fall back to every registered sub-graph —
    // otherwise a KA published into a named sub-graph would stay `no-swm`
    // forever because its SWM snapshot lives under a sub-graph meta graph,
    // not the root workspace meta. Return the namespace we matched in so the
    // caller promotes into the correct data graph.
    const rootHit = await this.findSwmSnapshotInNamespace(contextGraphId, merkleRoot, undefined);
    if (rootHit) return { ...rootHit, subGraphName: undefined };

    let subGraphNames: string[] = [];
    try {
      subGraphNames = await new GraphManager(this.store).listSubGraphs(contextGraphId);
    } catch { /* no sub-graphs / store can't enumerate */ }
    for (const sg of subGraphNames) {
      const hit = await this.findSwmSnapshotInNamespace(contextGraphId, merkleRoot, sg);
      if (hit) return { ...hit, subGraphName: sg };
    }
    return null;
  }

  /**
   * Search a single SWM namespace (root workspace when `subGraphName` is
   * undefined, otherwise the named sub-graph's shared-memory meta) for a
   * WorkspaceOperation whose recomputed flat-KC root matches `merkleRoot`.
   */
  private async findSwmSnapshotInNamespace(
    contextGraphId: string,
    merkleRoot: Uint8Array,
    subGraphName?: string,
  ): Promise<{ rootEntities: string[]; sharedMemoryQuads: Quad[] } | null> {
    const graphManager = new GraphManager(this.store);
    const wsMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);

    // Group root entities by their WorkspaceOperation so each candidate KC is
    // verified as a whole (the merkle root is over all of an op's roots).
    const rootsByOp = new Map<string, string[]>();
    try {
      const result = await this.store.query(`SELECT ?op ?root WHERE {
        GRAPH <${assertSafeIri(wsMetaGraph)}> {
          ?op <${DKG_NS}rootEntity> ?root .
        }
      }`);
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const op = typeof row['op'] === 'string' ? row['op'].replace(/^<(.*)>$/, '$1') : '';
          const root = typeof row['root'] === 'string' ? row['root'].replace(/^<(.*)>$/, '$1') : '';
          if (!op || !isSafeIri(root)) continue;
          const list = rootsByOp.get(op) ?? [];
          list.push(root);
          rootsByOp.set(op, list);
        }
      }
    } catch { /* SWM meta may not exist yet */ }

    if (rootsByOp.size === 0) return null;

    const opsSorted = [...rootsByOp.entries()].sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    for (const [, roots] of opsSorted) {
      const sharedMemoryQuads = await this.getSharedMemoryQuadsForRoots(contextGraphId, roots, subGraphName);
      if (sharedMemoryQuads.length === 0) continue;
      const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, roots, subGraphName);
      if (this.verifyMerkleMatch(sharedMemoryQuads, privateRoots, merkleRoot)) {
        return { rootEntities: roots, sharedMemoryQuads };
      }
    }
    return null;
  }

  private async verifyOnChain(
    txHash: string,
    blockNumber: number,
    expectedMerkleRoot: Uint8Array,
    expectedPublisher: string,
    expectedStartKAId: bigint,
    expectedEndKAId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
    expectedBatchId?: bigint,
  ): Promise<{ verified: boolean; authorAddress?: string; txIndex?: number }> {
    if (!this.chain || this.chain.chainId === 'none') return { verified: false };
    if (blockNumber <= 0) return { verified: false };

    try {
      // Verify KnowledgeBatchCreated or KCCreated (V10) at the specific block
      const batchFilter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };

      let batchVerified = false;
      // Round 5 review §10 — capture the indexed `author` from the matched
      // KCCreated event so the caller can populate `dkg:Publication` /
      // `dkg:authoredBy` provenance on the replica side, mirroring the
      // originator. `address(0)` here is the unattributed-publish sentinel
      // (RFC-001 §3.6) and is correctly preserved.
      let authorAddress: string | undefined;
      // PR #845 review #9: capture the chain-truth `transactionIndex` from
      // the matched event so the materialization-version guard does not
      // have to trust the gossip-supplied `msg.txIndex` (which a peer can
      // inflate to lock out a legitimate same-block update).
      let verifiedTxIndex: number | undefined;
      for await (const event of this.chain.listenForEvents(batchFilter)) {
        if (event.blockNumber !== blockNumber) continue;
        if (txHash && (!event.data['txHash'] || (event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase())) {
          continue;
        }

        const eventMerkle = typeof event.data['merkleRoot'] === 'string'
          ? ethers.getBytes(event.data['merkleRoot'] as string)
          : event.data['merkleRoot'] as Uint8Array;
        const eventPublisher = (event.data['publisherAddress'] as string) ?? '';
        const eventStartKAId = BigInt(event.data['startKAId'] as string ?? '0');
        const eventEndKAId = BigInt(event.data['endKAId'] as string ?? '0');

        const merkleMatch = ethers.hexlify(eventMerkle) === ethers.hexlify(expectedMerkleRoot);
        const publisherMatch = eventPublisher.toLowerCase() === expectedPublisher.toLowerCase();
        const rangeMatch = eventStartKAId === expectedStartKAId && eventEndKAId === expectedEndKAId;

        if (merkleMatch && publisherMatch && rangeMatch) {
          batchVerified = true;
          const eventAuthor = (event.data['author'] as string) ?? '';
          if (eventAuthor) authorAddress = eventAuthor;
          const rawTxIdx = event.data['txIndex'];
          if (typeof rawTxIdx === 'number' && Number.isFinite(rawTxIdx) && rawTxIdx >= 0) {
            verifiedTxIndex = rawTxIdx;
          }
          break;
        }
      }

      if (!batchVerified) return { verified: false };

      // V10 publish registers the KC to the context graph internally
      // (no separate addBatchToContextGraph tx / ContextGraphExpanded event).
      // Skip the legacy ContextGraphExpanded check — the batch verification
      // above is sufficient for V10.
      if (ctxGraphId) {
        if (typeof this.chain.isV10Ready === 'function' && this.chain.isV10Ready()) {
          return { verified: true, authorAddress, txIndex: verifiedTxIndex };
        }
        try {
          const scanWindow = 256;
          const headBlock = typeof this.chain.getBlockNumber === 'function'
            ? await this.chain.getBlockNumber()
            : blockNumber + scanWindow;
          const cgFilter: EventFilter = {
            eventTypes: ['ContextGraphExpanded'],
            fromBlock: blockNumber,
            toBlock: Math.min(blockNumber + scanWindow, headBlock),
          };
          for await (const event of this.chain.listenForEvents(cgFilter)) {
            const eventCGId = String(event.data['contextGraphId'] ?? '');
            const eventBatchId = BigInt(event.data['batchId'] as string ?? '0');
            if (eventCGId === ctxGraphId && (expectedBatchId === undefined || eventBatchId === expectedBatchId)) {
              return { verified: true, authorAddress, txIndex: verifiedTxIndex };
            }
          }
          return { verified: false };
        } catch {
          return { verified: true, authorAddress, txIndex: verifiedTxIndex };
        }
      }

      return { verified: true, authorAddress, txIndex: verifiedTxIndex };
    } catch (err) {
      this.log.info(ctx, `Finalization on-chain verification pending (RPC may be lagging): ${err instanceof Error ? err.message : String(err)}`);
    }
    return { verified: false };
  }

  private async promoteSharedMemoryToCanonical(
    contextGraphId: string,
    sharedMemoryQuads: Quad[],
    ual: string,
    msgRootEntities: string[],
    publisherAddress: string,
    txHash: string,
    blockNumber: number,
    startKAId: bigint,
    endKAId: bigint,
    batchId: bigint,
    ctx: OperationContext,
    ctxGraphId?: string,
    subGraphName?: string,
    /**
     * EIP-712-attested author recovered from `KnowledgeAssetCreated.author`.
     * Round 5 review §10 — when set, the replica emits matching
     * `dkg:Publication` / `dkg:authoredBy` triples so agent-provenance via the
     * `_meta` triplestore is consistent across the originator and every replica.
     * `address(0)` and missing/empty values are skipped (preserves the
     * unattributed-publish path's no-author behaviour from RFC-001 §3.6).
     */
    authorAddress?: string,
    /**
     * PR #779 same-graph signal: when `true` the publisher kept a root-graph
     * copy of the canonical quads, so receivers mirror the dual-write so
     * label-scoped queries resolve. When `false` (or omitted on older
     * publishers) the publisher used the explicit-`subContextGraphId` /
     * remap path and deleted its own root copy on purpose — receivers
     * MUST NOT dual-write or they re-expose the KC under the source CG
     * label and double-count it in unscoped queries.
     */
    keepRootCopyOnLabel?: boolean,
  ): Promise<void> {
    const graphManager = new GraphManager(this.store);
    await graphManager.ensureContextGraph(contextGraphId);
    if (subGraphName) {
      await graphManager.ensureSubGraph(contextGraphId, subGraphName);
      const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
      const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
      const alreadyRegistered = await this.store.query(
        `ASK { GRAPH <${metaGraph}> {
          <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
            <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
            <http://dkg.io/ontology/createdBy> ?createdBy .
        } }`,
      );
      if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
        const regQuads = generateSubGraphRegistration({
          contextGraphId,
          subGraphName,
          createdBy: publisherAddress || 'finalization-discovery',
          timestamp: new Date(),
        });
        await this.store.insert(regQuads);
        this.markContextGraphMetaDirtyFromQuads?.(regQuads);
        this.log.info(ctx, `Finalization: auto-registered sub-graph "${subGraphName}" in context graph "${contextGraphId}"`);
      }
    }
    const dataGraph = subGraphName
      ? contextGraphSubGraphUri(contextGraphId, subGraphName)
      : ctxGraphId
        ? contextGraphDataUri(contextGraphId, ctxGraphId)
        : graphManager.dataGraphUri(contextGraphId);
    // Devnet test #774-followup (v10-rc-validation §5 gossip replication):
    // when `ctxGraphId` is set on a non-sub-graph publish, the canonical
    // data lands in the per-on-chain-id partition
    // `<cg>/context/<ctxGraphId>` only. The publisher path
    // (`dkg-publisher.ts` ~line 1382) intentionally ALSO writes the same
    // quads to the root `<cg>` graph "so `agent.query(label)` (which
    // resolves to `did:dkg:context-graph:<label>` without a
    // `/context/<id>` suffix) still finds the just-published triples"
    // (commit c2abbc9a). Replicas were never updated to mirror that
    // dual-write — so a CG-scoped query against a label on a recipient
    // node finds 0 bindings even though the data is local in
    // `<cg>/context/<ctxGraphId>`. The query engine cannot widen its
    // allow set to `<cg>/context/<num>` without a CG-registry lookup
    // (id-prefix collisions, see PR #776 r6 in dkg-query-engine.ts).
    // Mirroring the publisher's same-graph dual-write fixes the
    // visibility asymmetry without re-introducing that ambiguity.
    //
    // Critical scoping (Codex review on PR #779): the recipient dual-write
    // MUST only fire for same-graph publishes (the publisher kept the
    // root copy too). Explicit-`subContextGraphId` / remap publishes
    // delete the root copy on purpose (`dkg-publisher.ts` ~line 1393),
    // and a recipient that re-adds it would re-expose the KC under the
    // source CG's label on every replica — leaking remap intent and
    // double-counting the same triples in unscoped queries. The
    // publisher signals same-graph vs remap on the wire via
    // `keepRootCopyOnLabel`; missing/false (older publishers, or any
    // remap publish) → no dual-write.
    const rootDataGraphForLabel = (!subGraphName && ctxGraphId && keepRootCopyOnLabel === true)
      ? graphManager.dataGraphUri(contextGraphId)
      : null;

    // Compute canonical quads now, but defer the `store.insert` until AFTER
    // the confirmed-meta write and SWM cleanup (see bottom of this method).
    //
    // Rationale: on a replica the three store mutations (canonical insert,
    // confirmed-meta insert, SWM cleanup) happen as three sequential awaits.
    // Readers polling the canonical graph (e.g. downstream consumers waiting
    // for "KC landed") can observe the canonical insert before the meta flip
    // to `confirmed` or before SWM has been drained, producing a visible
    // "data-without-confirmed-meta" intermediate state that is wrong from a
    // causal-consistency standpoint (the whole point of the finalization
    // gossip is that by the time data is canonical on a replica, the chain
    // proof is durable too). On fast dev machines the window is sub-
    // millisecond and invisible; on slower CI runners it widens to ~70 ms
    // and a poll that happens to land there sees `tentative` instead of
    // `confirmed` (flipped the `Tornado EVM integration: agent`
    // e2e-finalization suite red on every PR-224 run since the
    // sync-refactor merge at `bc65c3ae`).
    //
    // Ordering meta+cleanup BEFORE canonical insert makes the public state
    // transition single-stepped from an observer's point of view: either
    // you don't see the data yet, or you see data + confirmed meta + empty
    // SWM. The only user-visible partial state that remains (confirmed
    // meta + no data) is naturally recovered by `isAlreadyConfirmed` on the
    // next retry path, and it's strictly less broken than the converse.
    const canonicalQuads = sharedMemoryQuads.map(q => ({ ...q, graph: dataGraph }));

    const privateRoots = await this.getPrivateRootsFromMeta(contextGraphId, msgRootEntities, subGraphName);
    const merkleRoot = computeFlatKCRoot(canonicalQuads, privateRoots);

    const partitioned = skolemizeByEntity(canonicalQuads);
    const localRootSet = new Set(partitioned.keys());

    const rootEntities = msgRootEntities.length > 0
      ? msgRootEntities
      : [...partitioned.keys()];

    if (msgRootEntities.length > 0) {
      const msgSet = new Set(msgRootEntities);
      const extraInMsg = msgRootEntities.filter(r => !localRootSet.has(r));
      const missingInMsg = [...localRootSet].filter(r => !msgSet.has(r));
      if (extraInMsg.length > 0 || missingInMsg.length > 0) {
        this.log.warn(ctx, `Finalization: root entity set mismatch — extra in msg: [${extraInMsg.join(', ')}], missing: [${missingInMsg.join(', ')}]`);
      }
    }
    const kaMetadata: KAMetadata[] = [];

    for (let tokenIdx = 0; tokenIdx < rootEntities.length; tokenIdx++) {
      const rootEntity = rootEntities[tokenIdx];
      const entityQuads = partitioned.get(rootEntity) ?? [];
      if (entityQuads.length === 0) continue;
      kaMetadata.push({
        rootEntity,
        kcUal: ual,
        tokenId: BigInt(tokenIdx + 1),
        publicTripleCount: entityQuads.length,
        privateTripleCount: 0,
        privateMerkleRoot: undefined,
      });
    }

    const wsPeerId = await this.getPublisherPeerIdFromMeta(contextGraphId, msgRootEntities, subGraphName);
    // Round 5 review §10 — propagate the on-chain-attested author into the
    // confirmed `_meta` block so replicas emit a `prov:wasAttributedTo`
    // matching the originator's. We treat `address(0)` (the
    // unattributed-publish sentinel) as "no author" by skipping the field,
    // so the legacy no-author behaviour is preserved verbatim. (The former
    // `dkg:Publication` / `dkg:authoredBy` mirror was dropped — RFC
    // ka-metadata-trim Phase 1, zero readers.)
    const isUnattributed = !authorAddress
      || authorAddress === '0x0000000000000000000000000000000000000000'
      || authorAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
    const kcMeta: KCMetadata = {
      ual,
      contextGraphId,
      merkleRoot,
      publisherPeerId: wsPeerId || publisherAddress,
      timestamp: new Date(),
      subGraphName,
      ...(isUnattributed
        ? {}
        : { authorAddress }),
    };

    let blockTimestamp = Math.floor(Date.now() / 1000);
    if (this.chain && typeof (this.chain as any).getBlockTimestamp === 'function') {
      try {
        blockTimestamp = await (this.chain as any).getBlockTimestamp(blockNumber);
      } catch {
        this.log.info(ctx, `Could not fetch block timestamp for block ${blockNumber}, using local time`);
      }
    }

    const provenance: OnChainProvenance = {
      txHash,
      blockNumber,
      blockTimestamp,
      publisherAddress,
      batchId,
      chainId: this.chain?.chainId ?? 'unknown',
    };

    // Remove any existing tentative status for this UAL before inserting
    // confirmed metadata. Two graph locations can carry it on this replica:
    //   1. Root `<cg>/_meta` — gossip-publish-handler ALWAYS writes
    //      `generateTentativeMetadata(...)` here (via `getTentativeStatusQuad`,
    //      which hardcodes the root `_meta` graph). This applies to every
    //      gossip-replicated KC regardless of `ctxGraphId` / dual-write mode.
    //   2. Per-cgId `<cg>/context/<id>/_meta` — older code paths (and any
    //      future writer that respects the same partition split as canonical
    //      data) may park a tentative quad here when `ctxGraphId` is set.
    //
    // Codex r5 on PR #779: the previous form mutated `tentativeQuad.graph`
    // to the per-cgId URI when `ctxGraphId` was set and deleted ONLY that
    // copy. The root tentative survived. With the same-graph dual-write
    // path (`keepRootCopyOnLabel === true`) we then re-inserted confirmed
    // `_meta` into root `<cg>/_meta`, leaving `tentative` AND `confirmed`
    // status quads coexisting on the same UAL in the root meta graph —
    // label-scoped status reads were non-deterministic. Even on the
    // `keepRootCopyOnLabel === false` path the leftover root tentative was
    // wrong (the publisher had moved/dropped its root copy on remap).
    //
    // Fix: always queue the root tentative for deletion AND, when ctxGraphId
    // is set, also queue the per-cgId variant. Single `store.delete` call so
    // all stale tentative copies are reaped in one shot — `delete` no-ops on
    // missing quads, so it's safe to enumerate both regardless of which
    // writer actually populated them.
    const rootTentativeQuad = getTentativeStatusQuad(ual, contextGraphId);
    const tentativesToDelete = [rootTentativeQuad];
    if (ctxGraphId) {
      tentativesToDelete.push({
        ...rootTentativeQuad,
        graph: contextGraphMetaUri(contextGraphId, ctxGraphId),
      });
    }
    try {
      await this.store.delete(tentativesToDelete);
    } catch { /* tentative status may not exist */ }

    let metaQuads = generateConfirmedFullMetadata(kcMeta, kaMetadata, provenance);
    if (ctxGraphId) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const targetMeta = contextGraphMetaUri(contextGraphId, ctxGraphId);
      // Codex r3 on PR #779: the publisher's same-graph path keeps the
      // confirmed `_meta` triples in BOTH the root `<cg>/_meta` and
      // the per-cgId `<cg>/context/<cgId>/_meta` graphs (see the
      // matching dual-write in `dkg-publisher.ts` ~line 1419, comment
      // "on remap publishes the original copy at `<NAME>/_meta` is
      // also moved; on same-graph publishes we leave the default copy
      // in place"). Replicas were only writing the per-cgId copy, so
      // label-only `_meta` reads (status / UAL / authoredBy lookups
      // that don't know the on-chain id) diverged between publisher
      // and recipients. Mirror the publisher's same-graph dual-write
      // here too — gated on the same `keepRootCopyOnLabel` signal as
      // the data-graph dual-write below, and folded into a single
      // `store.insert` for the same retry-safety reason (`_meta`
      // tentative→confirmed flip is supposed to be the durable point
      // post-this-call; splitting the writes would re-introduce a
      // partial-state window).
      if (keepRootCopyOnLabel === true) {
        const rootCopies = metaQuads
          .filter((q) => q.graph === defaultMeta)
          .map((q) => ({ ...q }));
        const perCgIdCopies = metaQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
        );
        metaQuads = [...perCgIdCopies, ...rootCopies];
      } else {
        metaQuads = metaQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: targetMeta } : q,
        );
      }
    }
    await this.store.insert(metaQuads);

    // Clean up promoted shared memory entries
    const sharedMemoryGraph = subGraphName
      ? graphManager.sharedMemoryUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceGraphUri(contextGraphId);
    const swmMetaGraph = subGraphName
      ? graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName)
      : contextGraphWorkspaceMetaGraphUri(contextGraphId);
    // #1099: replicas hold the gossiped SWM copy in PER-KA graphs
    // `…/_shared_memory/{author}/{number}` (workspace-handler.ts ~line 987),
    // but this cleanup only drained the bare bucket. The stale per-KA copy
    // survived every publish, kept being served to late subscribers via the
    // PROTOCOL_SYNC SWM responder (which reads the whole `…/_shared_memory/`
    // prefix), and re-poisoned even the publisher's own SWM on resync —
    // publisher and replicas permanently disagreed about SWM content.
    // Mirror DKGPublisher's `swmGraphsUnder`: drain the bucket AND every
    // graph under its `/` prefix.
    const allGraphs = await this.store.listGraphs();
    const swmGraphsForClear = allGraphs.filter(
      (g) => g === sharedMemoryGraph || g.startsWith(`${sharedMemoryGraph}/`),
    );
    for (const rootEntity of rootEntities) {
      for (const g of swmGraphsForClear) {
        await this.store.deleteByPattern({ graph: g, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(g, rootEntity + '/.well-known/genid/');
        await this.store.deleteByPattern({
          graph: g, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
      }
      await this.store.deleteByPattern({
        graph: swmMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
      });
      await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
    }

    // Canonical insert LAST — see the comment above `const canonicalQuads`.
    // By the time any reader observes these quads in the canonical graph,
    // `_meta` already carries `confirmed` status + chain provenance and the
    // matching SWM entries have been drained.
    //
    // Codex r2 on PR #779: when same-graph dual-write is in play, both
    // copies (per-cgId partition + root label graph) MUST land in a single
    // `store.insert` so a crash or store-write failure between them
    // cannot leave the replica with the per-cgId copy but no root copy.
    // The previous split form would be skipped on retry by
    // `isAlreadyConfirmed()` (`_meta` already confirmed) and the root
    // copy would never be back-filled — a permanent label-scoped query
    // miss on that replica. Folding both into one insert call ties their
    // durability to the same store-write transaction (Oxigraph's `load`
    // and SPARQL-backend bulk insert are both atomic at the call level).
    const allCanonicalQuads = rootDataGraphForLabel
      ? [
          ...canonicalQuads,
          ...canonicalQuads.map(q => ({ ...q, graph: rootDataGraphForLabel })),
        ]
      : canonicalQuads;
    await this.store.insert(allCanonicalQuads);

    this.log.info(ctx, `Promoted ${canonicalQuads.length} quads from shared memory to canonical for ${ual}`);
    this.eventBus?.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
      contextGraphId,
      layers: ['swm', 'vm'],
      subGraphName,
      operation: 'verifiable_memory_finalized',
      source: 'finalization',
      counts: {
        roots: rootEntities.length,
        triples: canonicalQuads.length,
      },
    });
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const result = await this.store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ?op ${ENTITY_PRED_ALT} <${assertSafeIri(rootEntity)}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;
      // OT-RFC-43 §10.1 — dual-write migration: remove BOTH the legacy
      // dkg:rootEntity and the new dkg:entity for this op/entity pair.
      await this.store.delete([
        { subject: op, predicate: DKG_ROOT_ENTITY_LEGACY, object: rootEntity, graph: metaGraph },
        { subject: op, predicate: DKG_ENTITY, object: rootEntity, graph: metaGraph },
      ]);
      const remaining = await this.store.query(
        `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(op)}> ${ENTITY_PRED_ALT} ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = typeof rawCount === 'string'
        ? Number(rawCount.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, ''))
        : NaN;
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }
}

function protoToNumber(val: number | bigint | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
}

function protoToBigInt(val: string | number | bigint | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  return (BigInt(val.high >>> 0) << 32n) | BigInt(val.low >>> 0);
}
