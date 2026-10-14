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
 * This module rebuilds the base fields, body and indexes; the v0.2 families
 * are rebuilt by `families/decode.ts` from the same definitions the importer
 * encodes with, in the entry order baked into the node IRIs. A last-modified
 * time comes back under the key it was written with (a v0.1 import's legacy
 * `timestamp`, a `generated.at`): each value on `schema:dateModified` names
 * its owner (`families/generated.ts`), so no `generated` actor (§5.2) is ever
 * invented for a time.
 *
 * Pure: `exportBundle` consumes an `ExportInput` and returns `BundleFile[]`.
 * `exportInputFromQuads` builds that input from a graph's quads — the
 * `dkg okf export` command feeds it the quads of a Context Graph view.
 */

import { dump as dumpYaml } from 'js-yaml';
import { OKF_YAML_SCHEMA } from './document.js';
import {
  RDF_TYPE,
  SCHEMA_NS,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_IS_PART_OF,
  SCHEMA_URL,
  SCHEMA_CITATION,
  OKF_ATTESTED_COMPUTATION_TYPE,
  OKF_TARGET_VERSION,
  SECTION_GENID_INFIX,
  DEFAULT_IRI_BASE,
} from './constants.js';
import { conceptIdFromIri, literalValue, orderKeys, termValue, ValueBuckets, type ExportContext } from './decode-terms.js';
import { decodeFamilies } from './families/decode.js';
import { readsAsProducerKey } from './mapping.js';
import { dict, distinctTriples, pascalCase } from './utils.js';
import type { BundleFile, ExportInput, OkfMappingOptions, Quad } from './types.js';

/**
 * Spec-defined type names whose exact spelling carries meaning for consumers
 * (§10.5 discovery is by `type: Attested Computation`). A Map, so a local name
 * like `toString` or `constructor` never reads an inherited property.
 */
const SPEC_TYPE_NAMES: ReadonlyMap<string, string> = new Map([['AttestedComputation', OKF_ATTESTED_COMPUTATION_TYPE]]);

/**
 * Map an rdf:type object IRI back to a writable `type` value. A `schema:`
 * local name is written bare only when importing it bare gives the same IRI
 * back (the importer PascalCases a bare `type`); otherwise — `schema:toString`,
 * `schema:foo-bar`, which only a full-IRI `type` can produce — the full IRI is
 * written, so the type round-trips. Producer spacing (`BigQuery Table`) is not
 * recoverable and comes back as `BigQueryTable`, which maps to the same IRI.
 */
function typeValue(object: string): string {
  if (!object.startsWith(SCHEMA_NS)) return object;
  const local = object.slice(SCHEMA_NS.length);
  const special = SPEC_TYPE_NAMES.get(local);
  if (special !== undefined) return special;
  return local !== '' && pascalCase(local) === local ? local : object;
}

/**
 * Base fields read on the concept subject. The family decoder reads its own
 * quads (the `generated.at` and legacy `timestamp` values on
 * `schema:dateModified` among them); any other `schema:` predicate is a
 * producer key.
 */
const CONCEPT_PREDICATES = new Set([
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_IS_PART_OF,
  SCHEMA_URL,
  SCHEMA_CITATION,
]);

/**
 * Frontmatter key order: required/recommended, then the §10 contract, then the
 * §5 families (SPEC §4.1 / Appendix A order). Producer keys follow.
 */
const CONCEPT_KEY_ORDER = [
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
];

/** The IRI `emitFolderHierarchy` gives a nested concept's parent directory, or `null` at the bundle root. */
function parentDirectoryIri(conceptId: string, iriBase: string): string | null {
  const slash = conceptId.lastIndexOf('/');
  return slash === -1 ? null : `${iriBase}${conceptId.slice(0, slash)}`;
}

/** `sources` → `Sources`: camelCase reads it back as the same `schema:` predicate. */
function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Total order on triples: subject, then predicate, then object term. */
function byTriple(a: Quad, b: Quad): number {
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
  if (a.predicate !== b.predicate) return a.predicate < b.predicate ? -1 : 1;
  return a.object < b.object ? -1 : a.object > b.object ? 1 : 0;
}

