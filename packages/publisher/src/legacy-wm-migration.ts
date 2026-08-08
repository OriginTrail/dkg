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
 *   load marker → load lifecycle → summarize → classify → load content →
 *   VALIDATE content → [per-phase steps] → resolve target → copy → complete
 *
 * `classifyLegacyWmMigration` is the ONLY place a migration is decided: it
 * takes the marker × lifecycle matrix and returns an exhaustive typed
 * `LegacyWmMigrationPlan` — `not-needed` (already graph-scoped, or no legacy
 * draft), `migrate-fresh`, `resume-create`, or `resume-copy` — or throws a
 * coded refusal (`KA_LEGACY_WM_MIGRATION_REFUSED`,
 * `KA_LEGACY_WM_MIGRATION_REQUIRES_IDENTITY`). Every mutating variant means
 * the draft is already known eligible; no later phase re-decides whether it
 * may migrate. One exhaustive `switch` maps each phase to the steps it still
 * owes, so a new phase is a compile error rather than a silent no-op.
 *
 * The content gate is its own phase: `validateMigratableContent` is the only
 * constructor of `ValidatedMigratableContent`, and every mutating step takes
 * that branded type, so un-gated legacy content cannot reach a mutation.
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

/**
 * Identifies exactly one legacy draft's content. Both halves are derived
 * from the same request, so public and private reads cannot diverge.
 */
export interface LegacyWmContentSelector {
  /** The legacy name-keyed public graph the draft's triples live in. */
  sourceGraph: string;
  contextGraphId: string;
  agentAddress: string;
  name: string;
  subGraphName: string | undefined;
}

/** Legacy content as read, before the migration content gate has run. */
export interface RawMigratableContent {
  publicQuads: Quad[];
  privateQuads: Quad[];
}

declare const validatedContentBrand: unique symbol;

/**
 * Legacy content PROVEN to have passed the content gate.
 *
 * `validateMigratableContent` is the only way to obtain one, so a mutating
 * phase cannot be handed un-gated content: the pre-mutation invariant is
 * carried by the type, not by a comment or a method name. Restoring the gate
 * as its own phase (rather than folding it into the loader) is what makes it
 * visible in the orchestration.
 */
type ValidatedMigratableContent = RawMigratableContent & {
  readonly [validatedContentBrand]: true;
};

/**
 * The content gate, as an explicit migration phase. Runs the host's rejection
 * rules and brands the result; throwing leaves the draft untouched because
 * this happens before any mutation.
 */
