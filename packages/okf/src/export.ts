/**
 * The clean inverse of the importer (ADR 0005): reconstruct a conformant OKF
 * bundle from imported Knowledge Assets. Designed so that
 *
 *   import(bundle) → exportBundle(...) → import(...)
 *
 * reproduces an *equivalent graph* (same concepts, frontmatter triples, untyped
 * edges and citations). It is graph-faithful, not byte-faithful: free-form prose
 * is not recoverable from triples, so bodies are regenerated structurally (a
 * `# Related` section of links + a `# Citations` section). Section headings from
 * the original body are presentational and are not reconstructed — round-trip
 * equivalence is asserted over the semantic (non-`hasSection`) quad set.
 *
 * This module is pure: it consumes a `BundleImport` and returns `BundleFile[]`.
 * The `dkg okf export` command feeds it quads fetched from a Context Graph via
 * SPARQL; the same function powers the offline round-trip test.
 */

import { dump as dumpYaml } from 'js-yaml';
import {
  RDF_TYPE,
  SCHEMA_NS,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_URL,
  SCHEMA_CITATION,
  XSD_INTEGER,
  XSD_DECIMAL,
  XSD_BOOLEAN,
  DEFAULT_IRI_BASE,
} from './constants.js';
import type { BundleFile, BundleImport, ConceptMapping, OkfMappingOptions } from './types.js';

const LITERAL_RE = /^("(?:\\.|[^"\\])*")(?:\^\^<[^>]*>|@[A-Za-z-]+)?$/;
const TYPED_LITERAL_RE = /^("(?:\\.|[^"\\])*")\^\^<([^>]*)>$/;

/** Lexical value of a literal term, or `null` if the term is an IRI / blank node. */
function literalValue(term: string): string | null {
  if (!term.startsWith('"')) return null;
  const m = term.match(LITERAL_RE);
  if (!m) return null;
  return JSON.parse(m[1]) as string;
}

/**
 * Recover the native JS value of a known typed scalar literal so producer-defined
 * numeric/boolean keys survive the round-trip. Import maps `count: 3` →
 * `"3"^^xsd:integer`; without this, export would emit YAML string `"3"`, which
 * re-imports as a plain string literal (datatype lost). Returns `null` for
 * unknown datatypes / plain literals so callers fall back to lexical handling.
 */
function typedScalarValue(term: string): number | boolean | null {
  const m = term.match(TYPED_LITERAL_RE);
  if (!m) return null;
  const lexical = JSON.parse(m[1]) as string;
  switch (m[2]) {
    case XSD_INTEGER: {
      const n = Number(lexical);
      return Number.isInteger(n) ? n : null;
    }
    case XSD_DECIMAL: {
      const n = Number(lexical);
      return Number.isFinite(n) ? n : null;
    }
    case XSD_BOOLEAN:
      return lexical === 'true' ? true : lexical === 'false' ? false : null;
    default:
      return null;
  }
}

/** Map an rdf:type object IRI back to a writable `type` value. */
function typeValue(object: string): string {
  return object.startsWith(SCHEMA_NS) ? object.slice(SCHEMA_NS.length) : object;
}

function conceptIdFromIri(iri: string, iriBase: string): string | null {
  return iri.startsWith(iriBase) ? iri.slice(iriBase.length) : null;
}

const KNOWN_PREDICATES = new Set([
  RDF_TYPE,
  SCHEMA_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_KEYWORDS,
  SCHEMA_MENTIONS,
  SCHEMA_HAS_PART,
  SCHEMA_DATE_MODIFIED,
  SCHEMA_URL,
  SCHEMA_CITATION,
]);

function reconstructConcept(c: ConceptMapping, iriBase: string): BundleFile {
  const frontmatter: Record<string, unknown> = {};
  const tags: string[] = [];
  const edges: string[] = [];
  const citations: string[] = [];
  const extras: Record<string, unknown> = {};

  for (const q of c.quads) {
    if (q.subject !== c.iri) continue; // skip section nodes (skolemized genid subjects)
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
        frontmatter.timestamp = literalValue(q.object) ?? q.object;
        break;
      case SCHEMA_KEYWORDS: {
        const v = literalValue(q.object);
        if (v !== null) tags.push(v);
        break;
      }
      case SCHEMA_MENTIONS:
      case SCHEMA_HAS_PART: {
        // Both are cross-concept edges → reconstruct as body links. OKF links are
        // untyped (SPEC §5.3), so a typed relation (e.g. hasPart) deliberately
        // exports as a plain link; the DKG-side typing is not OKF-expressible.
        const id = conceptIdFromIri(q.object, iriBase);
        if (id) edges.push(id);
        break;
      }
      case SCHEMA_CITATION:
        citations.push(literalValue(q.object) ?? q.object);
        break;
      default: {
        if (q.predicate.startsWith(SCHEMA_NS) && !KNOWN_PREDICATES.has(q.predicate)) {
          const key = q.predicate.slice(SCHEMA_NS.length);
          // Preserve known typed scalars (integer/decimal/boolean) as native
          // values so the datatype survives re-import; else fall back to lexical.
          const scalar = typedScalarValue(q.object);
          const v = scalar !== null ? scalar : (literalValue(q.object) ?? q.object);
          if (key in extras) {
            const cur = extras[key];
            extras[key] = Array.isArray(cur) ? [...cur, v] : [cur, v];
          } else {
            extras[key] = v;
          }
        }
      }
    }
  }
  if (tags.length > 0) frontmatter.tags = tags;
  Object.assign(frontmatter, extras);

  // Stable key order: required/recommended first, then producer extras.
  const order = ['type', 'resource', 'title', 'description', 'tags', 'timestamp'];
  const ordered: Record<string, unknown> = {};
  for (const k of order) if (k in frontmatter) ordered[k] = frontmatter[k];
  for (const k of Object.keys(frontmatter)) if (!(k in ordered)) ordered[k] = frontmatter[k];

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

/** Regenerate a directory `index.md` listing immediate child concepts/subdirs (SPEC §6). */
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
    const lines = ['# Index', ''];
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

/** Serialise an imported bundle back into a conformant OKF `BundleFile[]`. */
export function exportBundle(imported: BundleImport, opts: OkfMappingOptions = {}): BundleFile[] {
  const iriBase = opts.iriBase ?? DEFAULT_IRI_BASE;
  const concepts = imported.concepts.map((c) => reconstructConcept(c, iriBase));
  const indexes = regenerateIndexes(imported.concepts.map((c) => c.conceptId));
  return [...concepts, ...indexes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
