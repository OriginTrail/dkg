import type {
  Quad,
  QueryOptions,
  QueryResult,
  TripleStore,
  UpdateOptions,
  StorePressureSnapshot,
} from './triple-store.js';

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
}

/**
 * Write-path append-only change log. See the class-level docstring for the
 * crash-consistency and single-writer arguments.
 */
export class ChangelogStore implements TripleStore {
  get queryCancellation() {
    return this.inner.queryCancellation;
  }

  private readonly inner: TripleStore;
  private readonly enabled: boolean;
  private readonly reserved: ReadonlySet<string>;
  private readonly onAppend?: (record: ChangeRecord) => void;

  /** Last ALLOCATED seq (0 = none). Next seq is `seq + 1`. */
  private seq = 0;
  private seedPromise: Promise<void> | null = null;
  /** Serializes mutations so commit order === seq order (single writer). */
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Set when a mutation could not be attributed to specific graphs (an opaque
   * `update()`/`query()` UPDATE with no `touchedGraphs` hint). Its changed
   * graphs are missing from the log until a catalog reconcile (PR2) emits
   * synthetic markers. Exposed via {@link needsReconcile} so the daemon can act.
   */
  private reconcilePending = false;

  constructor(inner: TripleStore, options: ChangelogStoreOptions = {}) {
    this.inner = inner;
    this.enabled = options.enabled !== false;
    const reserved = new Set<string>([CHANGELOG_GRAPH]);
    for (const g of options.reservedGraphs ?? []) reserved.add(g);
    this.reserved = reserved;
    this.onAppend = options.onAppend;
  }

  // ------------------------------------------------------------------
  // Mutations (marker-emitting)
  // ------------------------------------------------------------------

  async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.insert(quads, options);
    const touched = this.attributableGraphs(quads);
    if (touched.length === 0) {
      // Nothing the log cares about (default graph, or only reserved graphs).
      return this.inner.insert(quads, options);
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
      await this.inner.insert([...quads, ...markers], options);
      this.seq = candidate; // advance only after durable success (gapless)
      this.fire(records);
    });
  }

  async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.delete(quads, options);
    const touched = this.attributableGraphs(quads);
    await this.runExclusive(async () => {
      await this.inner.delete(quads, options);
      await this.markPostMutation(touched, options);
    });
  }

  async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    if (!this.enabled) return this.inner.deleteByPattern(pattern, options);
    return this.runExclusive(async () => {
      const removed = await this.inner.deleteByPattern(pattern, options);
      if (removed > 0) {
        if (pattern.graph && !this.reserved.has(pattern.graph)) {
          await this.markPostMutation([pattern.graph], options);
        } else if (!pattern.graph) {
          // No graph hint → cannot attribute which graphs shrank/emptied.
          this.flagReconcile('deleteByPattern(no-graph)');
        }
      }
      return removed;
    });
  }

  async deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    if (!this.enabled) return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
    return this.runExclusive(async () => {
      const removed = await this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
      if (removed > 0 && !this.reserved.has(graphUri)) {
        await this.markPostMutation([graphUri], options);
      }
      return removed;
    });
  }

  async dropGraph(graphUri: string, options?: QueryOptions): Promise<void> {
    if (!this.enabled) return this.inner.dropGraph(graphUri, options);
    await this.runExclusive(async () => {
      await this.inner.dropGraph(graphUri, options);
      if (!this.reserved.has(graphUri)) {
        await this.appendMarkers([{ graph: graphUri, op: 'drop' }], options);
      }
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
      throw new Error('ChangelogStore: inner store does not support update()');
    }
    if (!this.enabled) return this.inner.update(sparql, options);
    await this.runExclusive(async () => {
      await this.inner.update!(sparql, options);
      const hinted = (options?.touchedGraphs ?? []).filter((g) => !this.reserved.has(g));
      if (hinted.length > 0) {
        await this.markPostMutation(hinted, options);
      } else {
        // Opaque server-side UPDATE (e.g. an RS heal INSERT…WHERE with no hint).
        this.flagReconcile('update(no-touchedGraphs)');
      }
    });
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    const result = await this.inner.query(sparql, options);
    // A SPARQL UPDATE smuggled through query() is opaque to us — flag for
    // reconcile rather than silently dropping its changes from the log.
    if (this.enabled && isSparqlUpdate(sparql)) {
      this.flagReconcile('query(update)');
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Reads (reserved-graph aware)
  // ------------------------------------------------------------------

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    if (this.reserved.has(graphUri)) return false; // reserved plane is invisible upward
    return this.inner.hasGraph(graphUri, options);
  }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    const graphs = await this.inner.listGraphs(options);
    return this.enabled ? graphs.filter((g) => !this.reserved.has(g)) : graphs;
  }

  async listGraphsByPrefix(prefix: string, options?: QueryOptions): Promise<string[]> {
    const graphs = this.inner.listGraphsByPrefix
      ? await this.inner.listGraphsByPrefix(prefix, options)
      : (await this.inner.listGraphs(options)).filter((g) => g.startsWith(prefix));
    return this.enabled ? graphs.filter((g) => !this.reserved.has(g)) : graphs;
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

  /** Highest seq durably present in the log (0 if empty). */
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
    await this.inner.flush?.(options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Serialize a mutation so no two writes interleave their seq allocation. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(), () => fn());
    // Keep the chain alive regardless of this op's outcome.
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Seed the in-memory counter from the durable log's high-water mark, once. */
  private ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = this.headSeq({ source: 'changelog.seed' })
        .then((head) => {
          this.seq = head;
        })
        .catch((err) => {
          // Reset so a transient store error retries seeding on the next write
          // rather than latching seq=0 (which would collide with existing seqs).
          this.seedPromise = null;
          throw err;
        });
    }
    return this.seedPromise;
  }

  /** Emit `upsert`/`drop` markers for graphs after a mutation, op by probe. */
  private async markPostMutation(graphs: readonly string[], options?: QueryOptions): Promise<void> {
    const distinct = [...new Set(graphs.filter((g) => g && !this.reserved.has(g)))];
    if (distinct.length === 0) return;
    const specs: Array<{ graph: string; op: ChangeOp }> = [];
    for (const graph of distinct) {
      const stillThere = await this.inner.hasGraph(graph, options);
      specs.push({ graph, op: stillThere ? 'upsert' : 'drop' });
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
      if (q.graph && !this.reserved.has(q.graph)) set.add(q.graph);
    }
    return [...set];
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

/** True if `sparql` is a SPARQL 1.1 UPDATE (mirrors GraphSetIndexStore). */
function isSparqlUpdate(sparql: string): boolean {
  const withoutPrologue = sparql
    .trimStart()
    .replace(/^(?:(?:#[^\r\n]*(?:\r?\n|$))|(?:PREFIX\s+(?:[A-Za-z][\w-]*)?:\s*<[^>]*>|BASE\s*<[^>]*>)\s*)+/i, '')
    .trimStart();
  return /^(?:INSERT|DELETE|WITH|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD)\b/i.test(withoutPrologue);
}
