/**
 * The clean inverse of the importer (ADR 0005): reconstruct a conformant OKF
 * v0.2 bundle from imported Knowledge Assets. Designed so that
 *
 *   import(bundle) → exportBundle(...) → import(...)
 *
 * reproduces an *equivalent graph* (same concepts, frontmatter triples, v0.2
 * family nodes, untyped edges and legacy citations). It is graph-faithful, not
 * byte-faithful: free-form prose is not recoverable from triples, so bodies are
 * regenerated structurally (a `# Related` section of links + a legacy
 * `# Citations` section). Section headings from the original body are
 * presentational and are not reconstructed — round-trip equivalence is asserted
 * over the semantic (non-`hasSection`) quad set.
 *
 * v0.2 families are rebuilt from their predicates and skolemized nodes
 * (`families.ts`), in the entry order baked into the node IRIs. Derived
 * triples (`okf:trustTier`, `prov:wasDerivedFrom`) are not written back; the
 * next import re-derives them. A concept that only carries a last-modified
 * time (a v0.1 import) is written with the legacy `timestamp` key, since
 * `generated` requires a `by` actor (§5.2) and the exporter never invents one.
 *
 * This module is pure: it consumes an `ExportInput` and returns `BundleFile[]`.
 * The `dkg okf export` command feeds it quads fetched from a Context Graph via
 * SPARQL; the same function powers the offline round-trip test.
 */

import { dump as dumpYaml } from 'js-yaml';
import {
  RDF_TYPE,
  RDF_JSON,
  SCHEMA_NS,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_IDENTIFIER,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_IS_PART_OF,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_URL,
  SCHEMA_CITATION,
  PROV_WAS_DERIVED_FROM,
  OKF_GENERATED_BY,
  OKF_GENERATED_PREFIX,
  OKF_VERIFICATION,
  OKF_VERIFIED_BY,
  OKF_VERIFIED_AT,
  OKF_TRUST_TIER,
  OKF_STATUS,
  OKF_STALE_AFTER,
  OKF_SOURCE,
  OKF_RESOURCE,
  OKF_AUTHOR,
  OKF_USAGE_COUNT,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
  OKF_RUNTIME,
  OKF_PARAMETER,
  OKF_PARAMETER_TYPE,
  OKF_REQUIRED,
  OKF_COMPUTATION,
  OKF_EXECUTOR_PREFIX,
  OKF_EXECUTOR_RESOURCE,
  OKF_EXECUTOR_RECEIPT,
  OKF_ATTESTER_PREFIX,
  OKF_ATTESTER_RESOURCE,
  OKF_ATTESTED_COMPUTATION_TYPE,
  OKF_TARGET_VERSION,
  SECTION_GENID_INFIX,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_BOOLEAN,
  DEFAULT_IRI_BASE,
} from './constants.js';
import type { BundleFile, ExportInput, OkfMappingOptions, Quad } from './types.js';

const LITERAL_RE = /^("(?:\\.|[^"\\])*")(?:\^\^<[^>]*>|@[A-Za-z-]+)?$/;
const TYPED_LITERAL_RE = /^("(?:\\.|[^"\\])*")\^\^<([^>]*)>$/;
const NODE_INDEX_RE = /_(\d+)$/;

/** Lexical value of a literal term, or `null` if the term is an IRI / blank node. */
function literalValue(term: string): string | null {
  if (!term.startsWith('"')) return null;
  const m = term.match(LITERAL_RE);
  if (!m) return null;
  return JSON.parse(m[1]) as string;
}

/**
 * Recover the native value of a known typed literal so producer-defined
 * numeric / boolean / object keys survive the round-trip. Import maps `count: 3`
 * → `"3"^^xsd:integer` and `{a: 1}` → `"{\"a\":1}"^^rdf:JSON`; without this,
 * export would emit YAML strings, which re-import as plain literals (datatype
 * and structure lost). Returns `null` for unknown datatypes / plain literals
 * so callers fall back to the lexical string.
 */