function reconstructConcept(c: ExportInput['concepts'][number], ctx: ExportContext): BundleFile {
  const bySubject = new Map<string, Quad[]>();
  // The graph is a set: a repeated triple is one triple, and the triples are
  // read in a canonical order, so the bundle depends only on which triples
  // the graph holds — never on the order a store happens to return them. That
  // orders every collection RDF keeps no order for (producer keys, extension
  // keys, tags, citations, values from several triples on one key) and makes
  // a single-valued field that holds two values pick the same one every time.
  // Family entries keep their order through the node index, family fields
  // their definition order, and a value kept verbatim as one JSON literal its
  // own internal order.
  for (const q of distinctTriples(c.quads).sort(byTriple)) {
    if (!bySubject.has(q.subject)) bySubject.set(q.subject, []);
    bySubject.get(q.subject)!.push(q);
  }
  const conceptQuads = bySubject.get(c.iri) ?? [];
  // The families read their own quads, a value kept verbatim and the legacy
  // `timestamp` included; every other quad is a base field or a producer key.
  const families = decodeFamilies(conceptQuads, (node) => bySubject.get(node) ?? [], ctx);

  // Dictionaries: producer keys are arbitrary (`constructor`, `__proto__`).
  const frontmatter = dict();
  const tags: string[] = [];
  const edges: string[] = [];
  const citations: string[] = [];
  const extras = new ValueBuckets();

  for (const q of conceptQuads) {
    if (families.consumed.has(q)) continue;
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
        // An IRI as written; a resource that is not an IRI was stored as a
        // literal, so write its value (not the quoted term) back.
        frontmatter.resource = termValue(q.object, ctx);
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
        const id = conceptIdFromIri(q.object, ctx.iriBase);
        if (id) edges.push(id);
        break;
      }
      case SCHEMA_IS_PART_OF:
        // An export told the graph was imported with `emitFolderHierarchy`
        // omits the edge to the concept's own parent directory, which the path
        // implies and the option re-derives. Any other value, that same edge
        // included when the option is off, is a producer key (`isPartOf: …`)
        // and is kept: matching the parent's IRI alone does not make it inferred.
        if (!ctx.folderHierarchy || q.object !== parentDirectoryIri(c.conceptId, ctx.iriBase)) {
          extras.add(q.predicate.slice(SCHEMA_NS.length), termValue(q.object, ctx));
        }
        break;
      case SCHEMA_CITATION:
        citations.push(literalValue(q.object) ?? q.object);
        break;
      default:
        if (q.predicate.startsWith(SCHEMA_NS) && !CONCEPT_PREDICATES.has(q.predicate)) {
          // Producer-defined key: typed scalars and rdf:JSON objects come back
          // as native values so the datatype / structure survives re-import.
          extras.add(q.predicate.slice(SCHEMA_NS.length), termValue(q.object, ctx));
        }
      // okf:* family predicates were read by the family decoder; derived triples are not read back.
    }
  }
  if (tags.length > 0) frontmatter.tags = tags;

  Object.assign(frontmatter, families.frontmatter);
  // A producer value is written back under a key the importer reads as a
  // producer key on the same predicate: the predicate's local name, or, where
  // the importer reads that name as a base field or a family (`Sources`
  // beside `sources`, a lone `Status`, `Type`), the name capitalised, which
  // camelCase reads back as the same predicate. The base field or family
  // keeps its key, and neither value replaces the other.
  for (const [name, value] of Object.entries(extras.toDict())) {
    frontmatter[readsAsProducerKey(name, frontmatter) ? name : capitalised(name)] = value;
  }

  const ordered = orderKeys(frontmatter, CONCEPT_KEY_ORDER);

  // The OKF schema writes a typed date read back as a `Date` unquoted, exactly as stored.
  const yaml = dumpYaml(ordered, { schema: OKF_YAML_SCHEMA, sortKeys: false, lineWidth: -1 }).trimEnd();

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
    folderHierarchy: opts.emitFolderHierarchy === true,
  };
  const concepts = input.concepts.map((c) => reconstructConcept(c, ctx));
  const indexes = regenerateIndexes(input.concepts.map((c) => c.conceptId));
  return [...concepts, ...indexes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Rebuild the exporter's input from the quads of a graph (e.g. every subject
 * under `iriBase` in one Context Graph view), in any order.
 *
 * Repeated triples (the same triple read from several named graphs) count
 * once. A concept is a subject under `iriBase` that carries an `rdf:type`. A
 * skolemized node (`<conceptIri>/.well-known/genid/…`: a body section, or a
 * v0.2 verification / source / parameter entry) belongs to the concept its IRI
 * starts with and is attached to it, so the families can be rebuilt; it is
 * never itself a concept, which would otherwise export as a stray
 * `.well-known/genid/*.md` file. This is the package's own reading of the IRI
 * layout the importer mints, so graph consumers need not reproduce it.
 */
export function exportInputFromQuads(quads: readonly Quad[], opts: Pick<OkfMappingOptions, 'iriBase'> = {}): ExportInput {
  const iriBase = opts.iriBase ?? DEFAULT_IRI_BASE;
  const rootQuads = new Map<string, Quad[]>();
  const nodeQuadsByOwner = new Map<string, Quad[]>();
  // The same triple from several named graphs (overlapping sub-graphs) is one triple.
  for (const q of distinctTriples(quads)) {
    const infixAt = q.subject.indexOf(SECTION_GENID_INFIX);
    const target = infixAt === -1 ? rootQuads : nodeQuadsByOwner;
    const key = infixAt === -1 ? q.subject : q.subject.slice(0, infixAt);
    if (!target.has(key)) target.set(key, []);
    target.get(key)!.push(q);
  }
  const concepts: ExportInput['concepts'] = [...rootQuads.entries()]
    .filter(([iri, qs]) => iri.startsWith(iriBase) && qs.some((q) => q.predicate === RDF_TYPE))
    .map(([iri, qs]) => ({
      conceptId: iri.slice(iriBase.length),
      iri,
      quads: [...qs, ...(nodeQuadsByOwner.get(iri) ?? [])],
    }));
  return { concepts };
}
