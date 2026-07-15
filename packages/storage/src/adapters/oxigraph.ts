import oxigraph from 'oxigraph';
import { NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY } from './graph-enumeration-query.js';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TripleStore,
  Quad as DKGQuad,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
  TripleStoreQueryOptions,
  UpdateOptions,
} from '../triple-store.js';
import {
  formatCanonicalRdfLiteralTerm,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { registerTripleStoreAdapter } from '../triple-store.js';
import { GraphWriteGenTracker } from '../graph-write-gen.js';
import {
  buildAtomicGraphReplaceUpdate,
  isAtomicGraphReplaceStagingGraph,
} from '../atomic-graph-replace.js';
import { quadsToNQuads } from '../bounded-rdf.js';
import { assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';

// SWM DATA segment (bucket `…/_shared_memory` + per-KA `…/_shared_memory/{author}/{n}`),
// NOT the sibling `…/_shared_memory_meta`. Kept in sync with the sync-ingest guard.
const SHARED_MEMORY_DATA_SEGMENT_RE = /\/_shared_memory(\/|$)/;

type OxStore = InstanceType<typeof oxigraph.Store>;
type OxTerm = oxigraph.Term;
type OxQuad = oxigraph.Quad;

export class OxigraphStore implements TripleStore {
  readonly queryCancellation = 'pre-dispatch' as const;

  private store: OxStore;
  private persistPath: string | undefined;
  // #1609: per-graph write generations, bumped on every local mutation (the
  // same choke points the sparql-http adapter pairs with its listGraphs-cache
  // invalidation). Feeds the chain-reconcile negative memo via
  // `asGraphWriteGenSource` / `getWriteGen`.
  private readonly writeGen = new GraphWriteGenTracker();

  /**
   * @param persistPath  If provided, the store will dump/load N-Quads
   *   to this file path for persistence across restarts. The underlying
   *   store is still in-memory, but data is hydrated on construction
   *   and flushed on insert/delete/close.
   */
  constructor(persistPath?: string) {
    this.store = new oxigraph.Store();
    this.persistPath = persistPath;
    if (persistPath) {
      this.hydrateSync(persistPath);
    }
  }

  /**
   * Hydrate the in-memory store from a persisted N-Quads dump on disk.
   *
   * On parse failure we deliberately fail loud: the corrupt file is renamed
   * aside for forensics (so the next daemon start picks up a clean empty
   * state) and the error is rethrown so the operator sees the failure
   * immediately rather than discovering empty data later through queries.
   *
   * Previously this swallowed all errors and started empty silently — that
   * was the proximate cause of the WM persistence regression documented in
   * docs/bugs/wm-persistence-regression.md.
   */
  private hydrateSync(filePath: string): void {
    if (!existsSync(filePath)) return;
    let data: string;
    try {
      data = readFileSync(filePath, 'utf-8') as string;
    } catch (err) {
      throw new Error(
        `OxigraphStore: failed to read persist file ${filePath}: ${(err as Error).message}`,
      );
    }
    if (!data.trim()) return;
    try {
      this.store.load(data, { format: 'application/n-quads' });
    } catch (err) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = `${filePath}.corrupt-${ts}`;
      try {
        renameSync(filePath, corruptPath);
      } catch (renameErr) {
        // Surface both the original parse error and the rename failure;
        // operator may need to clean up by hand.
        throw new Error(
          `OxigraphStore: failed to parse ${filePath} (${(err as Error).message}); ` +
            `also failed to move it aside: ${(renameErr as Error).message}`,
        );
      }
      // eslint-disable-next-line no-console
      console.error(
        `[OxigraphStore] hydrate failed for ${filePath}: ${(err as Error).message}. ` +
          `Moved corrupt store to ${corruptPath}; restart the daemon to continue with an empty store. ` +
          `The renamed file is preserved for forensics.`,
      );
      throw new Error(
        `OxigraphStore: store.nq corrupt at ${filePath}, moved to ${corruptPath}: ${(err as Error).message}`,
      );
    }
  }

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  private scheduleFlush(): void {
    if (!this.persistPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Background flush has no caller to receive errors; log them.
      // Explicit `flush()`/`close()` callers DO `await` flushNow() and
      // get the original throw, which is what we want for shutdown
      // durability — see flushNow()'s docstring.
      this.flushNow().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[OxigraphStore] background flush failed for ${this.persistPath}: ${(err as Error).message}. ` +
            `Next flush will retry; explicit flush() / close() will surface the error.`,
        );
      });
    }, 50);
  }

  /**
   * Dump the in-memory store to disk atomically + durably.
   *
   * Sequence:
   *   1. Write the full N-Quads dump to a sibling tmp file.
   *   2. fsync the tmp file so the bytes are on stable storage.
   *   3. Atomic rename(tmp -> persistPath) — POSIX guarantees atomicity, so
   *      a crash mid-step leaves the old persistPath intact.
   *   4. fsync the containing directory so the rename itself is durable.
   *
   * Previously a single `writeFile(persistPath, dump)` left the store
   * vulnerable to torn writes on SIGKILL (the file would be partially
   * rewritten, then hydrateSync would fail-then-swallow on next start).
   * This is the proximate fix for the catastrophic data-loss mode
   * documented in docs/bugs/wm-persistence-regression.md.
   *
   * Error model: this method THROWS on any write/fsync/rename failure
   * (ENOSPC, EACCES, EROFS, EXDEV, …). The background debounced flush
   * (via `scheduleFlush`) catches and logs — there's no caller to
   * propagate to. Explicit `flush()` and `close()` `await` this method
   * directly, so their callers (e.g. `DKGAgent.stop()`) receive the
   * error and can fail the shutdown loudly instead of reporting
   * success while data was lost on disk.
   */
  private async flushNow(): Promise<void> {
    if (!this.persistPath || this.flushing) return;
    this.flushing = true;
    const dir = dirname(this.persistPath);
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      const nquads = this.store.dump({ format: 'application/n-quads' });

      // 1+2: write to tmp, fsync to commit bytes.
      const fh = await open(tmpPath, 'w');
      try {
        await fh.writeFile(nquads, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }

      // 3: atomic rename — POSIX-atomic on the same filesystem.
      await rename(tmpPath, this.persistPath);

      // 4: fsync the directory so the rename itself survives a power loss.
      // Best-effort: some filesystems / Node versions don't expose dir-fd
      // sync; swallow ENOENT/EPERM since the rename itself already
      // succeeded and the cache will eventually flush. The rename itself
      // landed bytes on disk; only the directory entry's durability
      // depends on this step.
      try {
        const dirFh = await open(dir, 'r');
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        // Best-effort dir fsync — see comment above.
      }
    } catch (err) {
      // Log here so we see the failure regardless of the caller — but
      // re-throw so explicit callers fail loudly. (Background callers
      // catch + log themselves in scheduleFlush.)
      // eslint-disable-next-line no-console
      console.error(
        `[OxigraphStore] flushNow failed for ${this.persistPath}: ${(err as Error).message}. ` +
          `Tmp file (${tmpPath}) may need cleanup.`,
      );
      throw err instanceof Error
        ? err
        : new Error(`OxigraphStore flush failed: ${String(err)}`);
    } finally {
      this.flushing = false;
    }
  }

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    // Oversize parity with the Blazegraph adapter (OT-RFC-56 §4.6): Oxigraph
    // itself has no literal-size limit, which made oxigraph-backed nodes
    // accept + re-serve oversized literals that Blazegraph peers can
    // physically never store — the split-brain half of the 2026-07-08
    // mainnet poison incident. Assert at the same Java MUTF-8 hard limit so
    // no backend silently persists what another must refuse. The
    // `_shared_memory` DATA segment (bucket + per-KA descendants) is exempt:
    // its large literals are legitimately handled by the
    // SharedMemoryLiteralBlobStore wrapper (externalize-on-insert,
    // rehydrate-on-query), whose INNER store is exactly this adapter. The match
    // is a path SEGMENT (parity with the sync guard) so the sibling
    // `…/_shared_memory_meta` graph is NOT exempted — it is not externalized.
    const guarded = quads.filter((q) => !(q.graph && SHARED_MEMORY_DATA_SEGMENT_RE.test(q.graph)));
    if (guarded.length > 0) {
      assertQuadLiteralsMutf8Safe(guarded, {
        maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
        label: 'OxigraphStore.insert',
      });
    }
    const nquads = `${quadsToNQuads(quads)}\n`;
    this.store.load(nquads, { format: 'application/n-quads' });
    this.scheduleFlush();
    this.writeGen.recordGraphWrites(new Set(quads.map((q) => q.graph || '')));
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    for (const q of quads) {
      const oxQuad = toOxQuad(q);
      if (oxQuad) this.store.delete(oxQuad);
    }
    this.scheduleFlush();
    this.writeGen.recordGraphWrites(new Set(quads.map((q) => q.graph || '')));
  }

  async deleteByPattern(pattern: Partial<DKGQuad>): Promise<number> {
    const matches = this.store.match(
      pattern.subject ? oxigraph.namedNode(pattern.subject) : null,
      pattern.predicate ? oxigraph.namedNode(pattern.predicate) : null,
      pattern.object ? parseTerm(pattern.object) : null,
      pattern.graph ? oxigraph.namedNode(pattern.graph) : null,
    );
    for (const q of matches) {
      this.store.delete(q);
    }
    if (matches.length > 0) this.scheduleFlush();
    if (pattern.graph) this.writeGen.recordGraphWrites([pattern.graph]);
    else this.writeGen.recordUnscopedWrite();
    return matches.length;
  }

  async query(sparql: string, options?: TripleStoreQueryOptions): Promise<QueryResult> {
    throwIfAborted(options?.signal);
    // The embedded Oxigraph binding executes synchronously, so a caller abort
    // cannot interrupt this native call mid-flight. Use oxigraph-worker or an
    // HTTP backend when long sync queries need prompt cancellation.
    const result = this.store.query(sparql);
    throwIfAborted(options?.signal);

    if (typeof result === 'boolean') {
      return { type: 'boolean', value: result } satisfies AskResult;
    }

    if (typeof result === 'string') {
      return { type: 'bindings', bindings: [] } satisfies SelectResult;
    }

    if (!Array.isArray(result) || result.length === 0) {
      return { type: 'bindings', bindings: [] } satisfies SelectResult;
    }

    const first = result[0];
    if (first instanceof Map) {
      const bindings = (result as Map<string, OxTerm>[]).map((row) => {
        const obj: Record<string, string> = {};
        for (const [key, term] of row.entries()) {
          obj[key] = termToString(term);
        }
        return obj;
      });
      return { type: 'bindings', bindings } satisfies SelectResult;
    }


    const quads = (result as OxQuad[]).map(fromOxQuad);
    return { type: 'quads', quads } satisfies ConstructResult;
  }

  async hasGraph(graphUri: string, options?: TripleStoreQueryOptions): Promise<boolean> {
    throwIfAborted(options?.signal);
    const matches = this.store.match(
      null,
      null,
      null,
      oxigraph.namedNode(graphUri),
    );
    throwIfAborted(options?.signal);
    return matches.length > 0;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Oxigraph creates graphs implicitly on insert — no-op.
  }

  /** {@link GraphWriteGenSource} capability (#1609) — see graph-write-gen.ts. */
  getWriteGen(graphPrefix: string): number {
    return this.writeGen.getWriteGen(graphPrefix);
  }

  async dropGraph(graphUri: string): Promise<void> {
    this.store.update(`DROP SILENT GRAPH <${escapeUri(graphUri)}>`);
    this.scheduleFlush();
    this.writeGen.recordGraphWrites([graphUri]);
  }

  async replaceGraph(graphUri: string, quads: DKGQuad[]): Promise<void> {
    const guarded = quads.filter(
      (q) => !(q.graph && SHARED_MEMORY_DATA_SEGMENT_RE.test(q.graph)),
    );
    if (guarded.length > 0) {
      assertQuadLiteralsMutf8Safe(guarded, {
        maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
        label: 'OxigraphStore.replaceGraph',
      });
    }
    const plan = buildAtomicGraphReplaceUpdate(graphUri, quads);
    try {
      this.store.update(plan.update);
    } catch (error) {
      if (plan.cleanup) {
        try {
          this.store.update(plan.cleanup);
        } catch {
          // Keep the replacement error. Internal staging graphs are hidden
          // from enumeration and can be reaped independently.
        }
        this.scheduleFlush();
      }
      throw error;
    }
    this.scheduleFlush();
    this.writeGen.recordGraphWrites([graphUri]);
  }

  async listGraphs(options?: TripleStoreQueryOptions): Promise<string[]> {
    throwIfAborted(options?.signal);
    // Index-read enumeration shared with SparqlHttpStore — see the rationale on
    // NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY.
    const result = this.store.query(NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY);
    throwIfAborted(options?.signal);
    if (typeof result === 'boolean' || typeof result === 'string') return [];
    if (!Array.isArray(result)) return [];
    return (result as Map<string, OxTerm>[])
      .filter((row): row is Map<string, OxTerm> => row instanceof Map)
      .map((row) => {
        const g = row.get('g');
        return g ? g.value : '';
      })
      .filter((graph) => Boolean(graph) && !isAtomicGraphReplaceStagingGraph(graph));
  }

  async deleteBySubjectPrefix(
    graphUri: string,
    prefix: string,
  ): Promise<number> {
    const before = this.store.size;
    this.store.update(
      `DELETE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o } } WHERE { GRAPH <${escapeUri(graphUri)}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${escapeString(prefix)}")) } }`,
    );
    const removed = before - this.store.size;
    if (removed > 0) this.scheduleFlush();
    this.writeGen.recordGraphWrites([graphUri]);
    return removed;
  }

  /**
   * Server-side SPARQL UPDATE — runs inside the embedded oxigraph engine, so
   * graph-to-graph `INSERT…WHERE` copies keep terms byte-identical (no JS
   * termToString→parseTerm round-trip). See {@link TripleStore.update}.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async update(sparql: string, _options?: UpdateOptions): Promise<void> {
    // In-process oxigraph is never wrapped by a graph-set index, so the
    // `touchedGraphs` hint is inapplicable here — accepted for a uniform
    // update contract, ignored.
    this.store.update(sparql);
    this.scheduleFlush();
    // A raw UPDATE's write scope is not derivable at the call site
    // (`touchedGraphs` hints only membership changes) — unscoped bump.
    this.writeGen.recordUnscopedWrite();
  }

  async countQuads(graphUri?: string): Promise<number> {
    if (graphUri) {
      return this.store.match(
        null,
        null,
        null,
        oxigraph.namedNode(graphUri),
      ).length;
    }
    return this.store.size;
  }

  /**
   * Force pending writes to disk before resolving. Callers that need a
   * specific insert to survive an immediate process restart must `await`
   * this after the insert — otherwise only the 50ms debounced flush runs,
   * and it can be lost if the daemon dies in that window.
   *
   * Cancels any pending debounced flush (we'll cover its work) and waits
   * out any in-flight flushNow() before dumping the current snapshot, so
   * triples inserted while the previous flush was running aren't dropped.
   *
   * THROWS if the underlying write/fsync/rename fails (ENOSPC, EACCES,
   * EROFS, EXDEV, …). Callers that need a durable insert must treat the
   * rejection as a hard error — previous behaviour swallowed these and
   * returned success even when the data never landed.
   */
  async flush(): Promise<void> {
    if (!this.persistPath) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await this.flushNow();
  }

  /**
   * Final flush + cleanup. Must drain any in-flight flush BEFORE running
   * its own — otherwise `flushNow()` short-circuits on `this.flushing`
   * and silently drops any inserts that landed between the in-flight
   * dump and the close call. (That's the "lost the last few assertions"
   * mode in docs/bugs/wm-persistence-regression.md after the atomic-write
   * fix landed.)
   *
   * THROWS if the final flush fails — see `flush()` for the same error
   * contract. The agent's `stop()` path catches this and logs but does
   * not crash the shutdown, but at least the failure is now observable;
   * previously a silent ENOSPC / EROFS during shutdown would lose data
   * and the daemon would report a clean exit.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await this.flushNow();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function parseTerm(term: string): oxigraph.NamedNode | oxigraph.Literal | oxigraph.BlankNode {
  if (term.startsWith('"')) {
    const literal = parseRdfLiteralTerm(term);
    if (literal) {
      // UNESCAPE the captured lexical form: query results (fromOxQuad →
      // termToString) hand back N-Quads-ESCAPED literals, and store.load()
      // (insert) UNescapes on parse — so a literal whose value contains
      // `"`, `\`, LF, or CR is stored unescaped but arrives here escaped.
      // Without this reversal, `oxigraph.literal(match[1])` builds a literal
      // whose value is the ESCAPED form, which never matches the stored term,
      // so deleteByPattern / delete silently affect ZERO quads. (Empirically
      // reproduced; this is the OT-RFC-56 boot-sweep no-op blocker.)
      if (literal.kind === 'language') return oxigraph.literal(literal.value, literal.language);
      if (literal.kind === 'typed') {
        return oxigraph.literal(literal.value, oxigraph.namedNode(literal.datatype));
      }
      return oxigraph.literal(literal.value);
    }
    return oxigraph.literal(term.slice(1, -1));
  }
  if (term.startsWith('_:')) return oxigraph.blankNode(term.slice(2));
  return oxigraph.namedNode(term);
}

function toOxQuad(q: DKGQuad): oxigraph.Quad | null {
  try {
    const subject = parseTerm(q.subject) as oxigraph.NamedNode | oxigraph.BlankNode;
    const predicate = oxigraph.namedNode(q.predicate);
    const object = parseTerm(q.object);
    const graph = q.graph
      ? oxigraph.namedNode(q.graph)
      : oxigraph.defaultGraph();
    return oxigraph.quad(subject, predicate, object, graph);
  } catch {
    return null;
  }
}

function fromOxQuad(oxq: OxQuad): DKGQuad {
  return {
    subject: termToString(oxq.subject),
    predicate: oxq.predicate.value,
    object: termToString(oxq.object),
    graph:
      oxq.graph.termType === 'DefaultGraph' ? '' : oxq.graph.value,
  };
}

function termToString(t: OxTerm): string {
  if (t.termType === 'Literal') {
    const lit = t as oxigraph.Literal;
    if (lit.language) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'language',
        value: lit.value,
        language: lit.language,
      });
    }
    if (lit.datatype) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'typed',
        value: lit.value,
        datatype: lit.datatype.value,
      });
    }
    return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: lit.value });
  }
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  return t.value;
}

function escapeUri(uri: string): string {
  return uri.replace(/[<>"{}|\\^`]/g, '');
}

function escapeString(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

registerTripleStoreAdapter('oxigraph', async () => new OxigraphStore());
registerTripleStoreAdapter('oxigraph-persistent', async (opts) => {
  const filePath = opts?.path as string | undefined;
  if (!filePath) throw new Error('oxigraph-persistent requires options.path');
  return new OxigraphStore(filePath);
});
