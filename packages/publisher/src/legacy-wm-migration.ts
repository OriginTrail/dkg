/**
 * Legacy root-scoped Working Memory migration (issue #2149).
 *
 * Upgraded nodes can still hold a pre-graph-scope, name-keyed WM draft such
 * as `agent-context/chat-turns`. The normal mutation APIs deliberately keep
 * legacy/root-scoped KAs read-only, so this module implements the one
 * explicit, opt-in migration for a caller-selected local assertion.
 * `DKGPublisher.migrateLegacyRootScopedWorkingMemory` stays the lock-owning
 * façade and supplies its store / private-store / create / write primitives
 * through `LegacyWmMigrationHost`; this module owns phase ordering and
 * classification:
 *
 *   load marker → load lifecycle → summarize → classify → load + validate
 *   content → prepare backup → apply graph-scoped draft → complete marker
 *
 * `classifyLegacyWmMigration` is the ONLY place a migration is decided: it
 * takes the marker × lifecycle matrix and returns an exhaustive typed
 * `LegacyWmMigrationPlan` — `not-needed` (already graph-scoped, or no legacy
 * draft), `eligible-fresh`, or `prepared-resume` — or throws a coded refusal
 * (`KA_LEGACY_WM_MIGRATION_REFUSED`, `KA_LEGACY_WM_MIGRATION_REQUIRES_IDENTITY`).
 * `eligible-fresh` genuinely means eligible; no later phase re-decides
 * whether a draft may migrate, so the restart states and allowed transitions
 * are explicit rather than implicit in one long mutable procedure.
 *
 * Safety properties:
 * - only an active `created`/`WM` lifecycle with no SWM/VM/promote state is
 *   eligible;
 * - the legacy data graphs are retained as the durable backup;
 * - the complete legacy lifecycle/event metadata is copied to a deterministic
 *   backup graph before active metadata is changed;
 * - a `prepared` marker makes every later step restart-idempotent;
 * - public data is copied into a newly allocated graph-scoped WM graph while
 *   private draft data stays intact under its stable lifecycle key.
 */
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  assertSafeIri,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  PROMOTE_OPERATION_INTENT_PRED,
  SHARE_OPERATION_ID_PRED,
  SWM_CURRENT_ASSERTION_PRED,
  VM_CURRENT_ASSERTION_PRED,
} from './metadata.js';
import { stripOptionalLiteral } from './sparql-binding-literal.js';

const DKG = 'http://dkg.io/ontology/';
const STATE_PRED = `${DKG}legacyWorkingMemoryMigrationState`;
const TARGET_PRED = `${DKG}legacyWorkingMemoryMigrationTarget`;
const COPIED_PUBLIC_PRED = `${DKG}legacyWorkingMemoryMigrationCopiedPublic`;
const PRESERVED_PRIVATE_PRED = `${DKG}legacyWorkingMemoryMigrationPreservedPrivate`;
const APPLIED_AT_PRED = `${DKG}legacyWorkingMemoryMigrationAppliedAt`;
const MAX_LIFECYCLE_ROWS = 10_000;

export interface LegacyWmMigrationRequest {
  contextGraphId: string;
  name: string;
  agentAddress: string;
  subGraphName?: string;
  allocateKaNumber?: () => Promise<{ number: bigint; reservedUal: string }>;
}

export interface LegacyWmMigrationResult {
  status: 'not-needed' | 'migrated' | 'resumed';
  copiedPublic: number;
  preservedPrivate: number;
  sourceGraph: string;
  targetGraph?: string;
  backupGraph: string;
}

/**
 * Primitives the lock-owning `DKGPublisher` façade supplies. The migration
 * never touches publisher internals directly, so the boundary that decides
 * what a migration is ALLOWED to do stays reviewable in one interface.
 */