function typedValue(term: string): { value: unknown } | null {
  const m = term.match(TYPED_LITERAL_RE);
  if (!m) return null;
  const lexical = JSON.parse(m[1]) as string;
  switch (m[2]) {
    case XSD_INTEGER: {
      const n = Number(lexical);
      return Number.isInteger(n) ? { value: n } : null;
    }
    case XSD_DECIMAL: {
      const n = Number(lexical);
      return Number.isFinite(n) ? { value: n } : null;
    }
    case XSD_BOOLEAN:
      return lexical === 'true' ? { value: true } : lexical === 'false' ? { value: false } : null;
    case RDF_JSON: {
      try {
        return { value: JSON.parse(lexical) as unknown };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/**
 * Spec-defined type names whose exact spelling carries meaning for consumers
 * (§10.5 discovery is by `type: Attested Computation`). Producer types keep
 * the PascalCased local name — the original spacing is not recoverable.
 */
const SPEC_TYPE_NAMES: Record<string, string> = {
  AttestedComputation: OKF_ATTESTED_COMPUTATION_TYPE,
};

/** Map an rdf:type object IRI back to a writable `type` value. */
function typeValue(object: string): string {
  if (!object.startsWith(SCHEMA_NS)) return object;
  const local = object.slice(SCHEMA_NS.length);
  return SPEC_TYPE_NAMES[local] ?? local;
}

function conceptIdFromIri(iri: string, iriBase: string): string | null {
  return iri.startsWith(iriBase) ? iri.slice(iriBase.length) : null;
}

/** What one export run knows: the IRI namespace and the exact set of concept IRIs being written. */
interface ExportContext {
  iriBase: string;
  /** Subject IRIs of the concepts in this export — the only IRIs a path-valued field may be rewritten to a path for. */
  conceptIris: ReadonlySet<string>;
}

/**
 * Object term → YAML value. Literals become their typed native value or lexical
 * string; IRIs are written as given, except that for path-valued fields
 * (`pathForm`) an IRI that is one of the exported concepts is written back as
 * its recommended absolute bundle path `/<conceptId>.md` (SPEC §6.1/§6.2).
 * Membership is checked against the exported concept set, not just the IRI
 * namespace: with `iriBase: "https://example.org/"` an external
 * `https://example.org/docs/external` source must survive verbatim, or
 * re-import would read a broken path and lose its `prov:wasDerivedFrom` edge.
 */
function termValue(term: string, ctx: ExportContext, pathForm = false): unknown {
  if (term.startsWith('"')) {
    const typed = typedValue(term);
    return typed ? typed.value : (literalValue(term) ?? term);
  }
  if (pathForm && ctx.conceptIris.has(term)) {
    const id = conceptIdFromIri(term, ctx.iriBase);
    if (id !== null) return `/${id}.md`;
  }
  return term;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Accumulate a (possibly multi-valued) key: scalar on first sight, list thereafter. */
function accumulate(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key in target) {
    const cur = target[key];
    target[key] = Array.isArray(cur) ? [...cur, value] : [cur, value];
  } else {
    target[key] = value;
  }
}

/** Entry order baked into a family node IRI (`…_<n>`); unknown → last. */
function nodeIndex(iri: string): number {
  const m = iri.match(NODE_INDEX_RE);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function byNodeIndex(a: string, b: string): number {
  return nodeIndex(a) - nodeIndex(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Place `known` keys first (in the given order), then everything else in insertion order. */
function orderKeys(obj: Record<string, unknown>, known: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of known) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k];
  return out;
}

/** Predicates handled explicitly on the concept subject; any other `schema:` predicate is a producer key. */
const CONCEPT_PREDICATES = new Set([
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_IS_PART_OF,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_URL,
  SCHEMA_CITATION,
]);

/** A family node's producer-defined extras (`schema:<camelKey>` on the node). */
function nodeExtras(quads: Quad[], known: Set<string>, ctx: ExportContext): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const q of quads) {
    if (known.has(q.predicate) || q.predicate === RDF_TYPE) continue;
    if (!q.predicate.startsWith(SCHEMA_NS)) continue;
    accumulate(extras, q.predicate.slice(SCHEMA_NS.length), termValue(q.object, ctx));
  }
  return extras;
}

const VERIFICATION_PREDICATES = new Set([OKF_VERIFIED_BY, OKF_VERIFIED_AT]);
const SOURCE_PREDICATES = new Set([
  SCHEMA_IDENTIFIER,
  SCHEMA_NAME,
  OKF_RESOURCE,
  OKF_AUTHOR,
  OKF_USAGE_COUNT,
  SCHEMA_DATE_MODIFIED,
  OKF_USAGE_WINDOW_FROM,
  OKF_USAGE_WINDOW_TO,
]);
const PARAMETER_PREDICATES = new Set([SCHEMA_NAME, OKF_PARAMETER_TYPE, OKF_REQUIRED]);

function verificationEntry(quads: Quad[], ctx: ExportContext): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const q of quads) {
    if (q.predicate === OKF_VERIFIED_BY) entry.by = termValue(q.object, ctx);
    else if (q.predicate === OKF_VERIFIED_AT) entry.at = termValue(q.object, ctx);
  }
  return orderKeys({ ...entry, ...nodeExtras(quads, VERIFICATION_PREDICATES, ctx) }, ['by', 'at']);
}

function usageWindow(quads: Quad[], ctx: ExportContext): Record<string, unknown> | null {
  const w: Record<string, unknown> = {};
  for (const q of quads) {
    if (q.predicate === OKF_USAGE_WINDOW_FROM) w.from = termValue(q.object, ctx);
    else if (q.predicate === OKF_USAGE_WINDOW_TO) w.to = termValue(q.object, ctx);
  }
  return Object.keys(w).length > 0 ? orderKeys(w, ['from', 'to']) : null;
}

function sourceEntry(quads: Quad[], ctx: ExportContext): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const q of quads) {
    switch (q.predicate) {
      case SCHEMA_IDENTIFIER:
        entry.id = termValue(q.object, ctx);
        break;
      case OKF_RESOURCE:
        entry.resource = termValue(q.object, ctx, true);
        break;
      case SCHEMA_NAME:
        entry.title = termValue(q.object, ctx);
        break;
      case OKF_AUTHOR:
        entry.author = termValue(q.object, ctx);
        break;
      case OKF_USAGE_COUNT:
        entry.usage_count = termValue(q.object, ctx);
        break;
      case SCHEMA_DATE_MODIFIED:
        entry.last_modified = termValue(q.object, ctx);
        break;
    }
  }
  const window = usageWindow(quads, ctx);
  if (window) entry.usage_window = window;
  return orderKeys({ ...entry, ...nodeExtras(quads, SOURCE_PREDICATES, ctx) }, [
    'id',
    'resource',
    'title',
    'author',
    'usage_count',
    'last_modified',
    'usage_window',
  ]);
}

