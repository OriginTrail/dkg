/**
 * The store adapter behind public SWM catch-up snapshot materialization.
 *
 * This module OWNS the persistence policy for turning a verified graph-scoped
 * snapshot into durable store state: what "already materialized" means, how
 * the stored head version is read, how stale head metadata is replaced, and
 * which lock serializes it all against live gossip. `runSharedMemorySync`
 * consumes it as one cohesive dependency (see `SharedMemorySnapshotMaterializer`);
 * `dkg-agent-lifecycle` is reduced to wiring agent-owned resources into
 * `createSharedMemorySnapshotMaterializer`.
 *
 * Every SPARQL read/write here is scoped to an exact per-KA IRI (the head
 * subject, the operation subject, or the KA's own assertion graph), so each
 * query is bounded by one KA's size — never by context-graph or fleet growth.
 */
import { assertSafeIri, isSafeIri } from '@origintrail-official/dkg-core';
import {
  swmKaWriteLockKey,
  withKeyedLocks,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  invalidateSwmMaterializationWitness,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { operationIdentityKey } from '../graph-scoped-swm-recovery.js';
import { isDecodableWorkspaceOperationRows } from '@origintrail-official/dkg-publisher';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * GH#2273 preservation validators — each names ONE invariant of the
 * preserved-winner contract. `selectRepairIdentity` orchestrates them; the
 * behavior of each is pinned by its own polarity row in
 * swm-head-identity-preservation.test.ts.
 */

/** Same share under a different id: allow-list identity keys are equal. */
function operationIdentityMatches(storedRows: readonly Quad[], descriptorKey: string): boolean {
  const storedKey = operationIdentityKey(storedRows);
  return storedKey !== null && storedKey === descriptorKey;
}

/** The head resolver's decoder accepts the rows (incl. the RFC64 stamp rule). */
function storedWinnerIsDecodable(
  storedRows: readonly Quad[],
  descriptor: GraphScopedSwmRecoveryDescriptor,
  foreignId: string,
): boolean {
  return isDecodableWorkspaceOperationRows(storedRows, {
    kaUal: descriptor.kaUal,
    assertionVersion: descriptor.assertionVersion,
    shareOperationId: foreignId,
    requirePublishedAt: true,
  });
}

/**
 * The VM-publish preflight requires the LIVE head's accessPolicy to be
 * DEFINED (`liveHead.accessPolicy === undefined` fails the queued intent as
 * stale). The identity KEY deliberately treats an absent row as the effective
 * default for equality, but preserving a policy-less winner would park the KA
 * on an operation queued publishes cannot use — descriptor-wins instead
 * converges to the peer's explicit-policy operation. Key equality and
 * envelope USABILITY are separate concerns.
 */
function storedWinnerHasUsableAccessEnvelope(storedRows: readonly Quad[]): boolean {
  return storedRows.some((row) => row.predicate === `${DKG}accessPolicy`);
}

/** The sync responder's serving join requires the WorkspaceOperation type row. */
function storedWinnerHasResponderType(storedRows: readonly Quad[]): boolean {
  return storedRows.some((row) =>
    row.predicate === RDF_TYPE_IRI && row.object === `${DKG}WorkspaceOperation`);
}


/** What the local store currently records on one KA's SWM head subject. */
export interface StoredWorkspaceHeadState {
  /**
   * The NEWEST assertionVersion on the head subject (MAX, not an arbitrary
   * binding), or null when no version/operation row pair exists. MAX matters
   * because the append-style meta insert can leave several version rows on one
   * subject; reading an arbitrary one would let an older row veto — or worse,
   * authorize — a replace decision.
   */
  version: string | null;
  /**
   * True when the head subject carries rows from more than one assertion
   * version or share operation — the residue a union-style meta insert leaves
   * behind. Such a head is ambiguous for LIMIT-1 readers
   * (`resolveKnowledgeAssetWorkspaceHead`) and must be collapsed back to
   * exactly one version's rows via `replaceHeadMetadata`.
   */
  needsRepair: boolean;
  /**
   * GH#2273 — the head's single shareOperationId, or null when the head is
   * absent OR carries more than one distinct id. Non-null ONLY in the
   * unambiguous case, because its consumer is the prefer-local decision: a
   * queued VM-publish job froze this id at admission, and catch-up must not
   * replace it with a peer's equivalent id. SAMPLE over a multi-valued head
   * would be an arbitrary pick — exactly the failure this field exists to
   * prevent — so ambiguity reads as null and routes through repair instead.
   */
  shareOperationId: string | null;
}

/**
 * Everything `runSharedMemorySync` needs to MATERIALIZE verified public SWM
 * snapshots into the triple store, as ONE cohesive dependency.
 *
 * Why one object: these capabilities are only meaningful together. An earlier
 * revision exposed them as independent optionals, which allowed a silent
 * half-configured mode — a caller supplying the snapshot store but not the
 * guard would compile fine and quietly skip materialization. Absent entirely
 * => materialization is skipped (never half-applied).
 */
export interface SharedMemorySnapshotMaterializer {
  /**
   * Serialize against the live-gossip write path for one KA. MUST take the
   * same key on the same lock map SharedMemoryHandler uses (the agent owns
   * the map; the key comes from the shared `swmKaWriteLockKey`). Without it
   * this interleaving destroys data: catch-up observes the graph absent →
   * gossip commits a richer version → catch-up replaces it with the older
   * snapshot.
   */
  withKaWriteLock<T>(
    contextGraphId: string,
    subGraphName: string | undefined,
    kaUal: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  /**
   * Read the KA's stored head state (newest version + ambiguity flag). Read
   * INSIDE the lock: a lock prevents interleaving but not overwriting-with-
   * older, and gossip may have committed a newer version while catch-up
   * waited.
   */
  readStoredHead(descriptor: GraphScopedSwmRecoveryDescriptor): Promise<StoredWorkspaceHeadState>;
  /**
   * True only when the KA's assertion graph CONTENT equals the descriptor's:
   * same quad count AND same public-quads digest. A marker-only predicate
   * re-reports the pre-fix broken state (head metadata written, graph never
   * written) as materialized; a count-only predicate cannot tell two versions
   * of equal size apart and would skip a verified newer snapshot.
   */
  isGraphAssetMaterialized(descriptor: GraphScopedSwmRecoveryDescriptor): Promise<boolean>;
  /**
   * Atomic whole-graph replace. Replace, not insert: a KA graph is
   * all-or-nothing and digest-verified; union-insert risks partial or
   * duplicated state across retries.
   */
  replaceGraph(graphUri: string, quads: Quad[]): Promise<void>;
  /**
   * Delete the KA's head rows and every share-operation subject its head
   * references (including the descriptor's own, which the caller re-inserts
   * from fresh verified metadata). This is the catch-up lane's counterpart of
   * gossip's delete-then-insert (`storeKnowledgeAssetWorkspaceHead`) and the
   * private recovery lane's `replaceMetaForGraphAssets`: without it the
   * append-style meta insert stacks old and new head rows on one subject and
   * the durable current head becomes ambiguous.
   */
  replaceHeadMetadata(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<void>;
  /**
   * GH#2273 — decide whether a head repair may PRESERVE a locally stored
   * operation identity instead of adopting the descriptor's. Returns the
   * winning stored id when every stored operation the head references (other
   * than the descriptor's own) is identity-equivalent to the descriptor's
   * operation (`operationIdentityKey` over the allow-list — content
   * commitment, access envelope, ownership); ties break to the
   * lexicographically smallest id for determinism. Returns null — descriptor
   * wins, exactly today's behavior — when there is no foreign stored id, when
   * any stored operation's rows are missing or non-equivalent, or when either
   * side's identity key is unprovable. Callers MUST hold the KA write lock.
   */
  selectRepairIdentity(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<{
    winnerShareOperationId: string;
    /**
     * The descriptor rows every later write this round must withhold (the
     * losing head-id row). Returned WITH the decision so a caller holds the
     * complete plan in one value — deciding and withholding cannot be
     * separated by a forgotten second lookup.
     */
    withholdRows: readonly Quad[];
  } | null>;
  /**
   * GH#2273 — repair a (possibly multi-valued) head to certify the WINNER
   * identity chosen by `selectRepairIdentity`, deleting every other operation
   * subject the head references (same kaUal ownership guard as
   * `replaceHeadMetadata`) while NEVER deleting the winner's operation rows —
   * they are the only durable copy of the identity a queued VM-publish job
   * may reference. The head subject is rewritten (delete + insert of the
   * descriptor's head rows with the operation-id row swapped to the winner).
   * Crash window: between the head delete and re-insert the head is absent
   * with the winner's operation intact; the next round's absent-head repair
   * then installs the DESCRIPTOR identity — accepted residual, identical in
   * shape to today's window, and it self-converges.
   */
  repairHeadPreservingIdentity(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
    winnerShareOperationId: string,
  ): Promise<void>;
  /**
   * The ONE preserve decision for a skipped, already-materialized KA, and
   * its enactment, under a single hold of the KA write lock (GH#2273).
   *
   * Invariants: preserve only a healthy single-valued head that certifies
   * the descriptor's version (id-equal included — a stale version row
   * replaces); a foreign stored id must pass `selectRepairIdentity`'s
   * reader-contract gates. On 'preserved' the head is ALREADY rewritten
   * (descriptor rows + winner id — residue rows purged; preserving is a
   * rewrite, never a skip), and the caller owes the returned `withholdRows`
   * an exclusion from any later raw insert. 'replace' ⇒ today's meta
   * replacement. Decision and enactment stay together here so the lanes
   * cannot drift.
   */
  preserveStoredIdentityForSkippedAsset(
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<
    | { outcome: 'preserved'; withholdRows: readonly Quad[] }
    | { outcome: 'replace' }
  >;
  /**
   * The private curator-recovery lane's skip predicate. A head marker alone
   * cannot prove materialization: the assertion graph can be cleared while
   * its durable metadata survives. Reuse the same exact count+digest guard as
   * ordinary catch-up so a marker-only, partial, or equal-count stale graph is
   * repaired rather than reported as recovered. Living here (rather than as a
   * caller-supplied closure) keeps skip and preserve as one capability over
   * one store and lock map.
   */
  /**
   * Canonical graph-asset meta replacement (delete head + kaUal-owned linked
   * operation subjects) over THIS materializer's store — the one cleanup
   * implementation shared by the lifecycle wiring and the recovery suites.
   */
  replaceMetaForGraphAssets(assets: readonly GraphScopedSwmRecoveryDescriptor[]): Promise<void>;
}

/**
 * Build the production materializer over the agent's own store, lock map and
 * list-cache invalidation hook.
 */
export function createSharedMemorySnapshotMaterializer(deps: {
  store: TripleStore;
  /**
   * The SAME map injected into SharedMemoryHandler — sharing the map (and the
   * key helper) is what closes the check-then-replace race with gossip.
   */
  writeLocks: Map<string, Promise<void>>;
  invalidateListContextGraphsCache: () => void;
}): SharedMemorySnapshotMaterializer {
  // #2079 operator override, default ON. Blank is UNSET, not false:
  // `DKG_SWM_MATERIALIZATION_WITNESS=` is the normal compose/.env shape for
  // "not configured", and reading it as false would silently disable the memo
  // for a fleet that never asked. Read inside the factory rather than at module
  // scope so it takes effect on the next sync round after a restart.
  //
  // There is deliberately NO capability probe here. An earlier revision tested
  // `typeof deps.store.replaceSubject !== 'function'`, on the theory that
  // best-effort `sparql-http` could never hold a witness and
  // would otherwise pay the ASK forever. BOTH halves were false:
  //
  //   - every adapter and all three decorators DEFINE `replaceSubject` and
  //     throw `UnsupportedTripleStoreCapabilityError` INSIDE it, so the typeof
  //     is always "function" — the probe could never fire;
  //   - that profile also gates `replaceGraph`, so
  //     no writer can populate a SWM assertion graph at all. The graph stays
  //     empty, the count gate returns first, and the ASK is never reached.
  //     There was no cost to avoid.
  //
  // A latch on the first `false` from the write is the shape that WOULD work,
  // but not as currently wired: that call is `.catch(() => false)`, so a
  // transient endpoint error is indistinguishable from a capability refusal and
  // would disable the memo process-wide on a blip.
  const witnessUsable = (() => {
    const raw = process.env['DKG_SWM_MATERIALIZATION_WITNESS']?.trim();
    if (!raw) return true;
    return raw !== '0' && raw.toLowerCase() !== 'false';
  })();

  /**
   * The ONE discovery of which operation subjects a head references AND this
   * KA owns — the most delicate half of every head cleanup. Both the plain
   * replacement and the identity-preserving repair consume it, so the
   * subject format, the ownership ASK and any future deletion guard cannot
   * drift between the two paths. `excludeShareOperationId` spares a
   * preserved winner; `seed` pre-admits subjects the caller already owns
   * (the descriptor's own operation).
   */
  /**
   * Snapshot LOCATOR coherence — outside both the identity key (the
   * graph-form locator embeds the operation id) and the head decoder (which
   * never consumes snapshot pointers). Count is only the cheap pre-gate: a
   * stale same-size graph passes it, so the CONTENT digest must equal the
   * committed public digest — the same count-then-digest ladder
   * `isGraphAssetMaterialized` uses for the assertion graph.
   *
   * REF-form locators are NOT free passes: the resolver's read-both rule
   * (workspace-resolution: an explicit legacy `publicSnapshotRef` row WINS
   * over the digest fallback) means a stale ref would be FOLLOWED by
   * readers, not ignored. A ref is serveable only when it IS the committed
   * public digest (`putSnapshot` returns `ref === digest`, so the canonical
   * row is always digest-valued); multi-valued or mismatched refs refuse.
   * ABSENT locators (no graph, no ref) fall back to the digest convention —
   * content-addressed, no worse than the descriptor's own — and pass.
   */
  const snapshotLocatorIsServeable = async (
    storedRows: readonly Quad[],
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<boolean> => {
    const snapshotRefs = [...new Set(storedRows
      .filter((row) => row.predicate === `${DKG}publicSnapshotRef`)
      .map((row) => literalValue(row.object) ?? row.object))];
    if (snapshotRefs.length > 1) return false;
    const snapshotGraphs = [...new Set(storedRows
      .filter((row) => row.predicate === `${DKG}publicSnapshotGraph`)
      .map((row) => row.object))];
    if (snapshotGraphs.length > 1) return false;
    if (snapshotGraphs.length === 0) {
      return snapshotRefs.length === 0 || snapshotRefs[0] === descriptor.publicQuadsDigest;
    }
    if (snapshotRefs.length > 0) return false;
    // The READER's locator rule, not just SPARQL-injection safety: the public
    // snapshot resolver only follows graph locators that pass `isSafeIri`
    // (absolute, scheme-prefixed). A locator readers would reject must not
    // certify a preserved winner — and a malformed stored value must rank as
    // non-serveable rather than THROW out of the preservation check, which
    // would stall descriptor-wins repair on exactly the corrupt rows repair
    // exists for.
    const graphLocator = snapshotGraphs[0]!;
    if (!isSafeIri(graphLocator)) return false;
    let snapshotContent;
    try {
      snapshotContent = await deps.store.query(
        `SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(graphLocator)}> { ?s ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.checkWinnerSnapshot' },
      );
    } catch {
      return false;
    }
    if (snapshotContent.type !== 'bindings') return false;
    if (snapshotContent.bindings.length !== descriptor.publicQuadsCount) return false;
    const digest = workspacePublicQuadsDigest(snapshotContent.bindings.map((row) => ({
      subject: row['s'] ?? '',
      predicate: row['p'] ?? '',
      object: row['o'] ?? '',
      graph: '',
    })));
    return digest === descriptor.publicQuadsDigest;
  };

  /**
   * ONE deletion-set rule for graph-asset cleanup: the kaUal-owned operation
   * subjects linked through the head's CURRENT shareOperationId rows (a
   * head-join, so non-convention subjects are found too), optionally sparing
   * one id's subject (the preserving repair's winner) and seeding extras.
   * Both `repairHeadPreservingIdentity` and `replaceMetaForGraphAssets`
   * consume this — the ownership guard cannot drift between them.
   */
  const collectOwnedHeadOperationSubjects = async (
    descriptor: GraphScopedSwmRecoveryDescriptor,
    options: { seed?: readonly string[]; excludeShareOperationId?: string },
  ): Promise<Set<string>> => {
    const linked = await deps.store.query(
      `SELECT DISTINCT ?op ?shareId WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
      + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?shareId . `
      + `?op <${DKG}shareOperationId> ?shareId ; `
      + `<${DKG}kaUal> <${assertSafeIri(descriptor.kaUal)}> . } }`,
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.findOperations' },
    );
    const subjects = new Set<string>(options.seed ?? []);
    if (linked.type === 'bindings') {
      for (const row of linked.bindings) {
        const shareId = literalValue(row?.['shareId']);
        const operationSubject = row?.['op'];
        if (!operationSubject) continue;
        // The head subject itself carries both joined predicates — it is the
        // thing being REWRITTEN, never a deletable operation subject.
        if (operationSubject === descriptor.headSubject) continue;
        if (shareId !== undefined && shareId === options.excludeShareOperationId) continue;
        subjects.add(operationSubject);
      }
    }
    return subjects;
  };

  const readStoredHead: SharedMemorySnapshotMaterializer['readStoredHead'] = async (descriptor) => {
    // Aggregates over ONE bound subject in the KA's meta graph: bounded by
    // that subject's row count. COUNT(DISTINCT …) doubles as the duplicate
    // detector — more than one version or operation value on the head is the
    // union-insert residue that must be repaired.
    const result = await deps.store.query(
      `SELECT (MAX(?v) AS ?maxVersion) (COUNT(DISTINCT ?v) AS ?versions) `
      + `(COUNT(DISTINCT ?op) AS ?operations) (SAMPLE(?op) AS ?anyOp) WHERE { `
      + `GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
      + `<${assertSafeIri(descriptor.headSubject)}> `
      + `<${DKG}assertionVersion> ?v ; `
      + `<${DKG}shareOperationId> ?op } }`,
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readStoredHead' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return { version: null, needsRepair: false, shareOperationId: null };
    }
    const row = result.bindings[0];
    const version = literalValue(row?.['maxVersion']);
    const versions = parseCount(row?.['versions']);
    const operations = parseCount(row?.['operations']);
    // SAMPLE is deterministic only when there is exactly one distinct id;
    // with more, ANY pick would be arbitrary, so the id reads as null and
    // `needsRepair` routes the decision through repair instead.
    const sampledOperationId = literalValue(row?.['anyOp']);
    return {
      version: version && version.length > 0 ? version : null,
      needsRepair: versions > 1 || operations > 1,
      shareOperationId:
        operations === 1 && sampledOperationId && sampledOperationId.length > 0
          ? sampledOperationId
          : null,
    };
  };

  /** One bounded head join acquires the complete candidate model for both consumers. */
  const loadStoredOperationCandidates = async (
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<Map<string, Quad[]> | null> => {
    const operationResult = await deps.store.query(
      `SELECT ?op ?p ?o WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
      + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?id . `
      + `?op <${DKG}shareOperationId> ?id ; ?p ?o } }`,
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.loadCandidates' },
    );
    if (operationResult.type !== 'bindings') return null;
    const rowsBySubject = new Map<string, Quad[]>();
    for (const row of operationResult.bindings) {
      const subject = row['op'] ?? '';
      // The head itself also carries shareOperationId + kaUal. It proves the
      // pointer, but it is not the WorkspaceOperation whose commitment must
      // be decoded.
      if (!subject || subject === descriptor.headSubject) continue;
      const rows = rowsBySubject.get(subject) ?? [];
      rows.push({
        subject,
        predicate: row['p'] ?? '',
        object: row['o'] ?? '',
        graph: descriptor.metaGraph,
      });
      rowsBySubject.set(subject, rows);
    }
    return rowsBySubject;
  };

  /** The complete stored-operation invariant, shared by preservation and empty projection. */
  const validateStoredOperation = async (input: Readonly<{
    storedRows: readonly Quad[];
    descriptor: GraphScopedSwmRecoveryDescriptor;
    descriptorKey: string;
    shareOperationId: string;
  }>): Promise<boolean> => {
    const { storedRows, descriptor, descriptorKey, shareOperationId } = input;
    return operationIdentityMatches(storedRows, descriptorKey)
      && storedWinnerIsDecodable(storedRows, descriptor, shareOperationId)
      && storedWinnerHasResponderType(storedRows)
      && storedWinnerHasUsableAccessEnvelope(storedRows)
      && await snapshotLocatorIsServeable(storedRows, descriptor);
  };

  const selectRepairIdentity: SharedMemorySnapshotMaterializer['selectRepairIdentity'] = async (
    contextGraphId,
    descriptor,
  ) => {
    const shareIds = await deps.store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
      + `<${assertSafeIri(descriptor.headSubject)}> <${DKG}shareOperationId> ?op } }`,
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.selectRepairIdentity' },
    );
    if (shareIds.type !== 'bindings') return null;
    const foreignIds = [...new Set(
      shareIds.bindings
        .map((row) => literalValue(row?.['op']))
        .filter((id): id is string => Boolean(id && id.length > 0)),
    )].filter((id) => id !== descriptor.shareOperationId).sort();
    if (foreignIds.length === 0) return null;
    const descriptorKey = operationIdentityKey(
      descriptor.metadataQuads.filter((quad) => quad.subject === descriptor.operationSubject),
    );
    if (descriptorKey === null) return null;
    const rowsBySubject = await loadStoredOperationCandidates(descriptor);
    if (rowsBySubject === null) return null;
    for (const foreignId of foreignIds) {
      const operationSubject = `urn:dkg:share:${contextGraphId}:${foreignId}`;
      const storedRows = rowsBySubject.get(operationSubject) ?? [];
      if (storedRows.length === 0) return null;
      // The preserved-winner contract, as NAMED validators (each pinned by
      // its own polarity row): identity-equivalent under the allow-list,
      // acceptable to the head resolver's decoder + stamp rule, carries
      // the responder-join type row, and its snapshot locator (if graph-
      // form) actually serves the committed content. Any failure routes to
      // descriptor-wins — today's behavior, and the correct one both for a
      // GENUINE change and for a winner some reader would reject (a
      // preserved-but-unreadable winner is the wedge shape: preserved this
      // round, corrupt to a reader, preserved again next round).
      if (!(await validateStoredOperation({
        storedRows,
        descriptor,
        descriptorKey,
        shareOperationId: foreignId,
      }))) return null;
    }
    return {
      winnerShareOperationId: foreignIds[0]!,
      withholdRows: descriptor.metadataQuads.filter((quad) =>
        quad.subject === descriptor.headSubject
        && quad.predicate === `${DKG}shareOperationId`),
    };
  };

  /**
   * An empty named graph is indistinguishable from an absent named graph.
   * Private-only assets therefore also need a healthy, exact control-plane
   * commitment before the canonical empty projection can prove materialized.
   */
  const hasHealthyEmptyProjectionControlPlane = async (
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<boolean> => {
    const head = await readStoredHead(descriptor);
    if (head.needsRepair || head.version === null || head.shareOperationId === null) return false;
    try {
      if (BigInt(head.version) !== BigInt(descriptor.assertionVersion)) return false;
    } catch {
      return false;
    }
    if (head.shareOperationId !== descriptor.shareOperationId) {
      const contextGraphId = literalValue(descriptor.metadataQuads.find((quad) => (
        quad.subject === descriptor.operationSubject
        && quad.predicate === `${DKG}contextGraphId`
      ))?.object);
      return contextGraphId !== undefined
        && await selectRepairIdentity(contextGraphId, descriptor) !== null;
    }
    const descriptorKey = operationIdentityKey(
      descriptor.metadataQuads.filter((quad) => quad.subject === descriptor.operationSubject),
    );
    if (descriptorKey === null) return false;
    const rowsBySubject = await loadStoredOperationCandidates(descriptor);
    if (rowsBySubject === null) return false;
    const candidates = [...rowsBySubject.values()].filter((rows) => rows.some((row) => (
      row.predicate === `${DKG}shareOperationId`
      && literalValue(row.object) === head.shareOperationId
    )));
    if (candidates.length !== 1) return false;
    return validateStoredOperation({
      storedRows: candidates[0]!,
      descriptor,
      descriptorKey,
      shareOperationId: head.shareOperationId,
    });
  };

  const repairHeadPreservingIdentity: SharedMemorySnapshotMaterializer['repairHeadPreservingIdentity'] = async (contextGraphId, descriptor, winnerShareOperationId) => {
    const loserSubjects = await collectOwnedHeadOperationSubjects(descriptor, {
      seed: descriptor.shareOperationId !== winnerShareOperationId
        ? [descriptor.operationSubject]
        : [],
      excludeShareOperationId: winnerShareOperationId,
    });
    // ORDER MATTERS: rewrite the head FIRST, delete the losers AFTER. A
    // crash between the two then leaves a HEALTHY single-valued head plus
    // stale loser operation subjects — benign residue (they are
    // identity-equivalent by the selection above, and nothing references
    // them). The reverse order would leave a still-multi-valued head naming
    // operations whose rows are already gone: readers fail closed on a
    // state that is only half repaired.
    //
    // Head rows: the descriptor's own four non-id rows are byte-identical to
    // what the winner's head must carry (identity equivalence pins kaUal and
    // assertionVersion; contentScopeVersion is constant; assertionGraph is
    // derived from UAL + version), so only the operation-id row is swapped.
    const headRows = descriptor.metadataQuads
      .filter((quad) => quad.subject === descriptor.headSubject)
      .map((quad) => quad.predicate === `${DKG}shareOperationId`
        ? { ...quad, object: JSON.stringify(winnerShareOperationId) }
        : { ...quad });
    await deps.store.deleteByPattern(
      { graph: descriptor.metaGraph, subject: descriptor.headSubject },
      { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteHead' },
    );
    await deps.store.insert(headRows, {
      priority: 'background',
      source: 'agent.sharedMemorySync.snapshotMaterializer.writePreservedHead',
    });
    for (const operationSubject of loserSubjects) {
      await deps.store.deleteByPattern(
        { graph: descriptor.metaGraph, subject: operationSubject },
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteOperation' },
      );
    }
    deps.invalidateListContextGraphsCache();
  };

  const materializer: SharedMemorySnapshotMaterializer = {
    withKaWriteLock: (contextGraphId, subGraphName, kaUal, fn) =>
      withKeyedLocks(deps.writeLocks, [swmKaWriteLockKey(contextGraphId, subGraphName, kaUal)], fn),

    readStoredHead,

    isGraphAssetMaterialized: async (descriptor) => {
      const expected = descriptor.publicQuadsCount;
      if (!Number.isSafeInteger(expected) || expected < 0) return false;
      // 1) Count gate: exact-IRI scope, so bounded — and cheap enough to run
      // every round. Strictly equal: a short graph is a partial write and must
      // be replaced, not treated as already materialized.
      const countResult = await deps.store.query(
        `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${assertSafeIri(descriptor.assertionGraph)}> { ?s ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.countGraph' },
      );
      if (countResult.type !== 'bindings' || countResult.bindings.length === 0) return false;
      const present = Number.parseInt(literalValue(countResult.bindings[0]?.['n']) ?? '0', 10);
      if (!Number.isFinite(present) || present !== expected) return false;
      if (expected === 0 && !(await hasHealthyEmptyProjectionControlPlane(descriptor))) {
        return false;
      }
      // 1b) Witness fast path (#2079): a bound-subject ASK recording that THIS
      // node already read this graph back and matched this exact digest. It is
      // a memo of the measurement in step 2 — never an independent claim — so
      // it is only reachable in a state where step 2 would also return true.
      //
      // Deliberately AFTER the count gate, not instead of it. Three paths
      // remove an assertion graph outside this lock — the SWM TTL sweep, VM
      // promote/publish/update (a different lock map), and the chain-reset
      // wipe, whose scoped delete spares `urn:dkg:local:*` and so leaves the
      // witness standing over a wiped store. The count catches all three for
      // free. Measured, also skipping the count buys a further 1.5–10.5%,
      // which is not worth trading self-healing for. Do not reorder these.
      if (
        witnessUsable
        && await readSwmMaterializationWitness(
          deps.store,
          descriptor.assertionGraph,
          descriptor.publicQuadsDigest,
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.witnessAsk' },
        )
      ) {
        return true;
      }
      // 2) Content binding: a matching count does not prove the stored graph
      // is THIS descriptor's content — all versions of a graph-scoped KA share
      // one graph URI, so an older version of equal size would otherwise pass
      // and the verified newer snapshot would be skipped forever. Reading the
      // graph back only runs when the count already matches, so it is bounded
      // by exactly the snapshot size we would otherwise write; the digest is
      // the same store-roundtrip check `resolveWorkspaceOperation` relies on.
      const contentResult = await deps.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(descriptor.assertionGraph)}> { ?s ?p ?o } }`,
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readGraph' },
      );
      // TripleStore adapters guarantee a quad result for CONSTRUCT queries.
      // Fail closed if an adapter violates that contract.
      if (contentResult.type !== 'quads') return false;
      const stored = contentResult.quads.map((quad) => ({ ...quad, graph: '' }));
      const matches = workspacePublicQuadsDigest(stored) === descriptor.publicQuadsDigest;
      if (matches && witnessUsable) {
        // Written HERE — from the branch that just computed the digest over
        // this node's own store content and matched it — and nowhere else.
        // That is what makes the witness sound: it cannot record anything a
        // peer asserted, and there is no crash window in which a witness
        // exists for content that was never verified, because the content was
        // read before this line runs.
        //
        // Best-effort: a failed or unsupported write costs one recomputation
        // next round, so it must never fail the check that just succeeded.
        await writeSwmMaterializationWitness(
          deps.store,
          descriptor.assertionGraph,
          descriptor.publicQuadsDigest,

          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.witnessWrite' },
        ).catch(() => false);
      }
      return matches;
    },

    replaceGraph: async (graphUri, quads) => {
      // Deliberately NOT routed through the sync lane's guarded union insert:
      // a KA graph is all-or-nothing and digest-verified, so it must land via
      // the atomic replace or not at all.
      if (typeof deps.store.replaceGraph !== 'function') {
        throw new Error('triple store does not support atomic graph replace');
      }
      await deps.store.replaceGraph(graphUri, quads, {
        priority: 'background',
        source: 'agent.sharedMemorySync.materializeSnapshot',
      });
      // #2079: the content just changed, so any witness for it now describes
      // bytes that are gone. Defence in depth, NOT the thing that makes an
      // equal-count replace safe — be precise about this, because the
      // difference decides whether the read may ever stop binding the digest.
      //
      // What actually makes v1 → v2 safe is that the witness READ binds the
      // digest as well as the subject: a standing v1 row cannot match an ASK
      // for v2's digest, so the check falls through to the CONSTRUCT and the
      // write then evicts v1 atomically. That holds with or without this call,
      // and it is the property the tests pin.
      //
      // Where the digest binding does NOT cover, and this call is the only
      // cover: witness(v1) + content(v2) + a descriptor still naming v1. The
      // binding protects the (old witness, new descriptor) direction; it does
      // nothing for (old witness, old descriptor, new content), because there
      // the ASK's digest and the witness's digest agree while the store has
      // moved on. That asymmetry is why this is not merely hygiene.
      //
      // It is nevertheless BEST EFFORT — `.catch` below — so the residual is
      // real rather than zero: a swallowed failure, or a crash between the
      // replace and this line, reaches exactly that state. It is bounded by the
      // count gate whenever the replace also changed the quad count, and by the
      // next successful verify otherwise. Ordering is after the replace because
      // invalidating first would drop a still-valid memo on a replace that then
      // throws; neither order removes the window.
      await invalidateSwmMaterializationWitness(deps.store, graphUri, {
        priority: 'background',
        source: 'agent.sharedMemorySync.materializeSnapshot.witnessInvalidate',
      }).catch(() => {});
      deps.invalidateListContextGraphsCache();
    },

    replaceHeadMetadata: async (contextGraphId, descriptor) => {
      const operationSubjects = await collectOwnedHeadOperationSubjects(descriptor, {
        seed: [descriptor.operationSubject],
      });
      await deps.store.deleteByPattern(
        { graph: descriptor.metaGraph, subject: descriptor.headSubject },
        { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteHead' },
      );
      for (const operationSubject of operationSubjects) {
        await deps.store.deleteByPattern(
          { graph: descriptor.metaGraph, subject: operationSubject },
          { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.deleteOperation' },
        );
      }
    },

    replaceMetaForGraphAssets: async (assets) => {
      for (const asset of assets) {
        // ONE deletion-set rule with the preserving repair: the kaUal-owned
        // operation subjects linked through the head's current id rows (no
        // exclusion — full replacement), seeded with the descriptor's own.
        const operationSubjects = await collectOwnedHeadOperationSubjects(
          asset,
          { seed: [asset.operationSubject] },
        );
        await deps.store.deleteByPattern(
          { graph: asset.metaGraph, subject: asset.headSubject },
          { priority: 'background', source: 'agent.swmRecovery.replaceMetaForGraphAssets.deleteHead' },
        );
        for (const operationSubject of operationSubjects) {
          await deps.store.deleteByPattern(
            { graph: asset.metaGraph, subject: operationSubject },
            { priority: 'background', source: 'agent.swmRecovery.replaceMetaForGraphAssets.deleteOperation' },
          );
        }
      }
    },

    preserveStoredIdentityForSkippedAsset: async (contextGraphId, descriptor) => {
      return withKeyedLocks(
        deps.writeLocks,
        [swmKaWriteLockKey(contextGraphId, descriptor.subGraphName, descriptor.kaUal)],
        async () => {
          const stored = await readStoredHead(descriptor);
          // Every conjunct applies to BOTH the same-id and foreign-id cases:
          // an id-equal head with a stale or corrupt version row is NOT
          // healthy, and preserving it would leave unrepaired metadata in
          // place while withholding nothing the union could not re-stack.
          if (stored.needsRepair || stored.version === null || stored.shareOperationId === null) {
            return { outcome: 'replace' as const };
          }
          try {
            if (BigInt(stored.version) !== BigInt(descriptor.assertionVersion)) {
              return { outcome: 'replace' as const };
            }
          } catch {
            return { outcome: 'replace' as const };
          }
          if (stored.shareOperationId === descriptor.shareOperationId) {
            // Identical id: replacement IS identity-preserving by
            // construction (the descriptor reinstalls the same id), and it
            // is the only healer for op-subject corruption — a duplicate
            // singleton row survives any union insert, and a skip would park
            // the KA on rows the resolver fails closed on, forever.
            return { outcome: 'replace' as const };
          }
          const selected = await selectRepairIdentity(contextGraphId, descriptor);
          if (selected === null) return { outcome: 'replace' as const };
          const { winnerShareOperationId, withholdRows } = selected;
          // ENACT while still holding the lock: rewrite the head from the
          // descriptor's rows with the id swapped to the winner. The health
          // check above models only version/id cardinality; the rewrite is
          // what purges residue rows on the head subject (an extra stale
          // assertionGraph row survives the check but not the rewrite) and
          // what keeps 'preserved' at least as convergent as the bulk
          // replacement it suppresses.
          await repairHeadPreservingIdentity(
            contextGraphId,
            descriptor,
            winnerShareOperationId,
          );
          return { outcome: 'preserved' as const, withholdRows };
        },
      );
    },

    selectRepairIdentity,

    repairHeadPreservingIdentity,
  };
  return materializer;
}

/** Strip the lexical value out of an N-Triples-style literal binding. */
function literalValue(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const literal = /^"([^"]*)"/.exec(binding);
  return literal ? literal[1] : binding;
}

function parseCount(binding: string | undefined): number {
  const parsed = Number.parseInt(literalValue(binding) ?? '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
