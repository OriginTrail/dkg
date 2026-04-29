import oxigraph from 'oxigraph';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TripleStore,
  Quad as DKGQuad,
  QueryResult,
  SelectResult,
  ConstructResult,
  AskResult,
} from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

type OxStore = InstanceType<typeof oxigraph.Store>;
type OxTerm = oxigraph.Term;
type OxQuad = oxigraph.Quad;

export class OxigraphStore implements TripleStore {
  private store: OxStore;
  private persistPath: string | undefined;

  /**
   * Side-table preserving the ORIGINAL `^^<datatype>` of typed numeric
   * literals through round-trips. Oxigraph canonicalizes numeric
   * subtypes (e.g. `xsd:long` → `xsd:integer`), which loses the
   * publisher's intent and breaks.
   *
   * previously keyed by the lexical value alone, which
   * corrupted results whenever two quads in the store used the same
   * lexeme with different declared types (e.g. `"1"^^xsd:int` and
   * `"1"^^xsd:positiveInteger`). The later insert clobbered the
   * earlier entry, so BOTH quads read back with the newer datatype.
   *
   * Key is now the full quad identity (subject | predicate | value |
   * graph) so each typed-literal position owns its own declared type.
   * Collisions only happen when the same position is written twice
   * with different declared types, which is a genuine overwrite.
   *
   * even with the
   * per-position key, two quads at the same `(s, p, value, g)` with
   * DIFFERENT declared subtypes (e.g. `"1"^^xsd:int` and
   * `"1"^^xsd:positiveInteger`) collapse to the SAME single
   * canonicalised literal in Oxigraph. Silently letting the second
   * insert overwrite the first meant the readback returned the
   * latest-written subtype for both — a fail-OPEN data-integrity bug.
   * The fix below tracks per-position conflicts in
   * {@link conflictedNumericDatatypeKeys} and per-lexeme conflicts in
   * {@link conflictedNumericDatatypeLexemes}: once a key (or its
   * lexeme) conflicts, the side-table refuses to restore the subtype
   * for that key (and for unkeyed SELECT bindings of the same
   * lexeme). Callers fall through to Oxigraph's canonical form
   * (`xsd:integer`) — fail-CLOSED.
   */
  private originalNumericDatatype = new Map<string, string>();

  /**
   * Set of side-table keys whose per-position write history saw two
   * different declared subtypes. Once a key is in this set we refuse
   * to restore its subtype (and remove any prior entry from
   * {@link originalNumericDatatype} so we don't leak the
   * latest-write-wins value through `restoreOriginalDatatype`).
   * Persisted alongside the dump so the conflict survives restarts;
   */
  private conflictedNumericDatatypeKeys = new Set<string>();

  /**
   * Set of lexemes (raw value strings) for which any per-position key
   * conflict has been observed. SELECT bindings strip the position
   * (we only see the lexeme value), so the lexical-only fallback in
   * {@link restoreOriginalDatatypeForSelectBinding} consults this set
   * and refuses to restore — even when the surviving non-conflicting
   * entries for the same lexeme would otherwise resolve to a single
   * subtype. Without this guard, a SELECT row hit by the conflicted
   * position would silently inherit a sibling position's dtype.
   * Persisted alongside the dump.
   */
  private conflictedNumericDatatypeLexemes = new Set<string>();

  private static numericDatatypeKey(
    subject: string,
    predicate: string,
    value: string,
    graph: string | undefined,
  ): string {
    return `${subject}\u0000${predicate}\u0000${value}\u0000${graph ?? ''}`;
  }

  /**
   * Reverse of {@link numericDatatypeKey} — extract the lexeme `value`
   * field from a key. Used by {@link maybeReleaseLexemeMarker} to walk
   * the remaining conflict-key set when deciding whether the
   * companion lexeme-level marker is still needed.
   *
   * Returns `undefined` for malformed keys (e.g. legacy hydrated keys
   * whose serialisation predates the 4-segment NUL shape) so the
   * caller treats them as "lexeme unknown — keep the marker
   * pessimistically" instead of falsely releasing it.
   *
   * oxigraph.ts:169, KK3b).
   */
  private static parseLexemeFromNumericDatatypeKey(key: string): string | undefined {
    const parts = key.split('\u0000');
    if (parts.length !== 4) return undefined;
    return parts[2];
  }