export interface LegacyWmMigrationHost {
  store: Pick<TripleStore, 'query' | 'insert' | 'createGraph' | 'deleteByPattern'>;
  /** Validate the sub-graph name and assert it is registered. */
  prepareSubGraph(contextGraphId: string, subGraphName: string | undefined): Promise<void>;
  /**
   * Read the legacy draft's public + private content AND gate it, throwing
   * unless it may enter the graph-scoped assertion boundary. Read and gate
   * are one primitive because the migration must never hold un-validated
   * legacy content.
   */
  loadMigratableContent(
    sourceGraph: string,
    request: LegacyWmMigrationRequest,
  ): Promise<{ publicQuads: Quad[]; privateQuads: Quad[] }>;
  /** Whether the publisher can mint a KA number itself for this author. */
  canSelfAllocateGraphIdentity(agentAddress: string): boolean;
  createGraphScopedDraft(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName: string | undefined,
    opts: { allocateKaNumber?: () => Promise<{ number: bigint; reservedUal: string }> },
  ): Promise<unknown>;
  writeGraphScopedDraft(
    contextGraphId: string,
    name: string,
    agentAddress: string,
    quads: Quad[],
    subGraphName: string | undefined,
  ): Promise<unknown>;
  wmGraphUri(
    contextGraphId: string,
    agentAddress: string,
    name: string,
    subGraphName: string | undefined,
  ): Promise<string>;
  logInfo(message: string): void;
}

/**
 * Which mutating steps this run still owes, decided ONCE by the classifier.
 *
 * A `prepared` marker says preparation happened but not which later steps
 * did, so resume progress used to be re-derived inside the mutating phase.
 * Naming the steps here keeps that decision in the classifier; the apply
 * phase only executes what it is handed.
 *
 * Deliberately derived, not persisted: the durable marker vocabulary stays
 * `prepared`/`completed`, so markers written by already-shipped nodes keep
 * resuming correctly. Every step is idempotent, which is what makes deriving
 * them from observed state sound.
 */
export interface LegacyWmMigrationSteps {
  /** Copy lifecycle rows to the backup graph and stamp `prepared`. */
  prepareBackup: boolean;
  /** Clear legacy metadata and mint the graph-scoped draft identity. */
  createGraphScopedDraft: boolean;
}

/**
 * The typed migration phases a request can classify into. Refusals throw.
 *
 * The two `not-needed` reasons differ in what they may report: an
 * already-migrated draft echoes its recorded marker counts/target, while a
 * draft with no active lifecycle reports nothing — its marker rows, if any
 * survived, describe an assertion that is gone.
 */
export type LegacyWmMigrationPlan =
  | { phase: 'not-needed'; reason: 'already-graph-scoped' | 'no-legacy-draft' }
  | { phase: 'eligible-fresh'; steps: LegacyWmMigrationSteps }
  | { phase: 'prepared-resume'; steps: LegacyWmMigrationSteps };

interface MigrationUris {
  lifecycle: string;
  metaGraph: string;
  sourceGraph: string;
  backupGraph: string;
  /** Marker rows hang off the legacy source graph inside the backup graph. */
  markerSubject: string;
}

interface MigrationMarker {
  state: string | undefined;
  targetGraph: string | undefined;
  copiedPublic: number;
  preservedPrivate: number;
}

/**
 * A complete lifecycle/event metadata row. SPARQL binding optionality is
 * resolved once, at the query boundary in `toLifecycleRow`, so every phase
 * downstream operates on a strict model instead of re-asserting non-null.
 */
export interface LifecycleRow {
  s: string;
  p: string;
  o: string;
}

/** Narrow one raw SPARQL binding to a complete row, or drop it. */
export function toLifecycleRow(binding: Record<string, string | undefined>): LifecycleRow | null {
  const { s, p, o } = binding;
  return s && p && o != null ? { s, p, o } : null;
}

/**
 * The complete lifecycle picture the classifier decides from.
 *
 * Deliberately carries NO total-row count. `loadLifecycleRows` returns the
 * active lifecycle subject AND its `…/event/{id}` provenance children, and
 * every decision here is about the active subject only — a count spanning
 * both reads as "a draft exists" when only orphan event rows survive.
 */
