import { randomUUID } from 'node:crypto';
import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  findTripleStoreCapability,
} from './triple-store.js';
import type {
  Quad,
  QueryOptions,
  QueryResult,
  TripleStore,
  UpdateOptions,
  StorePressureSnapshot,
  TripleStoreDecorator,
} from './triple-store.js';
import {
  UnsupportedTripleStoreCapabilityError,
} from './unsupported-capability-error.js';
import {
  isAtomicGraphReplaceStagingGraph,
} from './atomic-graph-replace.js';
import type {
  Rfc64AuthorCommitCasInputV1,
  Rfc64AuthorCommitCasResultV1,
} from './rfc64-author-commit-cas.js';
import {
  normalizeRfc64AuthorCommitCasV1,
  sourceFromNormalizedRfc64AuthorCommitCasV1,
} from './rfc64-author-commit-cas.js';
import { isStoreOperationNotStarted, type StoreOperation } from './store-operation-outcome.js';

/**
 * ChangelogStore — an append-only per-node change log maintained on the write
 * path, the write-side half of OT-RFC-59 (O(delta) sync convergence).
 *
 * ## What it is
 *
 * A `TripleStore` decorator that, for every mutation flowing through it, appends
 * a small **change marker** into a reserved named graph ({@link CHANGELOG_GRAPH})
 * recording *(seq, graph, op)* — "at sequence N, this named graph was
 * upserted / dropped". A sync responder can then answer *"what changed since
 * seq N?"* by reading the log ({@link ChangelogStore.readChanges}) instead of
 * enumerating and diffing the whole store (the O(store) scan that OOM-killed
 * beacons on 2026-07-10). The marker lives **inside the RDF store's own commit
 * domain**, so it travels with RocksDB backups, is wiped by `DROP ALL`, and is
 * rebuildable — this is OT-RFC-59 **Option A** (store authoritative, log
 * derived), not event-sourcing (Option B).
 *
 * ## Crash-consistency (the invariant that matters)
 *
 * OT-RFC-59 §6 / G3: *every committed store change is discoverable through the
 * log*. The strength of that guarantee differs by path:
 *
 * - **`insert()` — atomic, no window.** The upsert marker is appended to the
 *   very same `insert(quads)` call as the data (`inner.insert([...quads,
 *   ...markers])`). A single `insert()` is one backend transaction on every
 *   adapter — one Oxigraph in-memory apply flushed as a whole snapshot, one
 *   Blazegraph N-Quads POST, one `sparql-http` INSERT DATA — so data and marker
 *   commit or abort together. There is genuinely no window where the data is
 *   durable but the marker is lost.
 *
 * - **`delete()`/`dropGraph()`/`deleteByPattern()`/`deleteBySubjectPrefix()`/
 *   `update()` — post-mutation marker, benign lost-marker window.** These write
 *   the marker in a SECOND step after the mutation (`op` derived from a
 *   `hasGraph` probe), so a crash/store-error between the mutation commit and
 *   the marker append leaves the data durable with no marker. That is acceptable
 *   because it is **store-authoritative and reconcile-healable**: a later catalog
 *   reconcile (PR2) re-derives the missing marker from the store. To bound the
 *   window we also set {@link needsReconcile} whenever the post-mutation marker
 *   write itself throws (see {@link markPostMutation}), so the daemon has an
 *   in-process signal even before PR2 reconcile runs (see {@link appendMarkers}).
 *
 *   Note the op is not always `drop`: `update()`/`deleteByPattern` with a
 *   `touchedGraphs` hint into a graph that still has data emits an **`upsert`**
 *   marker post-mutation. A *lost* such marker is the one non-benign shape a
 *   naive set-based (listGraphs-vs-log) reconcile cannot catch — the graph is
 *   present in both store and log, so a set diff sees no discrepancy while a
 *   syncing peer keeps an under-complete copy. **PR2 constraint:** the reconcile
 *   pass must be content-aware for graphs touched by opaque/`update()` writes
 *   (or such upserts must be fused on the `insert()` path), not merely
 *   set-difference. Today this is latent: the only `update()`-INSERT caller
 *   (RS-heal) targets brand-new scoped graphs, which a set reconcile does catch.
 *
 * ## Single-writer sequence allocation (the load-bearing constraint)
 *
 * `seq` is a per-node monotonic counter. For a cursor to be gap-safe the log's
 * **commit order must equal its seq order** — otherwise a requester that reads
 * seq 11 (committed first) before seq 10 (allocated first, committed later)
 * advances its cursor past 10 and never sees it. A shared read-modify-write
 * counter does NOT prevent this reordering; only a single writer that allocates
 * and commits *in one serialized step* does. This decorator enforces that with
 * an in-process write mutex ({@link runExclusive}) and an in-memory counter
 * seeded from `MAX(seq)` on first use — so within one process commit order is
 * seq order by construction, and a crash simply loses the in-memory tail (the
 * counter reseeds from the last durable marker on restart).
 *
 * **Scope boundary (PR1):** this guarantee holds for a *single writer process*.
 * The second-process publisher CLI (`publisher-runner.ts`, its own
 * `createTripleStore`) is a second writer and is therefore NOT yet covered —
 * it must funnel writes through the daemon (single-writer invariant) or use
 * per-writer subsequences before the changelog can be enabled fleet-wide. Until
 * then callers wrap only the daemon's store and leave the flag default-off.
 * See OT-RFC-59 §5.3.
 */

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/** Reserved named graph holding the append-only change markers. */
export const CHANGELOG_GRAPH = 'urn:dkg:changelog';
const NS = 'urn:dkg:changelog#';
const P_SEQ = `${NS}seq`;
const P_GRAPH = `${NS}graph`;
const P_OP = `${NS}op`;
const P_SCHEMA_VERSION = `${NS}schemaVersion`;
const P_ERA = `${NS}era`;
const ENTRY_PREFIX = 'urn:dkg:changelog:e:';
const META_SUBJECT = `${NS}self`;