  /**
   * After removing one or more entries from
   * {@link conflictedNumericDatatypeKeys}, check whether the
   * companion lexeme markers in {@link conflictedNumericDatatypeLexemes}
   * are still warranted. A lexeme marker is only meaningful when AT
   * LEAST ONE per-key conflict still references that exact lexeme —
   * once every contributing key has been evicted (e.g. the
   * conflicting quad was deleted, the graph dropped, or the subject
   * prefix wiped) the lexeme marker becomes a phantom that
   * permanently downgrades unrelated future writes for the same
   * lexeme to Oxigraph's canonical `xsd:integer`.
   *
   * oxigraph.ts:169, KK3b). Pre-r31-13
   * the lexeme marker was kept "pessimistically" forever — once
   * `"1"` had a transient conflict at any position, EVERY future
   * SELECT/CONSTRUCT of any `"1"^^xsd:long` literal across the
   * entire store fell back to `xsd:integer` regardless of whether
   * any conflict still actually existed in the live quad set, even
   * after the contributing quad was deleted or the graph was
   * dropped. This recomputes the marker from ground truth.
   */
  private maybeReleaseLexemeMarkers(lexemes: Iterable<string>): void {
    const candidates = new Set<string>();
    for (const lex of lexemes) {
      if (typeof lex === 'string' && lex.length > 0 && this.conflictedNumericDatatypeLexemes.has(lex)) {
        candidates.add(lex);
      }
    }
    if (candidates.size === 0) return;
    for (const k of this.conflictedNumericDatatypeKeys) {
      if (candidates.size === 0) return;
      const lex = OxigraphStore.parseLexemeFromNumericDatatypeKey(k);
      if (lex !== undefined && candidates.has(lex)) {
        candidates.delete(lex);
      }
    }
    for (const lex of candidates) {
      this.conflictedNumericDatatypeLexemes.delete(lex);
    }
  }

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
   * Capture publisher-declared numeric subtype before it goes through
   * Oxigraph (which collapses `xsd:long`, `xsd:int`, `xsd:short`,
   * `xsd:byte` and friends into `xsd:integer`). The declared type is
   * keyed per-quad (see {@link originalNumericDatatype}) so two quads
   * sharing a lexeme but declaring different subtypes each retain
   * their own declared type on read-back..
   */
  private rememberNumericDatatype(q: DKGQuad): void {
    const term = q.object;
    if (!term.startsWith('"')) return;
    const m = term.match(/^"((?:[^"\\]|\\.)*)"\^\^<([^>]+)>$/);
    if (!m) return;
    const value = m[1];
    const dtype = m[2];
    if (!isNumericSubtype(dtype)) return;
    const key = OxigraphStore.numericDatatypeKey(q.subject, q.predicate, value, q.graph);
    // Per-position conflict
    // detection: if this key is already known-conflicted, no further
    // writes can disambiguate it. If the key already has a different
    // declared subtype recorded, mark it (and the lexeme) as conflicted
    // and remove the now-ambiguous entry so `restoreOriginalDatatype`
    // can no longer return either side as authoritative — the only
    // safe answer is Oxigraph's canonicalised form.
    if (this.conflictedNumericDatatypeKeys.has(key)) {
      this.conflictedNumericDatatypeLexemes.add(value);
      return;
    }
    const existing = this.originalNumericDatatype.get(key);
    if (existing !== undefined && existing !== dtype) {
      this.originalNumericDatatype.delete(key);
      this.conflictedNumericDatatypeKeys.add(key);
      this.conflictedNumericDatatypeLexemes.add(value);
      return;
    }
    this.originalNumericDatatype.set(key, dtype);
  }

  /**
   * Drop the numeric-subtype side-table entry for a quad that was
   * just removed from the store. Before this guard,
   * `delete()` / `deleteByPattern()` / `dropGraph()` /
   * `deleteBySubjectPrefix()` silently left stale entries behind,
   * so `restoreOriginalDatatypeForSelectBinding()` could see phantom
   * subtype conflicts from data that no longer existed (and the
   * conflicts were persisted across restarts via the sidecar).
   */
  private forgetNumericDatatype(q: DKGQuad): void {
    const term = q.object;
    if (!term.startsWith('"')) return;
    const m = term.match(/^"((?:[^"\\]|\\.)*)"\^\^<([^>]+)>$/);
    if (!m) return;
    const value = m[1];
    const dtype = m[2];
    if (!isNumericSubtype(dtype)) return;
    const key = OxigraphStore.numericDatatypeKey(q.subject, q.predicate, value, q.graph);
    this.originalNumericDatatype.delete(key);
    // When the conflicting
    // canonical literal at this position is deleted, the conflict
    // marker becomes meaningless — Oxigraph collapsed both writes
    // into the single canonical literal that the caller is now
    // removing, so there is nothing left to restore-or-refuse for
    // this key. Drop the key marker.
    //
    // oxigraph.ts:169, KK3b). The
    // companion lexeme marker MUST also be re-evaluated against
    // ground truth: if no remaining conflict-key still references
    // this lexeme, the lexeme marker is dead too. the
    // lexeme marker was kept "pessimistically" forever, which made
    // subtype loss permanent for that literal — every later SELECT
    // of an otherwise unambiguous `"V"^^...` would fall back to
    // Oxigraph's canonical `xsd:integer` even after the contributing
    // quad / graph was gone. `maybeReleaseLexemeMarkers()` walks the
    // remaining conflict-key set and only releases the lexeme when
    // no key still contributes.
    this.conflictedNumericDatatypeKeys.delete(key);
    this.maybeReleaseLexemeMarkers([value]);
  }

  /**
   * Evict side-table entries whose graph suffix matches. Called from
   * `dropGraph()` / `deleteBySubjectPrefix()` / `deleteByPattern()`
   * when we don't have the pre-delete quad set to key by directly.
   * Keys are `s\0p\0value\0g` so we filter on the final `\0g` suffix
   * (plus optional subject-prefix predicate).
   */
  private evictNumericDatatypeForGraph(
    graphUri: string,
    subjectPrefix?: string,
  ): void {
    const suffix = `\u0000${graphUri}`;
    for (const k of this.originalNumericDatatype.keys()) {
      if (!k.endsWith(suffix)) continue;
      if (subjectPrefix && !k.startsWith(subjectPrefix)) continue;
      this.originalNumericDatatype.delete(k);
    }
    // The conflict-key
    // markers (kept on a parallel Set keyed by the same `s\0p\0v\0g`
    // shape) must be evicted in lockstep; otherwise dropping the
    // graph would leave dangling conflict markers that block
    // unrelated future writes from the same key shape (e.g. a fresh
    // graph re-using a UAL pattern).
    //
    // oxigraph.ts:169, KK3b). Collect
    // every lexeme that we drop a key for, then re-evaluate the
    // companion lexeme markers from ground truth. Without this, a
    // `dropGraph()` would erase the per-key conflict markers but
    // leave the lexeme markers behind forever, permanently
    // downgrading every future write of those literals to Oxigraph's
    // canonical `xsd:integer` even though no actual conflict
    // remains anywhere in the live store.
    const evictedLexemes = new Set<string>();
    for (const k of this.conflictedNumericDatatypeKeys) {
      if (!k.endsWith(suffix)) continue;
      if (subjectPrefix && !k.startsWith(subjectPrefix)) continue;
      const lex = OxigraphStore.parseLexemeFromNumericDatatypeKey(k);
      if (lex !== undefined) evictedLexemes.add(lex);
      this.conflictedNumericDatatypeKeys.delete(k);
    }
    if (evictedLexemes.size > 0) {
      this.maybeReleaseLexemeMarkers(evictedLexemes);
    }
  }

  /**
   * Companion sidecar path that persists the numeric-subtype metadata
   * across restarts. The main N-Quads dump cannot carry it because
   * Oxigraph canonicalises `xsd:long`/`xsd:int`/`xsd:short`/`xsd:byte`
   * to `xsd:integer` BEFORE the dump is emitted — so by the time we
   * read the file back the original declared type is gone. Writing it
   * alongside the dump (and reading it on {@link hydrateSync}) is the
   * only way to keep the side-table useful in `oxigraph-persistent`
   * across restarts.
   */
  private static numericDatatypeSidecarPath(persistPath: string): string {
    return `${persistPath}.numeric-datatypes.json`;
  }

  private hydrateSync(filePath: string): void {
    // Track whether
    // the primary N-Quads dump was actually hydrated before deciding
    // whether to read the sidecar. Pre-fix the sidecar was loaded
    // unconditionally — if the dump file was missing, empty, or
    // corrupt the silent `catch` would leave the store with no quads
    // while `originalNumericDatatype` was still populated from the
    // sidecar. The first new `insert()` whose subject reused a
    // sidecar key would then "restore" the new literal to the OLD
    // datatype that is no longer represented in the store, silently
    // corrupting downstream reads.
    let dumpLoaded = false;
    try {
      if (!existsSync(filePath)) return;
      const data = readFileSync(filePath, 'utf-8') as string;
      if (data.trim()) {
        this.store.load(data, { format: 'application/n-quads' });
        dumpLoaded = true;
      } else {
        // Empty dump file — treat as a fresh store. Don't pull stale
        // datatype metadata in alongside it.
        return;
      }
    } catch {
      // File missing or corrupt — start empty AND skip the sidecar
      // (see above). Returning here is the new fail-closed behaviour.
      return;
    }
    if (!dumpLoaded) return;
    // `originalNumericDatatype` used
    // to only be populated by live `insert()` calls, so after a process
    // restart every `oxigraph-persistent` store lost all numeric-subtype
    // metadata and `restoreOriginalDatatype*()` collapsed the literals
    // back to Oxigraph's canonical `xsd:integer`. Hydrate the side-table
    // from the companion sidecar written by {@link flushNow} so restart
    // round-trips preserve the publisher-declared subtype.
    try {
      const sidecarPath = OxigraphStore.numericDatatypeSidecarPath(filePath);
      if (!existsSync(sidecarPath)) return;
      const raw = readFileSync(sidecarPath, 'utf-8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as {
        entries?: Array<[string, string]>;
        // Persist the
        // per-position and per-lexeme conflict sets alongside the
        // entry map so a restart re-establishes "this position /
        // lexeme is ambiguous, never restore" instead of silently
        // forgetting the conflict (which would re-open the
        // fail-OPEN data-integrity bug the conflict tracking was
        // added to close).
        conflictedKeys?: string[];
        conflictedLexemes?: string[];
      };
      const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const entry of entries) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string'
        ) {
          this.originalNumericDatatype.set(entry[0], entry[1]);
        }
      }
      const conflictedKeys = parsed && Array.isArray(parsed.conflictedKeys)
        ? parsed.conflictedKeys : [];
      for (const k of conflictedKeys) {
        if (typeof k === 'string') this.conflictedNumericDatatypeKeys.add(k);
      }
      const conflictedLexemes = parsed && Array.isArray(parsed.conflictedLexemes)
        ? parsed.conflictedLexemes : [];
      for (const l of conflictedLexemes) {
        if (typeof l === 'string') this.conflictedNumericDatatypeLexemes.add(l);
      }
    } catch {
      // Sidecar missing or corrupt — fall back to lexical-only restore.
    }
  }

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  private scheduleFlush(): void {
    if (!this.persistPath || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, 50);
  }

  private async flushNow(): Promise<void> {
    if (!this.persistPath || this.flushing) return;
    this.flushing = true;
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      const nquads = this.store.dump({ format: 'application/n-quads' });
      await writeFile(this.persistPath, nquads, 'utf-8');
      // persist the numeric-subtype
      // side-table alongside the dump so hydrateSync() can restore it on
      // the next boot. Without this sidecar every restart re-canonicalises
      // `xsd:long`/`xsd:int`/... back to `xsd:integer` on read-back because
      // Oxigraph has already collapsed the subtype by the time it dumps.
      const sidecarPath = OxigraphStore.numericDatatypeSidecarPath(this.persistPath);
      const sidecar = JSON.stringify({
        // Bumped to v2
        // because the schema now includes `conflictedKeys` /
        // `conflictedLexemes` arrays so a restart re-establishes
        // per-position / per-lexeme conflict markers. v1 sidecars
        // load fine (the new arrays default to empty); the version
        // tag is informational for ops grepping the file.
        version: 2,
        entries: Array.from(this.originalNumericDatatype.entries()),
        conflictedKeys: Array.from(this.conflictedNumericDatatypeKeys),
        conflictedLexemes: Array.from(this.conflictedNumericDatatypeLexemes),
      });
      await writeFile(sidecarPath, sidecar, 'utf-8');
    } catch {
      // Best-effort persistence.
    } finally {
      this.flushing = false;
    }
  }

  async insert(quads: DKGQuad[]): Promise<void> {
    if (quads.length === 0) return;
    for (const q of quads) this.rememberNumericDatatype(q);
    const nquads = quads.map(quadToNQuad).join('\n') + '\n';
    this.store.load(nquads, { format: 'application/n-quads' });
    this.scheduleFlush();
  }

  async delete(quads: DKGQuad[]): Promise<void> {
    for (const q of quads) {
      const oxQuad = toOxQuad(q);
      if (oxQuad) this.store.delete(oxQuad);
      this.forgetNumericDatatype(q);
    }
    this.scheduleFlush();
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
      // We have the concrete deleted quads in hand, so do an exact
      // eviction rather than the graph-wide scan.
      this.forgetNumericDatatype(fromOxQuad(q));
    }
    if (matches.length > 0) this.scheduleFlush();
    return matches.length;
  }

  async query(sparql: string): Promise<QueryResult> {
    const result = this.store.query(sparql);

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
        // SELECT results are keyed only by the
        // binding value (we don't know which quad each binding came
        // from), so we can only safely restore the declared subtype
        // when every remembered quad with this lexeme agreed on it.
        // If two quads in the store declared different xsd subtypes
        // for the same lexeme (e.g. `"1"^^xsd:int` vs
        // `"1"^^xsd:positiveInteger`), SELECT cannot pick a side
        // without the position — so we fall through to Oxigraph's
        // canonical form instead of silently reporting the wrong type.
        for (const [key, term] of row.entries()) {
          obj[key] = this.restoreOriginalDatatypeForSelectBinding(termToString(term));
        }
        return obj;
      });
      return { type: 'bindings', bindings } satisfies SelectResult;
    }


    const quads = (result as OxQuad[]).map((oxq) => {
      const dq = fromOxQuad(oxq);
      dq.object = this.restoreOriginalDatatype(dq);
      return dq;
    });
    return { type: 'quads', quads } satisfies ConstructResult;
  }

  /**
   * Reverse of `rememberNumericDatatype` — if a CONSTRUCT row
   * contains a typed literal whose datatype Oxigraph collapsed
   * (e.g. `xsd:long` → `xsd:integer`), restore the publisher's
   * original declared type from the side-table keyed by the full
   * quad identity. Falls through unchanged when no entry exists or
   * the key is not a known numeric subtype.
   */
  private restoreOriginalDatatype(q: DKGQuad): string {
    const serialized = q.object;
    if (!serialized.startsWith('"')) return serialized;
    const m = serialized.match(/^"((?:[^"\\]|\\.)*)"\^\^<([^>]+)>$/);
    if (!m) return serialized;
    const value = m[1];
    const dtype = m[2];
    if (!isNumericSubtype(dtype)) return serialized;
    // Prefer the exact quad-identity match — the unambiguous path
    // when one position declared a specific subtype.
    const key = OxigraphStore.numericDatatypeKey(q.subject, q.predicate, value, q.graph);
    // Per-position conflict
    // short-circuit: if two writes at this exact `(s, p, value, g)`
    // declared different subtypes, the side-table cannot recover
    // either source's intent (Oxigraph collapsed both into one
    // canonical literal). Fall straight through to the canonical
    // form — do NOT delegate to the lexical-only fallback because
    // a sibling position with the same lexeme but a single declared
    // subtype would otherwise silently win.
    if (this.conflictedNumericDatatypeKeys.has(key)) {
      return serialized;
    }
    const original = this.originalNumericDatatype.get(key);
    if (original && original !== dtype) {
      return `"${value}"^^<${original}>`;
    }
    // CONSTRUCT results often project quads into the default graph
    // (`CONSTRUCT { ?s ?p ?o }`), so the per-quad key doesn't line up
    // with the graph-scoped write-time key. Fall back to the
    // lexical-only best-effort lookup WITH CONFLICT DETECTION: if
    // every remembered quad with this lexeme declared the same
    // subtype, restore it; if two different subtypes were declared
    // anywhere, refuse to guess and return Oxigraph's canonical form.
    return this.restoreOriginalDatatypeForSelectBinding(serialized);
  }

  /**
   * lexical-only restore for SELECT bindings. Only
   * returns the declared subtype when EVERY remembered quad that
   * carried this lexeme declared the SAME subtype — otherwise falls
   * back to Oxigraph's canonical form. This preserves the common
   * case (single publisher wrote `"42"^^xsd:long`) while refusing
   * to guess when the store contains conflicting declarations.
   */
  private restoreOriginalDatatypeForSelectBinding(serialized: string): string {
    if (!serialized.startsWith('"')) return serialized;
    const m = serialized.match(/^"((?:[^"\\]|\\.)*)"\^\^<([^>]+)>$/);
    if (!m) return serialized;
    const value = m[1];
    const dtype = m[2];
    if (!isNumericSubtype(dtype)) return serialized;
    // If ANY per-position
    // write of this lexeme observed a per-position subtype conflict,
    // the lexical-only path cannot tell whether THIS binding row came
    // from the conflicted position or a clean sibling — refuse to
    // restore so we can't silently inherit a sibling's dtype.
    if (this.conflictedNumericDatatypeLexemes.has(value)) {
      return serialized;
    }
    let only: string | undefined;
    // Keys are `s\0p\0value\0g` — scan for entries matching this value.
    const needle = `\u0000${value}\u0000`;
    for (const [k, v] of this.originalNumericDatatype) {
      if (!k.includes(needle)) continue;
      if (only === undefined) {
        only = v;
      } else if (only !== v) {
        return serialized; // conflict — fall back to Oxigraph canonical
      }
    }
    if (!only || only === dtype) return serialized;
    return `"${value}"^^<${only}>`;
  }

  async hasGraph(graphUri: string): Promise<boolean> {
    const matches = this.store.match(
      null,
      null,
      null,
      oxigraph.namedNode(graphUri),
    );
    return matches.length > 0;
  }

  async createGraph(_graphUri: string): Promise<void> {
    // Oxigraph creates graphs implicitly on insert — no-op.
  }

  async dropGraph(graphUri: string): Promise<void> {
    this.store.update(`DROP SILENT GRAPH <${escapeUri(graphUri)}>`);
    // every numeric-
    // subtype key that lived in this graph must be dropped too, so
    // `restoreOriginalDatatypeForSelectBinding` can't see phantom
    // conflicts from data that no longer exists (and the conflicts
    // don't get persisted across restarts via the sidecar).
    this.evictNumericDatatypeForGraph(graphUri);
    this.scheduleFlush();
  }

  async listGraphs(): Promise<string[]> {
    const result = this.store.query(
      'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }',
    );
    if (typeof result === 'boolean' || typeof result === 'string') return [];
    if (!Array.isArray(result)) return [];
    return (result as Map<string, OxTerm>[])
      .filter((row): row is Map<string, OxTerm> => row instanceof Map)
      .map((row) => {
        const g = row.get('g');
        return g ? g.value : '';
      })
      .filter(Boolean);
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
    if (removed > 0) {
      // evict sidecar
      // entries for quads that just vanished. We filter by
      // `startsWith(subjectPrefix)` (keys are `s\0p\0v\0g`) which
      // mirrors the SPARQL `STRSTARTS(STR(?s), prefix)` filter above.
      this.evictNumericDatatypeForGraph(graphUri, prefix);
      this.scheduleFlush();
    }
    return removed;
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

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushNow();
  }
}