export interface LifecycleSummary {
  activeRows: LifecycleRow[];
  scopeVersions: Set<string>;
  isGraphScoped: boolean;
  states: Set<string>;
  layers: Set<string>;
  /** Any SWM/VM pointer, share operation, or promote intent on the draft. */
  hasDurableOrInFlightState: boolean;
}

function migrationRefused(message: string): Error {
  return Object.assign(new Error(message), { code: 'KA_LEGACY_WM_MIGRATION_REFUSED' });
}

function identityAllocatorRequired(contextGraphId: string, name: string): Error {
  return Object.assign(
    new Error(
      `Legacy WM migration requires a graph-scoped identity allocator for ${contextGraphId}/${name}`,
    ),
    { code: 'KA_LEGACY_WM_MIGRATION_REQUIRES_IDENTITY' },
  );
}

function migrationUris(request: LegacyWmMigrationRequest): MigrationUris {
  const { contextGraphId, name, agentAddress, subGraphName } = request;
  // Derivation order is load-bearing: when more than one derived URI is
  // unsafe the caller must keep seeing the lifecycle-flavored error first.
  const lifecycle = assertSafeIri(
    assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName),
  );
  const metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const sourceGraph = assertSafeIri(
    contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName),
  );
  return {
    lifecycle,
    metaGraph,
    sourceGraph,
    backupGraph: assertSafeIri(
      `${metaGraph}/legacy-wm-backup/${encodeURIComponent(agentAddress.toLowerCase())}`
      + `/${encodeURIComponent(name)}`
      + (subGraphName ? `/${encodeURIComponent(subGraphName)}` : ''),
    ),
    markerSubject: sourceGraph,
  };
}

/** Phase 1 — load the durable restart marker from the backup graph. */
async function loadMigrationMarker(
  store: LegacyWmMigrationHost['store'],
  uris: MigrationUris,
): Promise<MigrationMarker> {
  const result = await store.query(
    `SELECT ?state ?target ?copied ?private WHERE { GRAPH <${uris.backupGraph}> {
      OPTIONAL { <${uris.markerSubject}> <${STATE_PRED}> ?state }
      OPTIONAL { <${uris.markerSubject}> <${TARGET_PRED}> ?target }
      OPTIONAL { <${uris.markerSubject}> <${COPIED_PUBLIC_PRED}> ?copied }
      OPTIONAL { <${uris.markerSubject}> <${PRESERVED_PRIVATE_PRED}> ?private }
    } } LIMIT 4`,
  );
  const binding = result.type === 'bindings' ? result.bindings[0] : undefined;
  const copiedPublic = Number(stripOptionalLiteral(binding?.['copied']) ?? 0);
  const preservedPrivate = Number(stripOptionalLiteral(binding?.['private']) ?? 0);
  return {
    state: stripOptionalLiteral(binding?.['state']),
    targetGraph: binding?.['target'],
    copiedPublic: Number.isFinite(copiedPublic) ? copiedPublic : 0,
    preservedPrivate: Number.isFinite(preservedPrivate) ? preservedPrivate : 0,
  };
}