function parameterEntry(quads: Quad[], ctx: ExportContext): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const q of quads) {
    if (q.predicate === SCHEMA_NAME) entry.name = termValue(q.object, ctx);
    else if (q.predicate === OKF_PARAMETER_TYPE) entry.type = termValue(q.object, ctx);
    else if (q.predicate === OKF_REQUIRED) entry.required = termValue(q.object, ctx);
  }
  return orderKeys({ ...entry, ...nodeExtras(quads, PARAMETER_PREDICATES, ctx) }, ['name', 'type', 'required']);
}

function reconstructConcept(c: ExportInput['concepts'][number], ctx: ExportContext): BundleFile {
  const { iriBase } = ctx;
  const bySubject = new Map<string, Quad[]>();
  for (const q of c.quads) {
    if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
    bySubject.get(q.subject)!.push(q);
  }
  const nodeQuads = (node: string): Quad[] => bySubject.get(node) ?? [];

  const frontmatter: Record<string, unknown> = {};
  const tags: string[] = [];
  const edges: string[] = [];
  const citations: string[] = [];
  const extras: Record<string, unknown> = {};

  let generatedBy: unknown = null;
  let dateModified: unknown = null;
  const generatedExtras: Record<string, unknown> = {};
  const verificationNodes: string[] = [];
  const sourceNodes: string[] = [];
  const parameterNodes: string[] = [];
  const executor: Record<string, unknown> = {};
  const receipt: string[] = [];
  const attester: Record<string, unknown> = {};
  let usageFrom: unknown = null;
  let usageTo: unknown = null;

  for (const q of bySubject.get(c.iri) ?? []) {
    switch (q.predicate) {
      case RDF_TYPE:
        frontmatter.type = typeValue(q.object);
        break;
      case SCHEMA_NAME:
        frontmatter.title = literalValue(q.object) ?? q.object;
        break;
      case SCHEMA_DESCRIPTION:
        frontmatter.description = literalValue(q.object) ?? q.object;
        break;
      case SCHEMA_URL:
        frontmatter.resource = q.object;
        break;
      case SCHEMA_DATE_MODIFIED:
        dateModified = termValue(q.object, ctx);
        break;
      case SCHEMA_KEYWORDS: {
        const v = literalValue(q.object);
        if (v !== null) tags.push(v);
        break;
      }
      case SCHEMA_MENTIONS:
      case SCHEMA_HAS_PART: {
        // Both are cross-concept edges → reconstruct as body links. OKF links are
        // untyped (SPEC §6.1), so a typed relation (e.g. hasPart) deliberately
        // exports as a plain link; the DKG-side typing is not OKF-expressible.
        const id = conceptIdFromIri(q.object, iriBase);
        if (id) edges.push(id);
        break;
      }
      case SCHEMA_IS_PART_OF:
        break; // folder hierarchy is implied by the concept path
      case SCHEMA_CITATION:
        citations.push(literalValue(q.object) ?? q.object);
        break;
      case OKF_GENERATED_BY:
        generatedBy = termValue(q.object, ctx);
        break;
      case OKF_VERIFICATION:
        verificationNodes.push(q.object);
        break;
      case OKF_SOURCE:
        sourceNodes.push(q.object);
        break;
      case OKF_PARAMETER:
        parameterNodes.push(q.object);
        break;
      case OKF_TRUST_TIER:
      case PROV_WAS_DERIVED_FROM:
        break; // derived at import; re-derived on the next import
      case OKF_STATUS:
        frontmatter.status = termValue(q.object, ctx);
        break;
      case OKF_STALE_AFTER:
        frontmatter.stale_after = termValue(q.object, ctx);
        break;
      case OKF_USAGE_WINDOW_FROM:
        usageFrom = termValue(q.object, ctx);
        break;
      case OKF_USAGE_WINDOW_TO:
        usageTo = termValue(q.object, ctx);
        break;
      case OKF_RUNTIME:
        frontmatter.runtime = termValue(q.object, ctx);
        break;
      case OKF_COMPUTATION:
        frontmatter.computation = termValue(q.object, ctx, true);
        break;
      case OKF_EXECUTOR_RESOURCE:
        executor.resource = termValue(q.object, ctx, true);
        break;
      case OKF_EXECUTOR_RECEIPT:
        receipt.push(String(termValue(q.object, ctx)));
        break;
      case OKF_ATTESTER_RESOURCE:
        attester.resource = termValue(q.object, ctx, true);
        break;
      default: {
        if (q.predicate.startsWith(OKF_GENERATED_PREFIX)) {
          accumulate(generatedExtras, lowerFirst(q.predicate.slice(OKF_GENERATED_PREFIX.length)), termValue(q.object, ctx));
        } else if (q.predicate.startsWith(OKF_EXECUTOR_PREFIX)) {
          accumulate(executor, lowerFirst(q.predicate.slice(OKF_EXECUTOR_PREFIX.length)), termValue(q.object, ctx));
        } else if (q.predicate.startsWith(OKF_ATTESTER_PREFIX)) {
          accumulate(attester, lowerFirst(q.predicate.slice(OKF_ATTESTER_PREFIX.length)), termValue(q.object, ctx));
        } else if (q.predicate.startsWith(SCHEMA_NS) && !CONCEPT_PREDICATES.has(q.predicate)) {
          // Producer-defined key: typed scalars and rdf:JSON objects come back
          // as native values so the datatype / structure survives re-import.
          accumulate(extras, q.predicate.slice(SCHEMA_NS.length), termValue(q.object, ctx));
        }
      }
    }
  }
  if (tags.length > 0) frontmatter.tags = tags;

  // Attested Computation contract (§10.2).
  if (parameterNodes.length > 0) {
    frontmatter.parameters = parameterNodes.sort(byNodeIndex).map((n) => parameterEntry(nodeQuads(n), ctx));
  }
  if (receipt.length > 0) executor.receipt = [...receipt].sort();
  if (Object.keys(executor).length > 0) frontmatter.executor = orderKeys(executor, ['resource', 'receipt']);
  if (Object.keys(attester).length > 0) frontmatter.attester = orderKeys(attester, ['resource']);

  // Trust (§5.2): `generated` needs a `by`; a bare last-modified time (a v0.1
  // import) is written with the legacy `timestamp` key instead (§13.1).
  if (generatedBy !== null || Object.keys(generatedExtras).length > 0) {
    const generated: Record<string, unknown> = {};
    if (generatedBy !== null) generated.by = generatedBy;
    if (dateModified !== null) generated.at = dateModified;
    frontmatter.generated = orderKeys({ ...generated, ...generatedExtras }, ['by', 'at']);
  } else if (dateModified !== null) {
    frontmatter.timestamp = dateModified;
  }
  if (verificationNodes.length > 0) {
    frontmatter.verified = verificationNodes.sort(byNodeIndex).map((n) => verificationEntry(nodeQuads(n), ctx));
  }
  // Provenance (§5.1).
  if (sourceNodes.length > 0) {
    frontmatter.sources = sourceNodes.sort(byNodeIndex).map((n) => sourceEntry(nodeQuads(n), ctx));
  }
  if (usageFrom !== null || usageTo !== null) {
    const w: Record<string, unknown> = {};
    if (usageFrom !== null) w.from = usageFrom;
    if (usageTo !== null) w.to = usageTo;
    frontmatter.usage_window = w;
  }
  Object.assign(frontmatter, extras);

  // Stable key order: required/recommended, then the §10 contract, then the §5
  // families (SPEC §4.1 / Appendix A order), then producer extras.
  const ordered = orderKeys(frontmatter, [
    'type',
    'resource',
    'title',
    'description',
    'tags',
    'runtime',
    'parameters',
    'computation',
    'executor',
    'attester',
    'generated',
    'timestamp',
    'verified',
    'status',
    'stale_after',
    'sources',
    'usage_window',
  ]);

  const yaml = dumpYaml(ordered, { sortKeys: false, lineWidth: -1 }).trimEnd();

  const bodyParts: string[] = [];
  const uniqueEdges = [...new Set(edges)].sort();
  if (uniqueEdges.length > 0) {
    bodyParts.push('# Related', '');
    for (const id of uniqueEdges) bodyParts.push(`* [${id}](/${id}.md)`);
    bodyParts.push('');
  }
  if (citations.length > 0) {
    bodyParts.push('# Citations', '');
    citations.forEach((url, i) => bodyParts.push(`[${i + 1}] [${url}](${url})`));
    bodyParts.push('');
  }

  return {
    path: `${c.conceptId}.md`,
    content: `---\n${yaml}\n---\n\n${bodyParts.join('\n')}`,
  };
}