/** On-disk marker schema version, so a future shape change is detectable. */
export const CHANGELOG_SCHEMA_VERSION = 1;

export type ChangeOp = 'upsert' | 'drop';

export interface ChangeRecord {
  /** Per-node monotonic sequence. Strictly increasing in commit order. */
  seq: number;
  /** The named graph that changed. */
  graph: string;
  /** `upsert` = graph created or its content changed; `drop` = graph gone/emptied. */
  op: ChangeOp;
}

/** Durable head cursor a responder returns so a requester can advance safely. */
export interface ChangelogHead {
  /**
   * Log generation id (a UUID). Immutable while the log lives; a wipe/reseed
   * mints a fresh one. A requester whose cursor `era` differs MUST full-resync
   * rather than trust `seq` (the guard against cursor poisoning after a
   * restore/reseed/chain-reset rolls `seq` back — OT-RFC-59 §6).
   */
  era: string;
  /** Highest seq durably present in the log (0 if empty). */
  seq: number;
}

/**
 * The changelog READ capability the sync responder (PR2) consumes. Exposed as an
 * explicit interface + {@link asChangelogReader} type guard so a consumer of a
 * `createTripleStore(...)` result can recover it without a cast or knowledge of
 * decorator order — the changelog is otherwise invisible behind the `TripleStore`
 * factory return type.
 */
export interface ChangelogReader {
  /**
   * Live head cursor `(era, seq)` — era mismatch or `seq` rollback ⇒ full resync.
   * `signal` is honored at the method boundary. `source` and `priority` are not
   * forwarded because steady-state reads are served from memory; use
   * {@link headSeq} for an explicitly durable storage read with query metadata.
   */
  changelogHead(options?: QueryOptions): Promise<ChangelogHead>;
  /** Change records with `seq > sinceSeq`, ascending, at most `limit`. */
  readChanges(sinceSeq: number, limit: number, options?: QueryOptions): Promise<ChangeRecord[]>;
  /** Highest seq durably present in the log (0 if empty). */
  headSeq(options?: QueryOptions): Promise<number>;
  /** True when an opaque mutation left the log incomplete (reconcile owed). */
  readonly needsReconcile: boolean;
  /** Cleared by the reconcile pass (PR2) once it has emitted synthetic markers. */
  clearReconcileFlag(): void;
}

/**
 * Durable, OUT-OF-STORE high-water record used to detect a backup/restore that
 * rolls `seq` back **under the same era** — the one case the in-store era +
 * responder `head.seq < sinceSeq` guards cannot catch (a file restore replaces
 * the whole store atomically, so nothing inside it can tell it was rolled back;
 * and once the restored node re-advances past a peer's cursor, `head.seq <
 * sinceSeq` no longer fires while the seqs now mean different changes — a silent
 * skip). The guard MUST persist somewhere the RDF-store restore does not roll
 * back with it (e.g. `node-ui.db`, which survives a `store.nq` restore and works
 * for external backends too). See OT-RFC-59 §6.
 */
export interface ChangelogEraGuard {
  /** The last persisted `(era, highSeq)`; null if never written. */
  load(): Promise<{ era: string; highSeq: number } | null>;
  /** Persist the current high-water. Called at seed and after each committed seq. */
  save(era: string, highSeq: number): Promise<void>;
}

export interface ChangelogStoreOptions {
  enabled?: boolean;
  /**
   * Extra reserved graphs (besides {@link CHANGELOG_GRAPH}) to hide from
   * `listGraphs()` and never emit markers for — e.g. a future in-store catalog
   * graph. The changelog graph is always reserved.
   */
  reservedGraphs?: readonly string[];
  /** Observability hook fired after each marker is durably appended. */
  onAppend?: (record: ChangeRecord) => void;
  /**
   * Optional restore-detection guard. When provided, a seq rollback under the
   * same era rotates the era on seed (forcing peers to full-resync instead of
   * silently skipping). When absent, no restore detection runs — the historical
   * behavior — which is why enabling the changelog fleet-wide REQUIRES a durable
   * guard (OT-RFC-59 §6 P0).
   */
  eraGuard?: ChangelogEraGuard;
}

/**
 * Write-path append-only change log. See the class-level docstring for the
 * crash-consistency and single-writer arguments.
 */