/** Phase 2 — load the complete lifecycle/event row set for this assertion. */
async function loadLifecycleRows(
  store: LegacyWmMigrationHost['store'],
  uris: MigrationUris,
  name: string,
): Promise<LifecycleRow[]> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${uris.metaGraph}> {
      ?s ?p ?o .
      FILTER(STR(?s) = ${JSON.stringify(uris.lifecycle)} || STRSTARTS(STR(?s), ${JSON.stringify(`${uris.lifecycle}/`)}))
    } } LIMIT ${MAX_LIFECYCLE_ROWS + 1}`,
  );
  const rows = result.type === 'bindings'
    ? result.bindings.map(toLifecycleRow).filter((row): row is LifecycleRow => row !== null)
    : [];
  if (rows.length > MAX_LIFECYCLE_ROWS) {
    throw migrationRefused(
      `Legacy WM migration refused: lifecycle metadata exceeds ${MAX_LIFECYCLE_ROWS} rows for ${name}`,
    );
  }
  return rows;
}

/**
 * Pure classifier — everything the migration decision reads out of the
 * lifecycle rows, computed once so no later phase re-derives it.
 */
export function summarizeLifecycle(
  lifecycleRows: LifecycleRow[],
  lifecycle: string,
): LifecycleSummary {
  const activeRows = lifecycleRows.filter((row) => row.s === lifecycle);
  const activeValues = (predicate: string): Set<string> => new Set(
    activeRows
      .filter((row) => row.p === predicate)
      .map((row) => stripOptionalLiteral(row.o))
      .filter((value): value is string => value !== undefined),
  );
  const scopeVersions = activeValues(`${DKG}contentScopeVersion`);
  return {
    activeRows,
    scopeVersions,
    isGraphScoped: scopeVersions.size === 1
      && scopeVersions.has(String(GRAPH_KA_CONTENT_SCOPE_VERSION)),
    states: activeValues(`${DKG}state`),
    layers: activeValues(`${DKG}memoryLayer`),
    hasDurableOrInFlightState: activeRows.some((row) =>
      row.p === SWM_CURRENT_ASSERTION_PRED
      || row.p === VM_CURRENT_ASSERTION_PRED
      || row.p === SHARE_OPERATION_ID_PRED
      || row.p === PROMOTE_OPERATION_INTENT_PRED,
    ),
  };
}

/**
 * The single classifier for the migration state machine: marker × lifecycle
 * in, an exhaustive plan out, refusals thrown. `eligible-fresh` genuinely
 * means eligible — nothing downstream re-decides whether a draft may migrate.
 *
 * Ordering is part of the durable contract:
 * 1. an already graph-scoped draft is done, even under a stale marker;
 * 2. an unrecognized marker state refuses rather than guessing;
 * 3. a `prepared` marker resumes — preparation deliberately clears the legacy
 *    rows, so zero rows there means "resume", not "nothing to do";
 * 4. no rows on the ACTIVE lifecycle subject means there is nothing to
 *    migrate — whether a draft was never created, or one was cleared and only
 *    orphan `…/event/{id}` provenance rows survive. This must stay a no-op:
 *    the daemon runs migration ahead of `createAssertion`, so refusing here
 *    would permanently block the create that would otherwise sweep those
 *    orphans away (and, after any successful migration, the `completed`
 *    marker is durable forever);
 * 5. otherwise the draft must pass the full local-draft eligibility gate.
 *
 * `loadSeal` is a thunk so the seal ASK is only issued for a draft that has
 * actually reached the eligibility decision.
 */
export async function classifyLegacyWmMigration(
  input: {
    markerState: string | undefined;
    summary: LifecycleSummary;
    contextGraphId: string;
    name: string;
  },
  loadSeal: () => Promise<boolean>,
): Promise<LegacyWmMigrationPlan> {
  const { markerState, summary } = input;
  if (summary.isGraphScoped && markerState !== 'prepared') {
    return { phase: 'not-needed', reason: 'already-graph-scoped' };
  }
  if (markerState !== undefined && markerState !== 'prepared' && markerState !== 'completed') {
    throw migrationRefused(
      `Legacy WM migration refused: unsupported marker state ${markerState}`,
    );
  }
  if (markerState === 'prepared') {
    // Preparation already happened; what remains depends on how far the
    // interrupted run got, which the lifecycle shape reports.
    return {
      phase: 'prepared-resume',
      steps: { prepareBackup: false, createGraphScopedDraft: !summary.isGraphScoped },
    };
  }
  if (summary.activeRows.length === 0) {
    return { phase: 'not-needed', reason: 'no-legacy-draft' };
  }
  if (
    summary.scopeVersions.size > 1
    || summary.states.size !== 1
    || !summary.states.has('created')
    || summary.layers.size !== 1
    || !summary.layers.has(MemoryLayer.WorkingMemory)
    || summary.hasDurableOrInFlightState
    || await loadSeal()
  ) {
    throw migrationRefused(
      `Legacy WM migration refused for ${input.contextGraphId}/${input.name}: only an active, local created/WM draft is eligible`,
    );
  }
  return {
    phase: 'eligible-fresh',
    steps: { prepareBackup: true, createGraphScopedDraft: !summary.isGraphScoped },
  };
}

/** Is the legacy source graph carrying any assertion seal? */
async function loadSealFlag(
  host: LegacyWmMigrationHost,
  uris: MigrationUris,
): Promise<boolean> {
  const sealPredicates = [...new Set(Object.values(ASSERTION_SEAL_PREDICATES))]
    .map((predicate) => `<${assertSafeIri(predicate)}>`)
    .join(' ');
  const sealResult = await host.store.query(
    `ASK { GRAPH <${uris.metaGraph}> { <${uris.sourceGraph}> ?sealPredicate ?sealValue . VALUES ?sealPredicate { ${sealPredicates} } } }`,
  );
  return sealResult.type === 'boolean' && sealResult.value;
}

/**
 * Phase 4 (eligible fresh drafts only) — the durable write, and nothing else:
 * copy every lifecycle/event row to the backup graph and stamp the `prepared`
 * marker so a restart resumes instead of re-validating a half-migrated draft.
 * Eligibility was already decided by `classifyLegacyWmMigration`.
 */
async function prepareBackup(
  host: LegacyWmMigrationHost,
  uris: MigrationUris,
  lifecycleRows: LifecycleRow[],
  counts: { publicQuads: number; privateQuads: number },
): Promise<void> {
  await host.store.createGraph(uris.backupGraph);
  await host.store.insert([
    ...lifecycleRows.map((row) => ({
      subject: row.s,
      predicate: row.p,
      object: row.o,
      graph: uris.backupGraph,
    })),
    {
      subject: uris.markerSubject,
      predicate: STATE_PRED,
      object: '"prepared"',
      graph: uris.backupGraph,
    },
    {
      subject: uris.markerSubject,
      predicate: COPIED_PUBLIC_PRED,
      object: `"${counts.publicQuads}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      graph: uris.backupGraph,
    },
    {
      subject: uris.markerSubject,
      predicate: PRESERVED_PRIVATE_PRED,
      object: `"${counts.privateQuads}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      graph: uris.backupGraph,
    },
  ]);
}

/**
 * Phase 5 — replace the legacy active metadata with a graph-scoped draft and
 * copy the public triples into the newly resolved WM graph. The legacy source
 * graph itself is deliberately NOT deleted: it is the durable data backup.
 */
async function applyGraphScopedDraft(
  host: LegacyWmMigrationHost,
  request: LegacyWmMigrationRequest,
  uris: MigrationUris,
  lifecycleRows: LifecycleRow[],
  createGraphScopedDraft: boolean,
  publicQuads: Quad[],
): Promise<string> {
  if (createGraphScopedDraft) {
    for (const subject of new Set(lifecycleRows.map((row) => row.s))) {
      await host.store.deleteByPattern({ graph: uris.metaGraph, subject });
    }
    await host.createGraphScopedDraft(
      request.contextGraphId,
      request.name,
      request.agentAddress,
      request.subGraphName,
      { allocateKaNumber: request.allocateKaNumber },
    );
  }

  const targetGraph = await host.wmGraphUri(
    request.contextGraphId,
    request.agentAddress,
    request.name,
    request.subGraphName,
  );
  if (targetGraph === uris.sourceGraph) {
    throw Object.assign(
      new Error(
        `Legacy WM migration requires a graph-scoped identity for ${request.contextGraphId}/${request.name}`,
      ),
      { code: 'KA_LEGACY_WM_MIGRATION_REQUIRES_IDENTITY' },
    );
  }
  if (publicQuads.length > 0) {
    await host.writeGraphScopedDraft(
      request.contextGraphId,
      request.name,
      request.agentAddress,
      publicQuads,
      request.subGraphName,
    );
  }
  return targetGraph;
}

/** Phase 6 — flip the durable marker from `prepared` to `completed`. */
async function completeMarker(
  store: LegacyWmMigrationHost['store'],
  uris: MigrationUris,
  targetGraph: string,
): Promise<void> {
  await store.deleteByPattern({
    graph: uris.backupGraph,
    subject: uris.markerSubject,
    predicate: STATE_PRED,
  });
  await store.insert([
    {
      subject: uris.markerSubject,
      predicate: STATE_PRED,
      object: '"completed"',
      graph: uris.backupGraph,
    },
    {
      subject: uris.markerSubject,
      predicate: TARGET_PRED,
      object: targetGraph,
      graph: uris.backupGraph,
    },
    {
      subject: uris.markerSubject,
      predicate: APPLIED_AT_PRED,
      object: `"${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph: uris.backupGraph,
    },
  ]);
}