function quadToNQuad(q: DKGQuad): string {
  const s = formatTerm(q.subject);
  const p = `<${q.predicate}>`;
  const o = formatTerm(q.object);
  const g = q.graph ? ` <${q.graph}>` : '';
  return `${s} ${p} ${o}${g} .`;
}

function formatTerm(term: string): string {
  if (term.startsWith('"')) {
    // Wrap bare datatype IRIs in angle brackets: "val"^^http://... → "val"^^<http://...>
    // Anchored to closing quote to avoid matching ^^ inside string content.
    const m = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
    if (m) return `${m[1]}^^<${m[2]}>`;
    return term;
  }
  if (term.startsWith('_:')) return term;
  if (term.startsWith('<')) return term;
  return `<${term}>`;
}

function parseTerm(term: string): oxigraph.NamedNode | oxigraph.Literal | oxigraph.BlankNode {
  if (term.startsWith('"')) {
    const match = term.match(/^"((?:[^"\\]|\\.)*)"(?:@(\S+)|\^\^<([^>]+)>)?$/);
    if (match) {
      if (match[2]) return oxigraph.literal(match[1], match[2]);
      if (match[3]) return oxigraph.literal(match[1], oxigraph.namedNode(match[3]));
      return oxigraph.literal(match[1]);
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

/** XSD numeric subtypes that Oxigraph silently canonicalises to
 *  `xsd:integer` — keep this list in sync with the W3C XSD spec
 *  derived-integer hierarchy. */
const NUMERIC_SUBTYPES = new Set<string>([
  'http://www.w3.org/2001/XMLSchema#long',
  'http://www.w3.org/2001/XMLSchema#int',
  'http://www.w3.org/2001/XMLSchema#short',
  'http://www.w3.org/2001/XMLSchema#byte',
  'http://www.w3.org/2001/XMLSchema#unsignedLong',
  'http://www.w3.org/2001/XMLSchema#unsignedInt',
  'http://www.w3.org/2001/XMLSchema#unsignedShort',
  'http://www.w3.org/2001/XMLSchema#unsignedByte',
  'http://www.w3.org/2001/XMLSchema#integer',
  'http://www.w3.org/2001/XMLSchema#nonNegativeInteger',
  'http://www.w3.org/2001/XMLSchema#positiveInteger',
  'http://www.w3.org/2001/XMLSchema#negativeInteger',
  'http://www.w3.org/2001/XMLSchema#nonPositiveInteger',
]);

function isNumericSubtype(dtype: string): boolean {
  return NUMERIC_SUBTYPES.has(dtype);
}

function escapeNQuadsLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function termToString(t: OxTerm): string {
  if (t.termType === 'Literal') {
    const lit = t as oxigraph.Literal;
    const escaped = escapeNQuadsLiteral(lit.value);
    if (lit.language) return `"${escaped}"@${lit.language}`;
    if (
      lit.datatype &&
      lit.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string'
    ) {
      return `"${escaped}"^^<${lit.datatype.value}>`;
    }
    return `"${escaped}"`;
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