export class ChangelogStore implements TripleStoreDecorator, ChangelogReader {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  private readonly inner: TripleStore;
  readonly innerStore: TripleStore;
  private readonly enabled: boolean;
  private readonly reserved: ReadonlySet<string>;
  private readonly onAppend?: (record: ChangeRecord) => void;
  private readonly eraGuard?: ChangelogEraGuard;

  /** Last durably committed seq (0 = none). Next seq is `seq + 1`. */
  private seq = 0;
  /** Log generation id, established (read or minted) on seed. Null until then. */
  private eraValue: string | null = null;
  private seedPromise: Promise<void> | null = null;
  /** Serializes mutations so commit order === seq order (single writer). */
  private tail: Promise<unknown> = Promise.resolve();
  /** Set by close(): the write gate is shut so no new mutation may enqueue. */
  private closing = false;
  /**
   * Set when a mutation could not be attributed to specific graphs (an opaque
   * `update()`/`query()` UPDATE with no `touchedGraphs` hint). Its changed
   * graphs are missing from the log until a catalog reconcile (PR2) emits
   * synthetic markers. Exposed via {@link needsReconcile} so the daemon can act.
   */
  private reconcilePending = false;

  constructor(inner: TripleStore, options: ChangelogStoreOptions = {}) {
    this.inner = inner;
    this.innerStore = inner;
    this.enabled = options.enabled !== false;
    const reserved = new Set<string>([CHANGELOG_GRAPH]);
    for (const g of options.reservedGraphs ?? []) reserved.add(g);
    this.reserved = reserved;
    this.onAppend = options.onAppend;
    this.eraGuard = options.eraGuard;
  }