function validateMigratableContent(
  host: Pick<LegacyWmMigrationHost, 'assertContentMigratable'>,
  raw: RawMigratableContent,
): ValidatedMigratableContent {
  host.assertContentMigratable(raw.publicQuads, raw.privateQuads);
  return raw as ValidatedMigratableContent;
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
   * Read the legacy draft's public + private content. A plain read — the
   * content gate is a separate, explicit phase (`validateMigratableContent`)
   * owned by this module, so the invariant is enforced by the type system
   * rather than by a host implementation's good behavior.
   *
   * Takes only the identity of the draft to read — not the whole request —
   * so a host cannot load public quads for one draft and private quads for
   * another.
   */
  loadMigratableContent(selector: LegacyWmContentSelector): Promise<RawMigratableContent>;
  /**
   * The content gate: throws unless this legacy content may enter the
   * graph-scoped assertion boundary. Never called directly by the
   * orchestration — see `validateMigratableContent`.
   */
  assertContentMigratable(publicQuads: Quad[], privateQuads: Quad[]): void;
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
 * The typed migration transitions. Refusals throw, so every value here is a
 * run that may proceed, and the variant NAMES the earliest mutating step
 * still owed — the apply phase executes the variant rather than re-deriving
 * progress from ambient state.
 *
 * Transitions, not flags: an invalid combination (a fresh migration that
 * skips both preparation and draft creation, say) is not representable.
 *
 * The durable marker vocabulary stays `prepared`/`completed` and is
 * deliberately NOT widened — markers written by already-shipped nodes must
 * keep classifying. The two resume variants are therefore derived from the
 * observed lifecycle shape, which is sound because every step is idempotent.
 *
 * - `migrate-fresh`   — back up, mint the graph-scoped draft, copy, complete.
 * - `resume-create`   — prepared, draft not yet minted: mint, copy, complete.
 * - `resume-copy`     — prepared, draft already minted: copy, complete.
 */
export type LegacyWmMigrationPlan =
  | { phase: 'not-needed'; reason: 'already-graph-scoped' | 'no-legacy-draft' }
  | { phase: 'migrate-fresh' }
  | { phase: 'resume-create' }
  | { phase: 'resume-copy' };

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
 * in, an exhaustive plan out, refusals thrown. Every mutating variant means
 * the draft is already known eligible — nothing downstream re-decides
 * whether a draft may migrate.
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
    return summary.isGraphScoped
      ? { phase: 'resume-copy' }
      : { phase: 'resume-create' };
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
  // Reaching here means not graph-scoped: step 1 already returned for an
  // already-graph-scoped draft under a non-`prepared` marker.
  return { phase: 'migrate-fresh' };
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
 * Step — replace the legacy active metadata with a freshly minted
 * graph-scoped draft. The legacy source GRAPH is deliberately NOT deleted:
 * it is the durable data backup.
 */
async function createGraphScopedDraft(
  host: LegacyWmMigrationHost,
  request: LegacyWmMigrationRequest,
  uris: MigrationUris,
  lifecycleRows: LifecycleRow[],
): Promise<void> {
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

/** Step — resolve the graph-scoped WM graph, asserting it is not the legacy one. */
async function resolveTargetGraph(
  host: LegacyWmMigrationHost,
  request: LegacyWmMigrationRequest,
  uris: MigrationUris,
): Promise<string> {
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
  return targetGraph;
}

/** Step — copy the validated legacy public triples into the graph-scoped draft. */
async function copyPublicContent(
  host: LegacyWmMigrationHost,
  request: LegacyWmMigrationRequest,
  content: ValidatedMigratableContent,
): Promise<void> {
  if (content.publicQuads.length === 0) return;
  await host.writeGraphScopedDraft(
    request.contextGraphId,
    request.name,
    request.agentAddress,
    content.publicQuads,
    request.subGraphName,
  );
}

/** Compile-time proof that every plan phase is handled. */
function assertNeverPhase(plan: never): never {
  throw new Error(`Unhandled legacy WM migration phase: ${JSON.stringify(plan)}`);
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
    // Orphan `…/event/{id}` rows with no active lifecycle subject mean the
    // draft's metadata was lost mid-sweep. Migration cannot proceed — there
    // is no state/layer to prove eligibility against, and migrating an
    // unprovable draft is exactly what the gate exists to stop — but any
    // content still in the legacy graph would then be invisible to reads of
    // the graph-scoped draft that `createAssertion` goes on to mint. The
    // data is retained (the source graph is never deleted), so surface it
    // rather than abandoning it silently. Probed ONLY in this anomalous
    // case, so the healthy no-draft path costs no extra query.
    if (plan.reason === 'no-legacy-draft' && lifecycleRows.length > 0) {
      const stranded = await host.store.query(
        `ASK { GRAPH <${uris.sourceGraph}> { ?s ?p ?o } }`,
      );
      if (stranded.type === 'boolean' && stranded.value) {
        host.logInfo(
          `Legacy WM ${request.contextGraphId}/${request.name}: active lifecycle metadata is `
          + `missing but ${uris.sourceGraph} still holds content. Migration cannot verify `
          + `eligibility without it, so the draft is left in place and NOT migrated; the data `
          + `is retained in that graph for manual recovery.`,
        );
      }
    }
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

  // Read, then GATE the content — both before any mutation, so a draft whose
  // legacy content cannot enter the graph-scoped assertion boundary fails
  // while its active metadata is still untouched. Only the branded result is
  // accepted downstream, so no mutating step can receive un-gated content.
  const content = validateMigratableContent(
    host,
    await host.loadMigratableContent({
      sourceGraph: uris.sourceGraph,
      contextGraphId: request.contextGraphId,
      agentAddress: request.agentAddress,
      name: request.name,
      subGraphName: request.subGraphName,
    }),
  );

  // Identity requirement reads off the PLAN, not off `summary`: only
  // `resume-copy` finds the draft already minted, so it is the one phase that
  // needs no allocator. (Equivalent to the old `!summary.isGraphScoped` test —
  // `migrate-fresh` cannot be graph-scoped, since step 1 returns `not-needed`
  // for that — but derived from the transition model rather than beside it.)
  if (plan.phase !== 'resume-copy') {
    const canAllocateGraphIdentity = request.allocateKaNumber !== undefined
      || host.canSelfAllocateGraphIdentity(request.agentAddress);
    if (!canAllocateGraphIdentity) {
      throw identityAllocatorRequired(request.contextGraphId, request.name);
    }
  }

  // One exhaustive dispatch over the transition: each phase performs the
  // steps it still owes and names its result status. Adding a phase without
  // handling it here is a compile error, so the mapping cannot drift.
  let status: 'migrated' | 'resumed';
  switch (plan.phase) {
    case 'migrate-fresh':
      await prepareBackup(host, uris, lifecycleRows, {
        publicQuads: content.publicQuads.length,
        privateQuads: content.privateQuads.length,
      });
      await createGraphScopedDraft(host, request, uris, lifecycleRows);
      status = 'migrated';
      break;
    case 'resume-create':
      await createGraphScopedDraft(host, request, uris, lifecycleRows);
      status = 'resumed';
      break;
    case 'resume-copy':
      status = 'resumed';
      break;
    default:
      assertNeverPhase(plan);
  }

  const targetGraph = await resolveTargetGraph(host, request, uris);
  await copyPublicContent(host, request, content);
  await completeMarker(host.store, uris, targetGraph);

  host.logInfo(
    `Migrated legacy WM ${request.contextGraphId}/${request.name} from ${uris.sourceGraph} to ${targetGraph} `
    + `(public=${content.publicQuads.length}, `
    + `private-preserved=${content.privateQuads.length}, phase=${plan.phase})`,
  );

  return {
    status,
    copiedPublic: content.publicQuads.length,
    preservedPrivate: content.privateQuads.length,
    sourceGraph: uris.sourceGraph,
    targetGraph,
    backupGraph: uris.backupGraph,
  };
}
