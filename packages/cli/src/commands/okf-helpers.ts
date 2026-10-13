/**
 * Pure helpers for the `dkg okf` command: the daemon query-result readers, the
 * import summary, the `--relate` rule parser and the graph → exporter-input
 * reconstruction. Kept out of `okf.ts` so the command file stays inside the
 * repo's file-size budget and so the reconstruction is unit-testable without
 * a daemon.
 */

import {
  exportInputFromQuads,
  isStale,
  SCHEMA_NS,
  type BundleImport,
  type ExportInput,
  type Quad,
  type TypeRelation,
} from '@origintrail-official/dkg-okf';

/**
 * The daemon's /api/query returns SELECT results as `{ bindings: [...] }` —
 * WITHOUT the `type: 'bindings'` discriminator the QueryResult union expects.
 * Gating on `result.type === 'bindings'` therefore silently yields no rows
 * (the bug that made `okf verify` report 0 for everything). Read `bindings`
 * structurally instead.
 */
export function bindingsOf(result: unknown): Array<Record<string, unknown>> {
  if (result && typeof result === 'object' && Array.isArray((result as { bindings?: unknown }).bindings)) {
    return (result as { bindings: Array<Record<string, unknown>> }).bindings;
  }
  return [];
}

/**
 * A `/api/query` binding cell can arrive as a bare string OR a SPARQL-JSON
 * object (`{ value, type, datatype? }`); calling `.startsWith()`/`.exec()` on
 * the object form throws at runtime. Normalise every cell to its string value
 * before use (mirrors the daemon's `bindingValue`). The static `QueryResult`
 * type annotates cells as strings, but the runtime path can return objects.
 */
export function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw === null || raw === undefined ? '' : String(raw);
  }
  return String(v);
}

export interface OkfImportSummary {
  concepts: number;
  reservedSkipped: number;
  triples: number;
  linksResolved: number;
  linksBroken: number;
  citations: number;
  sources: number;
  derivedFromConcepts: number;
  trustTiers: { humanReviewed: number; machineConfirmed: number; unverified: number };
  draft: number;
  deprecated: number;
  stale: number;
  attestedComputations: number;
}

/**
 * The import summary printed by `dkg okf import` / `--dry-run`: triple and link
 * counts plus the OKF v0.2 trust picture (SPEC §5). Staleness is
 * `now >= stale_after` (§5.5), evaluated against `now` here — never baked into
 * the deterministic mapping.
 */
export function summarizeOkfImport(imported: BundleImport, now: Date = new Date()): OkfImportSummary {
  let linksResolved = 0;
  let linksBroken = 0;
  let citations = 0;
  let sources = 0;
  let derivedFromConcepts = 0;
  const trustTiers = { humanReviewed: 0, machineConfirmed: 0, unverified: 0 };
  let draft = 0;
  let deprecated = 0;
  let stale = 0;
  let attestedComputations = 0;
  for (const c of imported.concepts) {
    linksResolved += new Set(c.resolvedLinks.map((l) => l.targetConceptId)).size;
    linksBroken += c.brokenLinks.length;
    citations += c.citations.length;
    sources += c.trust.sources;
    derivedFromConcepts += c.trust.derivedFromConcepts.length;
    if (c.trust.tier === 'human-reviewed') trustTiers.humanReviewed += 1;
    else if (c.trust.tier === 'machine-confirmed') trustTiers.machineConfirmed += 1;
    else trustTiers.unverified += 1;
    if (c.trust.status === 'draft') draft += 1;
    if (c.trust.status === 'deprecated') deprecated += 1;
    if (isStale(c.trust.staleAfter, now)) stale += 1;
    if (c.trust.attestedComputation) attestedComputations += 1;
  }
  return {
    concepts: imported.concepts.length,
    reservedSkipped: imported.reservedSkipped.length,
    triples: imported.quads.length,
    linksResolved,
    linksBroken,
    citations,
    sources,
    derivedFromConcepts,
    trustTiers,
    draft,
    deprecated,
    stale,
    attestedComputations,
  };
}

/**
 * Parse repeatable `--relate "<FromType>><ToType>=<predicate>"` rules into
 * deterministic type-pair edge relations. The predicate is used as-is if it is
 * a full IRI, otherwise resolved against schema.org (so `hasPart` → schema:hasPart).
 */
export function parseRelateRules(raw: string[]): TypeRelation[] {
  return raw.map((rule) => {
    const eq = rule.lastIndexOf('=');
    const gt = rule.indexOf('>');
    if (eq === -1 || gt === -1 || gt > eq) {
      throw new Error(`Invalid --relate rule "${rule}". Expected "<FromType>><ToType>=<predicate>".`);
    }
    const from = rule.slice(0, gt).trim();
    const to = rule.slice(gt + 1, eq).trim();
    const predToken = rule.slice(eq + 1).trim();
    if (!from || !to || !predToken) {
      throw new Error(`Invalid --relate rule "${rule}". Expected "<FromType>><ToType>=<predicate>".`);
    }
    const predicate = predToken.includes('://') ? predToken : SCHEMA_NS + predToken;
    return { from, to, predicate };
  });
}

/**
 * The per-predicate triple counts `dkg okf verify` expects to find. A store
 * holds a set, so each distinct (subject, predicate, object) is counted once —
 * a repeated quad in the mapping (which the mapper no longer emits, but a
 * caller-supplied mapping might) must not become a shortfall that no re-import
 * can ever repair.
 */
export function distinctTripleCountsByPredicate(quads: Quad[]): Map<string, number> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(q.predicate, (counts.get(q.predicate) ?? 0) + 1);
  }
  return counts;
}

/** Daemon bindings carry IRIs raw or as `<…>`; strip the brackets so terms match the mapper's raw-IRI convention. */
function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;
}

/**
 * `?s ?p ?o` bindings from one Context Graph view → quads. The daemon returns
 * cells as bare strings or SPARQL-JSON objects, and IRIs raw or bracketed;
 * both are normalised. Bindings with an empty cell are skipped. Pure; no daemon.
 */
export function quadsFromBindings(bindings: Array<Record<string, unknown>>): Quad[] {
  const quads: Quad[] = [];
  for (const b of bindings) {
    const s = cell(b.s);
    const p = cell(b.p);
    const o = cell(b.o);
    if (!s || !p || !o) continue;
    quads.push({ subject: unwrapIri(s), predicate: unwrapIri(p), object: o });
  }
  return quads;
}

/**
 * The exporter's input for a Context Graph view's bindings. Root discovery and
 * the attachment of each skolemized family / section node to its concept are
 * the OKF package's own reading of its IRI layout (`exportInputFromQuads`);
 * the CLI only converts the daemon's bindings.
 */
export function exportInputFromBindings(bindings: Array<Record<string, unknown>>, iriBase: string): ExportInput {
  return exportInputFromQuads(quadsFromBindings(bindings), { iriBase });
}
