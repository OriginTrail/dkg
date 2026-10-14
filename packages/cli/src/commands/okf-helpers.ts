/**
 * Pure helpers for the `dkg okf` command: the daemon query-result readers, the
 * import summary, the `--relate` rule parser and the graph → exporter-input
 * reconstruction. Kept out of `okf.ts` so the command file stays inside the
 * repo's file-size budget and so the reconstruction is unit-testable without
 * a daemon.
 */

import { formatCanonicalRdfLiteralTerm, formatCanonicalRdfTerm, parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  distinctTriples,
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
 * A `/api/query` binding cell as an RDF term, in the one form DKG quads use:
 * the form the stores return (`formatCanonicalRdfTerm`) and the OKF mapper
 * writes, a bare IRI, `_:label` for a blank node and a literal in its
 * canonical form. A cell arrives as that string (an IRI may be bracketed, a
 * literal escaped otherwise) or as a SPARQL-JSON object (`{ type, value,
 * datatype?, "xml:lang"? }`; one without a `type` is read as its value's
 * string form); every wire form of one term gives the same string, so export
 * and verification compare the same terms. `null` for an empty cell or a kind
 * of term no quad holds.
 */
export function termOfCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const { type, value, datatype } = v as { type?: unknown; value?: unknown; datatype?: unknown };
    if (value === null || value === undefined) return null;
    const text = String(value);
    if (type === undefined) return termOfCell(text);
    if (type === 'uri') return text === '' ? null : text;
    if (type === 'bnode') return text === '' ? null : `_:${text}`;
    if (type !== 'literal' && type !== 'typed-literal') return null;
    const language = (v as Record<string, unknown>)['xml:lang'];
    return formatCanonicalRdfTerm({
      termType: 'Literal',
      value: text,
      language: typeof language === 'string' && language !== '' ? language : undefined,
      datatype: typeof datatype === 'string' && datatype !== '' ? { value: datatype } : undefined,
    });
  }
  const text = String(v);
  if (text === '') return null;
  if (text.startsWith('<') && text.endsWith('>')) return text.slice(1, -1);
  if (!text.startsWith('"')) return text;
  // A literal escaped otherwise reads as its canonical form; one that does not parse is kept as given.
  const literal = parseRdfLiteralTerm(text, { combineSurrogatePairs: true });
  return literal ? formatCanonicalRdfLiteralTerm(literal) : text;
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
  const counts = new Map<string, number>();
  // The OKF package's own triple identity (named graph ignored), the same policy export uses.
  for (const q of distinctTriples(quads)) counts.set(q.predicate, (counts.get(q.predicate) ?? 0) + 1);
  return counts;
}

/**
 * `?s ?p ?o` bindings from one Context Graph view → quads, every cell read as
 * an RDF term by `termOfCell`, so a bracketed object IRI (a family link, an
 * edge, an `rdf:type`) still matches the unbracketed subject it names, and a
 * literal is the same term whichever wire form it came in. Bindings with an
 * empty cell are skipped. Export and verification both read the graph this
 * way. Pure; no daemon.
 */
export function quadsFromBindings(bindings: Array<Record<string, unknown>>): Quad[] {
  const quads: Quad[] = [];
  for (const b of bindings) {
    const subject = termOfCell(b.s);
    const predicate = termOfCell(b.p);
    const object = termOfCell(b.o);
    if (!subject || !predicate || !object) continue;
    quads.push({ subject, predicate, object });
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
