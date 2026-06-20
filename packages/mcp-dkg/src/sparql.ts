/**
 * Tiny helpers shared across tool implementations:
 *   - SPARQL literal escaping (copy of the core helper so this package
 *     stays dependency-free beyond the MCP SDK).
 *   - Common prefix map used everywhere in the V10 ontology.
 *   - Markdown renderers for SPARQL bindings.
 */
import type { SparqlBinding, SparqlProvenance } from './client.js';
import { bindingValue } from './client.js';

// Re-export so tool code can pull everything it needs from one module.
export { bindingValue } from './client.js';

export const NS = {
  rdf:       'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:      'http://www.w3.org/2000/01/rdf-schema#',
  schema:    'http://schema.org/',
  dcterms:   'http://purl.org/dc/terms/',
  prov:      'http://www.w3.org/ns/prov#',
  code:      'http://dkg.io/ontology/code/',
  github:    'http://dkg.io/ontology/github/',
  decisions: 'http://dkg.io/ontology/decisions/',
  tasks:     'http://dkg.io/ontology/tasks/',
  profile:   'http://dkg.io/ontology/profile/',
  agent:     'http://dkg.io/ontology/agent/',
  chat:      'http://dkg.io/ontology/chat/',
} as const;

/** All namespace prefixes, SPARQL-syntax. */
export const PREFIXES = Object.entries(NS)
  .map(([p, iri]) => `PREFIX ${p}: <${iri}>`)
  .join('\n');

/** Strip bracket wrappers, known namespace prefixes, and datatype suffixes. */
export function prettyTerm(raw: string): string {
  if (!raw) return '';
  let v = raw;
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
  // Typed literal → just the value
  const typed = v.match(/^"(.*)"\^\^<.+>$/s);
  if (typed) return typed[1];
  // Lang-tagged literal
  const langged = v.match(/^"(.*)"@[a-zA-Z0-9-]+$/s);
  if (langged) return langged[1];
  // Plain quoted literal
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  // Shorten well-known namespaces
  for (const [prefix, iri] of Object.entries(NS)) {
    if (v.startsWith(iri)) return `${prefix}:${v.slice(iri.length)}`;
  }
  return v;
}

export function escapeSparqlLiteral(s: string): string {
  // Defensive: strip null bytes BEFORE other escapes. SPARQL engines
  // (oxigraph et al.) reject null bytes outright today, so this is
  // pure hardening — guards against a future engine swap or any
  // truncate-at-null-byte parsing path that would silently change
  // query semantics. Pre-other-escapes ordering means a literal
  // backslash followed by null collapses to backslash only, not a
  // doubled backslash + dropped null.
  return s
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Markdown table from SPARQL bindings, with pretty-printed terms. */
export function bindingsToTable(bindings: SparqlBinding[], columns?: string[]): string {
  if (!bindings.length) return '(no results)';
  const cols = columns ?? Object.keys(bindings[0]);
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = bindings.map((row) =>
    '| ' + cols.map((c) => prettyTerm(bindingValue(row[c]))).join(' | ') + ' |',
  );
  return [header, sep, ...rows].join('\n');
}

/**
 * Render the verifiable sources behind a result set as a compact, deduplicated
 * markdown list. `provenance` is aligned 1:1 with the rows it describes; rows
 * sharing a source collapse to one entry. Each line cites the on-chain KA
 * identity `(author/kaNumber)` when the source is a per-KA partition, plus the
 * raw source graph so the caller can always resolve it.
 */
export function renderProvenanceSources(provenance: SparqlProvenance[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of provenance) {
    if (!p?.sourceGraph || seen.has(p.sourceGraph)) continue;
    seen.add(p.sourceGraph);
    const id =
      p.author && p.kaNumber
        ? `KA \`${p.author}/${p.kaNumber}\`${p.memoryLayer ? ` (${p.memoryLayer})` : ''}`
        : p.memoryLayer ?? 'source';
    lines.push(`- ${id} — \`${p.sourceGraph}\``);
  }
  if (!lines.length) return '';
  return `\n\n**Sources** (verifiable provenance):\n${lines.join('\n')}`;
}

/** Multi-line markdown summary per binding — better than a wide table for
 *  entities with long property lists. */
export function bindingsToParagraphs(bindings: SparqlBinding[]): string {
  if (!bindings.length) return '(no results)';
  return bindings
    .map((row, i) => {
      const lines = Object.entries(row).map(
        ([k, v]) => `  - **${k}**: ${prettyTerm(bindingValue(v))}`,
      );
      return `### ${i + 1}.\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