  // ------------------------------------------------------------------
  // Mutations (marker-emitting)
  // ------------------------------------------------------------------

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.insert(quads, options);
    // The reserved plane is not writable through the public API: strip any
    // caller-supplied quads targeting it so a forged marker (e.g. a fake seq to
    // jump the high-water mark) can never reach the inner store. Only the
    // decorator's own internal writes (below, via this.inner) touch it.
    const safe = this.stripReserved(quads);
    const touched = this.attributableGraphs(safe);
    if (touched.length === 0) {
      // Nothing the log cares about (default graph only).
      return this.inner.insert(safe, options);
    }
    await this.runExclusive(async () => {
      await this.ensureSeeded();
      let candidate = this.seq;
      const markers: Quad[] = [];
      const records: ChangeRecord[] = [];
      for (const graph of touched) {
        candidate += 1;
        records.push({ seq: candidate, graph, op: 'upsert' });
        markers.push(...markerQuads(candidate, graph, 'upsert'));
      }
      // Data + markers in ONE insert() → one backend transaction → atomic.
      await this.inner.insert([...safe, ...markers], options);
      this.seq = candidate; // advance only after durable success (gapless)
      await this.noteHighWater();
      this.fire(records);
    });
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.delete(quads, options);
    // Strip reserved-graph quads: callers cannot delete markers out of the log.
    const safe = this.stripReserved(quads);
    const touched = this.attributableGraphs(safe);
    await this.runExclusive(async () => {
      await this.inner.delete(safe, options);
      await this.markPostMutation(touched, options);
    });
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    if (!this.enabled) return this.inner.deleteByPattern(pattern, options);
    if (pattern.graph) {
      // A graph-scoped delete against the reserved plane would erase the log.
      this.assertNotReserved(pattern.graph, 'deleteByPattern');
    } else {
      // A no-graph delete by a reserved-namespaced subject/predicate would delete
      // markers cross-graph — the same log-erasure vector, so reject it too.
      this.assertNoReservedTerm(pattern);
    }
    return this.runExclusive(async () => {
      const removed = await this.inner.deleteByPattern(pattern, options);
      if (removed > 0) {
        if (pattern.graph) {
          await this.markPostMutation([pattern.graph], options);
        } else {
          // No graph hint → cannot attribute which graphs shrank/emptied.
          this.flagReconcile('deleteByPattern(no-graph)');
        }
      }
      return removed;
    });
  }

  async deleteByPatternWithoutCount(
    pattern: Partial<Quad>,
    options?: QueryOptions,
  ): Promise<void> {
    if (!this.enabled) {
      await deleteByPatternWithoutCount(this.inner, pattern, options);
      return;
    }
    if (pattern.graph) {
      this.assertNotReserved(pattern.graph, 'deleteByPatternWithoutCount');
    } else {
      this.assertNoReservedTerm(pattern);
    }
    await this.runExclusive(async () => {
      await deleteByPatternWithoutCount(this.inner, pattern, options);
      if (pattern.graph) {
        // No count is available to distinguish a no-op. Emitting a
        // conservative post-mutation marker matches delete(quads) semantics
        // and keeps every committed change discoverable.
        await this.markPostMutation([pattern.graph], options);
      } else {
        this.flagReconcile('deleteByPatternWithoutCount(no-graph)');
      }
    });
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    if (!this.enabled) return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
    this.assertNotReserved(graphUri, 'deleteBySubjectPrefix');
    return this.runExclusive(async () => {
      const removed = await this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
      if (removed > 0) {
        await this.markPostMutation([graphUri], options);
      }
      return removed;
    });
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.dropGraph(graphUri, options);
    // Dropping the reserved plane through the public API would delete the log
    // with no trace; only internal maintenance (chain-reset, which bypasses this
    // decorator) may wipe it.
    this.assertNotReserved(graphUri, 'dropGraph');
    await this.runExclusive(async () => {
      await this.inner.dropGraph(graphUri, options);
      await this.appendMarkers([{ graph: graphUri, op: 'drop' }], options);
    });
  }

  async replaceGraph(
    graphUri: string,
    quads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceGraph !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('replaceGraph', 'ChangelogStore');
    }
    if (!this.enabled) return this.inner.replaceGraph(graphUri, quads, options);
    this.assertNotReserved(graphUri, 'replaceGraph');
    await this.runAtomicMutation({
      operation: 'replaceGraph',
      touchedGraphs: [graphUri],
      options,
      execute: () => this.inner.replaceGraph!(graphUri, quads, options),
    });
  }

  async replaceGraphAndSubject(
    graphUri: string,
    graphQuads: Quad[],
    metaGraphUri: string,
    metadataSubject: string,
    metadataQuads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceGraphAndSubject !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError(
        'replaceGraphAndSubject',
        'ChangelogStore',
      );
    }
    if (!this.enabled) {
      return this.inner.replaceGraphAndSubject(
        graphUri,
        graphQuads,
        metaGraphUri,
        metadataSubject,
        metadataQuads,
        options,
      );
    }
    this.assertNotReserved(graphUri, 'replaceGraphAndSubject');
    this.assertNotReserved(metaGraphUri, 'replaceGraphAndSubject');
    await this.runAtomicMutation({
      operation: 'replaceGraphAndSubject',
      touchedGraphs: [graphUri, metaGraphUri],
      options,
      execute: () => this.inner.replaceGraphAndSubject!(
        graphUri,
        graphQuads,
        metaGraphUri,
        metadataSubject,
        metadataQuads,
        options,
      ),
    });
  }

  async replaceSubject(
    graphUri: string,
    subject: string,
    quads: Quad[],
    options?: QueryOptions,
  ): Promise<void> {
    if (typeof this.inner.replaceSubject !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'ChangelogStore');
    }
    if (!this.enabled) return this.inner.replaceSubject(graphUri, subject, quads, options);
    // Structural guard on the TARGET graph only — NOT a scan of the serialized
    // update string. Every quad targets `graphUri` (the atomic builder enforces
    // it), so a job term that merely REFERENCES a reserved IRI as a subject/
    // predicate/object is accepted, matching the insert() path (#1863 regression
    // the raw-update path reintroduced via assertNoReservedRef).
    this.assertNotReserved(graphUri, 'replaceSubject');
    await this.runAtomicMutation({
      operation: 'replaceSubject',
      touchedGraphs: [graphUri],
      options,
      execute: () => this.inner.replaceSubject!(graphUri, subject, quads, options),
    });
  }

  async rfc64AuthorCommitCasV1(
    input: Rfc64AuthorCommitCasInputV1,
    options?: QueryOptions,
  ): Promise<Rfc64AuthorCommitCasResultV1> {
    if (typeof this.inner.rfc64AuthorCommitCasV1 !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError(
        'rfc64AuthorCommitCasV1',
        'ChangelogStore',
      );
    }
    const manifest = normalizeRfc64AuthorCommitCasV1(input);
    const source = sourceFromNormalizedRfc64AuthorCommitCasV1(manifest);
    if (!this.enabled) return this.inner.rfc64AuthorCommitCasV1(source, options);
    for (const graph of manifest.referencedGraphs) {
      this.assertNotReserved(graph, 'rfc64AuthorCommitCasV1');
    }
    return this.runAtomicMutation({
      operation: 'rfc64AuthorCommitCasV1',
      touchedGraphs: manifest.touchedGraphs,
      options,
      execute: () => this.inner.rfc64AuthorCommitCasV1!(source, options),
      committed: result => result === 'committed',
    });
  }

  async createGraph(graphUri: string): Promise<void> {
    // Empty graphs are not listed by this repo's `listGraphs` semantics and
    // carry no data to converge, so no marker until the first insert. Matches
    // GraphSetIndexStore.
    await this.inner.createGraph(graphUri);
  }

  async update(sparql: string, options?: UpdateOptions): Promise<void> {
    if (typeof this.inner.update !== 'function') {
      throw new UnsupportedTripleStoreCapabilityError('update', 'ChangelogStore');
    }
    if (!this.enabled) return this.inner.update(sparql, options);
    // Reject BEFORE the mutation runs so it never touches the reserved plane.
    this.assertNoReservedRef(sparql, 'update');
    await this.runExclusive(async () => {
      await this.inner.update!(sparql, options);
      const hinted = (options?.touchedGraphs ?? []).filter((g) => !this.isReservedGraph(g));
      if (hinted.length > 0) {
        // Strip the update-only touchedGraphs hint before the read-path hasGraph
        // probes — it is meaningless there and must not leak past this boundary.
        await this.markPostMutation(hinted, queryOptionsFromUpdateOptions(options));
      } else {
        // Opaque server-side UPDATE (e.g. an RS heal INSERT…WHERE with no hint).
        this.flagReconcile('update(no-touchedGraphs)');
      }
    });
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    // A SPARQL UPDATE smuggled through query() is opaque to us — flag for
    // reconcile rather than silently dropping its changes from the log; and if it
    // targets the reserved plane, reject it before it executes.
    const isUpdate = this.enabled && isSparqlUpdateOperation(sparql);
    if (isUpdate) this.assertNoReservedRef(sparql, 'query()-UPDATE');
    const result = await this.inner.query(sparql, options);
    if (isUpdate) this.flagReconcile('query(update)');
    return result;
  }

  // ------------------------------------------------------------------
  // Reads (reserved-graph aware)
  // ------------------------------------------------------------------

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (this.isReservedGraph(graphUri)) return false; // reserved plane is invisible upward
    return this.inner.hasGraph(graphUri, options);
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    const graphs = await this.inner.listGraphs(options);
    return graphs.filter((g) => !this.isReservedGraph(g));
  }

  async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
    const graphs = this.inner.listGraphsByPrefix
      ? await this.inner.listGraphsByPrefix(prefix, options)
      : (await this.inner.listGraphs(options)).filter((g) => g.startsWith(prefix));
    return graphs.filter((g) => !this.isReservedGraph(g));
  }

  async countQuads(graphUri?: string, options?: QueryOptions): Promise<number> {
    // Deliberate passthrough: unlike listGraphs()/hasGraph(), counting is NOT
    // masked, so countQuads() (no arg) and query() include marker quads. The
    // reserved-plane-invisible contract covers enumeration only. No current
    // caller counts for accounting that must exclude the reserved plane; the
    // total-triples telemetry (metrics-queries.ts) will drift by the marker
    // count when enabled — exclude urn:dkg:changelog there alongside the PR2
    // enable-path wiring.
    return this.inner.countQuads(graphUri, options);
  }

  // ------------------------------------------------------------------
  // Changelog read API (consumed by the sync responder — PR2)
  // ------------------------------------------------------------------

  /**
   * Live head cursor `(era, seq)` the sync responder returns so a requester
   * can advance its cursor and detect a wipe/reseed (era change) or a rollback
   * (`seq` < the requester's cursor). Establishes the durable starting state on
   * first call, then serves the serialized writer's authoritative head from memory.
   *
   * QueryOptions boundary: cancellation is checked before and after the shared
   * one-time seed. `source` and `priority` are intentionally not forwarded: the
   * seed uses internal source tags and steady-state calls perform no storage read.
   * Call {@link headSeq} when a caller needs a durable read carrying those options.
   */
  async changelogHead(options?: QueryOptions): Promise<ChangelogHead> {
    const signal = options?.signal;
    throwIfAborted(signal);
    await this.ensureSeeded();
    throwIfAborted(signal);
    // All changelog writes pass through the serialized single-writer path and
    // advance `seq` only after their marker transaction commits. Once seeded,
    // this is therefore the authoritative live head; repeating MAX(?seq) for
    // every sync request only adds an expensive store read under contention.
    // Keep headSeq() below as the explicit durable diagnostic/restart primitive.
    return { era: this.eraValue as string, seq: this.seq };
  }

  /** Highest seq durably present in the log (0 if empty); always queries storage. */
  async headSeq(options?: QueryOptions): Promise<number> {
    const res = await this.inner.query(
      `SELECT (MAX(?seq) AS ?m) WHERE { GRAPH <${CHANGELOG_GRAPH}> { ?e <${P_SEQ}> ?seq } }`,
      { ...options, source: options?.source ?? 'changelog.headSeq' },
    );
    if (res.type !== 'bindings' || res.bindings.length === 0) return 0;
    return parseIntTerm(res.bindings[0].m) ?? 0;
  }

  /**
   * Change records with `seq > sinceSeq`, in ascending seq order, at most
   * `limit`. This is the O(delta) read the whole RFC exists to enable. In PR1
   * it is a range query over the (small) reserved changelog graph; PR2 serves
   * it from an ordered SQLite projection for O(log L + delta).
   */
  async readChanges(sinceSeq: number, limit: number, options?: QueryOptions): Promise<ChangeRecord[]> {
    const since = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0;
    const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    const res = await this.inner.query(
      `SELECT ?seq ?graph ?op WHERE {
  GRAPH <${CHANGELOG_GRAPH}> {
    ?e <${P_SEQ}> ?seq ; <${P_GRAPH}> ?graph ; <${P_OP}> ?op .
    FILTER(?seq > ${since})
  }
} ORDER BY ?seq LIMIT ${cap}`,
      { ...options, source: options?.source ?? 'changelog.readChanges' },
    );
    if (res.type !== 'bindings') return [];
    const out: ChangeRecord[] = [];
    for (const b of res.bindings) {
      const seq = parseIntTerm(b.seq);
      const graph = stripIri(b.graph);
      const op = stripLiteral(b.op);
      if (seq == null || !graph || (op !== 'upsert' && op !== 'drop')) continue;
      out.push({ seq, graph, op });
    }
    return out;
  }

  /** True when an opaque mutation left the log incomplete (reconcile owed). */
  get needsReconcile(): boolean {
    return this.reconcilePending;
  }

  /** Cleared by the reconcile pass (PR2) once it has emitted synthetic markers. */
  clearReconcileFlag(): void {
    this.reconcilePending = false;
  }

  // ------------------------------------------------------------------
  // Lifecycle / passthrough
  // ------------------------------------------------------------------

  getPressureSnapshot(): StorePressureSnapshot | undefined {
    return this.inner.getPressureSnapshot?.();
  }

  async flush(options?: QueryOptions): Promise<void> {
    // Drain queued mutations (data + their markers) before flushing the inner
    // store, so a durability flush cannot return while a write is still queued.
    // Does NOT close the write gate — flush() is called periodically, not only
    // at shutdown.
    await this.drain();
    await this.inner.flush?.(options);
  }

  async close(): Promise<void> {
    // Shut the gate first (reject new mutations), then drain the queue so a
    // just-enqueued insert's data AND marker are durable before we close the
    // inner store — otherwise close() could resolve with a write still pending.
    this.closing = true;
    await this.drain();
    await this.inner.close();
  }

  /** Await the current mutation-queue tail (all writes enqueued so far settle). */
  private drain(): Promise<void> {
    return this.tail.then(() => undefined, () => undefined);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Serialize a mutation so no two writes interleave their seq allocation. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Once close() has shut the gate, refuse new mutations rather than racing
    // the inner store's close — anything already queued still drains.
    if (this.closing) {
      return Promise.reject(new Error('ChangelogStore: store is closing; write rejected'));
    }
    const run = this.tail.then(() => fn(), () => fn());
    // Keep the chain alive regardless of this op's outcome.
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Shared outcome-aware lifecycle for every certified atomic mutation. */
  private runAtomicMutation<T>(args: {
    operation: StoreOperation;
    touchedGraphs: readonly string[];
    options?: QueryOptions;
    execute: () => Promise<T>;
    committed?: (result: T) => boolean;
  }): Promise<T> {
    return this.runExclusive(async () => {
      let result: T;
      try {
        result = await args.execute();
      } catch (error) {
        if (!isStoreOperationNotStarted(error, args.operation)) {
          this.flagReconcile(`${args.operation}(indeterminate-failure)`);
        }
        throw error;
      }
      if ((args.committed?.(result) ?? true)) {
        await this.markPostMutation(args.touchedGraphs, args.options);
      }
      return result;
    });
  }

  /**
   * Seed the in-memory seq counter AND the era from the durable log, once.
   *
   * If the log has no era yet — a brand-new log, or a pre-era PR1 log first read
   * by a PR2 node — mint and persist one. Writes reach here under the write mutex
   * ({@link runExclusive}); reads (the responder's {@link changelogHead}) share
   * the memoized `seedPromise`, and a concurrent write awaits the same promise
   * before allocating, so the mint write runs at most once with no writer racing
   * it.
   */
  private ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = this.seedOnce()
        .catch((err) => {
          // Reset so a transient store error retries seeding on the next call
          // rather than latching seq=0 (which would collide with existing seqs).
          this.seedPromise = null;
          throw err;
        });
    }
    return this.seedPromise;
  }

  /** Read the durable head (seq + era), minting+persisting an era if absent. */
  private async seedOnce(): Promise<void> {
    const seq = await this.headSeq({ source: 'changelog.seed' });
    this.seq = seq;
    const res = await this.inner.query(
      `SELECT ?era WHERE { GRAPH <${CHANGELOG_GRAPH}> { <${META_SUBJECT}> <${P_ERA}> ?era } } LIMIT 1`,
      { source: 'changelog.seed.era' },
    );
    const era = res.type === 'bindings' && res.bindings.length > 0
      ? stripLiteral(res.bindings[0].era)
      : '';
    if (era) {
      this.eraValue = era;
    } else {
      const minted = randomUUID();
      await this.writeEra(minted);
      this.eraValue = minted;
    }
    await this.applyEraGuard();
  }

  /**
   * Restore-detection (OT-RFC-59 §6). With a durable {@link ChangelogEraGuard},
   * a seq that has rolled BACK under the same era means the store was restored
   * from an older backup: rotate the era so peers detect it and full-resync
   * rather than silently skipping the changes above the restored point. Otherwise
   * advance the durable high-water. No-op without a guard (default-off posture).
   */
  private async applyEraGuard(): Promise<void> {
    if (!this.eraGuard) return;
    const prior = await this.eraGuard.load();
    if (prior && prior.era === this.eraValue && this.seq < prior.highSeq) {
      // Rollback under the same era → rotate.
      const rotated = randomUUID();
      await this.writeEra(rotated);
      this.eraValue = rotated;
      await this.eraGuard.save(rotated, this.seq);
      return;
    }
    // Normal boot / wipe (new era) / forward progress: persist the high-water for
    // this era. A different prior.era (e.g. after a wipe minted a fresh era)
    // resets the high-water to the current seq under the new era.
    const highSeq = prior && prior.era === this.eraValue
      ? Math.max(this.seq, prior.highSeq)
      : this.seq;
    await this.eraGuard.save(this.eraValue as string, highSeq);
  }

  /** Replace the single `#era` marker in the reserved graph (delete-any + insert). */
  private async writeEra(era: string): Promise<void> {
    await deleteByPatternWithoutCount(this.inner, {
      subject: META_SUBJECT, predicate: P_ERA, graph: CHANGELOG_GRAPH,
    });
    await this.inner.insert([{
      subject: META_SUBJECT, predicate: P_ERA, object: `"${era}"`, graph: CHANGELOG_GRAPH,
    }]);
  }

  /**
   * Best-effort: persist the current seq as the durable high-water after a
   * committed write, so a later restore below it is detectable. Non-fatal — the
   * data+marker already committed; a failed guard write just leaves a slightly
   * stale high-water that the next write re-advances. Runs under the write mutex.
   */
  private async noteHighWater(): Promise<void> {
    if (!this.eraGuard || !this.eraValue) return;
    try {
      await this.eraGuard.save(this.eraValue, this.seq);
    } catch {
      // A stale high-water only narrows restore detection; never fail a write.
    }
  }

  /** Emit `upsert`/`drop` markers for graphs after a mutation, op by probe. */
  private async markPostMutation(graphs: readonly string[], options?: QueryOptions): Promise<void> {
    const distinct = [...new Set(graphs.filter((g) => g && !this.isReservedGraph(g)))];
    if (distinct.length === 0) return;
    // The presence probes are independent — run them concurrently (matching
    // GraphSetIndexStore) instead of serially inside the held write mutex, then
    // append markers in the original deterministic (distinct) order.
    let specs: Array<{ graph: string; op: ChangeOp }>;
    try {
      specs = await Promise.all(
        distinct.map(async (graph): Promise<{ graph: string; op: ChangeOp }> => ({
          graph,
          op: (await this.inner.hasGraph(graph, options)) ? 'upsert' : 'drop',
        })),
      );
    } catch (err) {
      // The mutation already committed; a failed presence probe means its
      // marker can never be written — the same committed-but-unlogged gap as a
      // failed marker append, so flag it identically before propagating.
      this.flagReconcile('markPostMutation(presence-probe-failed)');
      throw err;
    }
    await this.appendMarkers(specs, options);
  }

  /**
   * Allocate contiguous seqs and durably append markers (caller holds mutex).
   *
   * This is the POST-MUTATION marker sink (drops/deletes/update-upserts): the
   * data mutation has already committed, so a failure here means a committed
   * change with no marker. We flag {@link needsReconcile} before propagating so
   * the gap is signalled even before the PR2 catalog reconcile runs. `seq` is
   * advanced only after a durable append, so a failure is gapless (the next
   * write reuses the seq). The atomic `insert()` upsert path does NOT go through
   * here — it fuses markers into the data transaction and cannot half-commit.
   */
  private async appendMarkers(
    specs: ReadonlyArray<{ graph: string; op: ChangeOp }>,
    options?: QueryOptions,
  ): Promise<void> {
    if (specs.length === 0) return;
    try {
      await this.ensureSeeded();
      let candidate = this.seq;
      const quads: Quad[] = [];
      const records: ChangeRecord[] = [];
      for (const spec of specs) {
        candidate += 1;
        records.push({ seq: candidate, graph: spec.graph, op: spec.op });
        quads.push(...markerQuads(candidate, spec.graph, spec.op));
      }
      await this.inner.insert(quads, options);
      this.seq = candidate;
      await this.noteHighWater();
      this.fire(records);
    } catch (err) {
      this.flagReconcile('appendMarkers(post-mutation-marker-write-failed)');
      throw err;
    }
  }

  private fire(records: readonly ChangeRecord[]): void {
    if (!this.onAppend) return;
    for (const record of records) {
      try {
        this.onAppend(record);
      } catch {
        // Observability must never fail an already-committed write.
      }
    }
  }

  private flagReconcile(_reason: string): void {
    this.reconcilePending = true;
  }

  /** Distinct named graphs from `quads`, excluding default and reserved graphs. */
  private attributableGraphs(quads: readonly Quad[]): string[] {
    const set = new Set<string>();
    for (const q of quads) {
      if (q.graph && !this.isReservedGraph(q.graph)) set.add(q.graph);
    }
    return [...set];
  }

  /** Drop caller quads that target the reserved plane (marker forgery guard). */
  private stripReserved(quads: readonly Quad[]): Quad[] {
    return quads.filter((q) => !(q.graph && this.isReservedGraph(q.graph)));
  }

  /** Reject a graph-targeted mutation aimed at the reserved plane. Safe as a
   *  hard error: reserved graphs are never enumerated (listGraphs filters,
   *  hasGraph returns false), so no legitimate iterate-and-drop loop can reach
   *  one — only a hardcoded reserved IRI does. */
  private assertNotReserved(graphUri: string, op: string): void {
    if (this.isReservedGraph(graphUri)) {
      throw new Error(
        `ChangelogStore: ${op}(<${graphUri}>) targets the reserved changelog plane, ` +
          `which is not writable through the public store API.`,
      );
    }
  }

  private isReservedGraph(graphUri: string): boolean {
    return this.reserved.has(graphUri) || isAtomicGraphReplaceStagingGraph(graphUri);
  }

  /**
   * Reject an opaque SPARQL UPDATE that references a reserved graph IRI. A
   * best-effort guard against accidental mutation and the obvious hardcoded-IRI
   * vector — NOT airtight against hostile opaque SPARQL (prefixed forms evade
   * it). The structured paths (insert/delete/dropGraph) are the real guards; the
   * reserved plane's integrity ultimately rests on it being reconcile-derived.
   */
  private assertNoReservedRef(sparql: string, op: string): void {
    for (const g of this.reserved) {
      if (sparql.includes(`<${g}>`)) {
        throw new Error(
          `ChangelogStore: ${op} references the reserved changelog graph <${g}>, ` +
            `which is not writable through the public store API.`,
        );
      }
    }
  }

  /** Reject a no-graph deleteByPattern whose subject/predicate is namespaced
   *  under a reserved graph (marker terms like `urn:dkg:changelog#seq`) — that
   *  would delete markers cross-graph. */
  private assertNoReservedTerm(pattern: Partial<Quad>): void {
    const terms = [pattern.subject, pattern.predicate];
    for (const g of this.reserved) {
      if (terms.some((t) => t != null && t.startsWith(g))) {
        throw new Error(
          `ChangelogStore: deleteByPattern by a term under the reserved graph <${g}> ` +
            `would mutate the changelog plane, which is not writable through the public store API.`,
        );
      }
    }
  }
}