/**
 * Regenerate a directory `index.md` listing immediate child concepts/subdirs
 * (SPEC §8). The bundle-root index declares the OKF version this exporter
 * writes (§12) — the only frontmatter an `index.md` may carry.
 */
function regenerateIndexes(conceptIds: string[]): BundleFile[] {
  const childrenByDir = new Map<string, Set<string>>();
  const add = (dir: string, entry: string) => {
    if (!childrenByDir.has(dir)) childrenByDir.set(dir, new Set());
    childrenByDir.get(dir)!.add(entry);
  };
  for (const id of conceptIds) {
    const parts = id.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const isLeaf = i === parts.length - 1;
      add(dir, isLeaf ? `concept:${parts[i]}.md` : `dir:${parts[i]}`);
    }
  }
  const files: BundleFile[] = [];
  for (const [dir, entries] of [...childrenByDir.entries()].sort()) {
    const lines = dir ? [] : [`---`, `okf_version: "${OKF_TARGET_VERSION}"`, `---`, ''];
    lines.push('# Index', '');
    for (const e of [...entries].sort()) {
      if (e.startsWith('concept:')) {
        const name = e.slice('concept:'.length);
        lines.push(`* [${name.replace(/\.md$/, '')}](${name})`);
      } else {
        const name = e.slice('dir:'.length);
        lines.push(`* [${name}](${name}/index.md)`);
      }
    }
    lines.push('');
    files.push({ path: dir ? `${dir}/index.md` : 'index.md', content: lines.join('\n') });
  }
  return files;
}

/** Serialise imported concepts back into a conformant OKF v0.2 `BundleFile[]`. */
export function exportBundle(input: ExportInput, opts: OkfMappingOptions = {}): BundleFile[] {
  const ctx: ExportContext = {
    iriBase: opts.iriBase ?? DEFAULT_IRI_BASE,
    conceptIris: new Set(input.concepts.map((c) => c.iri)),
  };
  const concepts = input.concepts.map((c) => reconstructConcept(c, ctx));
  const indexes = regenerateIndexes(input.concepts.map((c) => c.conceptId));
  return [...concepts, ...indexes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