/**
 * Run one legacy-WM migration to completion under the caller's lifecycle
 * write lock. See the module doc comment for the phase model.
 */
export async function runLegacyWorkingMemoryMigration(
  host: LegacyWmMigrationHost,
  request: LegacyWmMigrationRequest,
): Promise<LegacyWmMigrationResult> {
  await host.prepareSubGraph(request.contextGraphId, request.subGraphName);

  const uris = migrationUris(request);
  const marker = await loadMigrationMarker(host.store, uris);
  const lifecycleRows = await loadLifecycleRows(host.store, uris, request.name);
  const summary = summarizeLifecycle(lifecycleRows, uris.lifecycle);
  const plan = await classifyLegacyWmMigration(
    {
      markerState: marker.state,
      summary,
      contextGraphId: request.contextGraphId,
      name: request.name,
    },
    () => loadSealFlag(host, uris),
  );

  if (plan.phase === 'not-needed') {
    const migrated = plan.reason === 'already-graph-scoped';
    return {
      status: 'not-needed',
      copiedPublic: migrated ? marker.copiedPublic : 0,
      preservedPrivate: migrated ? marker.preservedPrivate : 0,
      sourceGraph: uris.sourceGraph,
      ...(migrated && marker.targetGraph ? { targetGraph: marker.targetGraph } : {}),
      backupGraph: uris.backupGraph,
    };
  }

  // Load and gate the content BEFORE any mutation: a draft whose legacy
  // content cannot enter the graph-scoped assertion boundary must fail
  // while its active metadata is still untouched.
  const { publicQuads, privateQuads } = await host.loadMigratableContent(
    uris.sourceGraph,
    request,
  );

  // Both remaining phases mutate, so both need a graph-scoped identity lane
  // before anything is written.
  const canAllocateGraphIdentity = request.allocateKaNumber !== undefined
    || host.canSelfAllocateGraphIdentity(request.agentAddress);
  if (!summary.isGraphScoped && !canAllocateGraphIdentity) {
    throw identityAllocatorRequired(request.contextGraphId, request.name);
  }

  if (plan.steps.prepareBackup) {
    await prepareBackup(host, uris, lifecycleRows, {
      publicQuads: publicQuads.length,
      privateQuads: privateQuads.length,
    });
  }

  const targetGraph = await applyGraphScopedDraft(
    host,
    request,
    uris,
    lifecycleRows,
    plan.steps.createGraphScopedDraft,
    publicQuads,
  );
  await completeMarker(host.store, uris, targetGraph);

  host.logInfo(
    `Migrated legacy WM ${request.contextGraphId}/${request.name} from ${uris.sourceGraph} to ${targetGraph} `
    + `(public=${publicQuads.length}, private-preserved=${privateQuads.length}, `
    + `recovery=${plan.phase === 'prepared-resume' ? 'resumed' : 'fresh'})`,
  );

  return {
    status: plan.phase === 'prepared-resume' ? 'resumed' : 'migrated',
    copiedPublic: publicQuads.length,
    preservedPrivate: privateQuads.length,
    sourceGraph: uris.sourceGraph,
    targetGraph,
    backupGraph: uris.backupGraph,
  };
}