// ====================================================================
// Marker (de)serialization helpers
// ====================================================================

function markerQuads(seq: number, graph: string, op: ChangeOp): Quad[] {
  const entry = `${ENTRY_PREFIX}${seq}`;
  return [
    { subject: entry, predicate: P_SEQ, object: `"${seq}"^^<${XSD_INTEGER}>`, graph: CHANGELOG_GRAPH },
    { subject: entry, predicate: P_GRAPH, object: graph, graph: CHANGELOG_GRAPH },
    { subject: entry, predicate: P_OP, object: `"${op}"`, graph: CHANGELOG_GRAPH },
  ];
}

/** The one-time schema marker; written lazily is unnecessary, exposed for setup/tests. */
export function changelogSchemaQuad(): Quad {
  return {
    subject: META_SUBJECT,
    predicate: P_SCHEMA_VERSION,
    object: `"${CHANGELOG_SCHEMA_VERSION}"^^<${XSD_INTEGER}>`,
    graph: CHANGELOG_GRAPH,
  };
}

/** Extract an integer from a binding term (`"42"^^<…integer>`, `42`, or `"42"`). */
function parseIntTerm(term: string | undefined): number | null {
  if (term == null) return null;
  const m = term.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Bare IRI from a binding term (strip surrounding angle brackets if present). */
function stripIri(term: string | undefined): string {
  if (!term) return '';
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}

/** Lexical value from a literal binding term (`"upsert"` → `upsert`). */
function stripLiteral(term: string | undefined): string {
  if (!term) return '';
  const m = term.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : term;
}

/**
 * Drop the update-only `touchedGraphs` hint, yielding the read-path
 * `QueryOptions` (source/priority/signal) to forward to the post-mutation
 * `hasGraph` probes. Intentionally duplicates GraphSetIndexStore's boundary
 * helper of the same name — a trivial destructure kept local to avoid a
 * decorator-to-decorator import.
 */
function queryOptionsFromUpdateOptions(options?: UpdateOptions): QueryOptions | undefined {
  if (!options) return undefined;
  const { touchedGraphs: _touchedGraphs, ...readOptions } = options;
  return readOptions;
}

/** Preserve the caller's exact abort reason while keeping query-free reads cancellable. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/**
 * Recover the {@link ChangelogReader} capability from a store (typically a
 * `createTripleStore(...)` result), or `null` when the changelog is not enabled.
 * The intended consumer boundary: `asChangelogReader(store)?.readChanges(...)` —
 * no `instanceof`/cast/decorator-order assumption at the call site.
 */
export function asChangelogReader(store: unknown): ChangelogReader | null {
  return findTripleStoreCapability(
    store,
    (candidate): candidate is ChangelogReader => {
      if (candidate instanceof ChangelogStore) return true;
      if (typeof candidate !== 'object' || candidate === null) return false;
      const reader = candidate as Partial<ChangelogReader>;
      return typeof reader.changelogHead === 'function'
        && typeof reader.readChanges === 'function'
        && typeof reader.headSeq === 'function'
        && typeof reader.clearReconcileFlag === 'function'
        && typeof reader.needsReconcile === 'boolean';
    },
  );
}
