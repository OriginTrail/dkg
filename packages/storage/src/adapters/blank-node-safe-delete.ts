/**
 * Blank-node-safe DELETE for the SPARQL-over-HTTP adapters (sparql-http and
 * blazegraph), which both remove quads with a SPARQL UPDATE.
 */
import type { Quad as DKGQuad } from '../triple-store.js';
import type { SparqlTermRenderer } from './sparql-term-policy.js';

/** True when an N-Quads term string denotes an RDF blank node (`_:label`). */
export function isBlankNodeTerm(term: string): boolean {
  return typeof term === 'string' && term.startsWith('_:');
}

/**
 * Partition blank-node-bearing quads into connected components: two quads are
 * connected when they share a blank-node label (directly or transitively). A
 * union-find over the blank-node labels does the grouping.
 *
 * Each component is later deleted as ONE `DELETE … WHERE …` so its shared
 * blank-node variables join correctly and any ground terms anchor the match.
 * Disjoint components must be emitted as SEPARATE statements: a single WHERE
 * holding two independent patterns is a cross-product, so if one pattern has
 * no match the whole row is empty and NOTHING is deleted — a silent
 * data-retention bug. Splitting by component avoids that.
 */
function connectedBlankNodeComponents(quads: DKGQuad[]): DKGQuad[][] {
  const parent = new Map<string, string>();
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!); // path halving
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => { parent.set(find(a), find(b)); };

  for (const q of quads) {
    const labels: string[] = [];
    if (isBlankNodeTerm(q.subject)) labels.push(q.subject);
    if (isBlankNodeTerm(q.object)) labels.push(q.object);
    labels.forEach(add);
    if (labels.length === 2) union(labels[0], labels[1]);
  }

  const groups = new Map<string, DKGQuad[]>();
  for (const q of quads) {
    const label = isBlankNodeTerm(q.subject) ? q.subject : q.object;
    const root = find(label);
    let arr = groups.get(root);
    if (!arr) { arr = []; groups.set(root, arr); }
    arr.push(q);
  }
  return [...groups.values()];
}

/**
 * Build a spec-legal SPARQL Update that deletes exactly `quads`, including any
 * whose subject or object is a blank node. Returns `null` for empty input.
 *
 * Strategy:
 *  - Ground quads (no blank nodes) → a single `DELETE DATA { … }` block —
 *    exact and fast (identical to the legacy behaviour for the common case).
 *  - Blank-node quads → grouped into connected components ({@link
 *    connectedBlankNodeComponents}); each component becomes a
 *    `DELETE { … } WHERE { … }` with every blank node rewritten to a fresh
 *    query variable. This is the only spec-legal way to remove existing
 *    blank-node structure over the SPARQL protocol (`DELETE DATA` forbids
 *    blank nodes outright).
 *
 * Caveat (inherent to SPARQL): a blank node has no stable name across the
 * protocol, so a component is matched by *shape* + ground anchors, not
 * identity. A truly isolated blank-node triple with no ground anchor (e.g. a
 * lone `_:b <p> <o>`) matches every subject with that predicate/object; in
 * practice such triples are part of a larger entity component anchored by a
 * real IRI, so the match is precise. Two byte-for-byte isomorphic anchored
 * components are indistinguishable in RDF and both delete — which is correct.
 *
 * Every term is rendered by `render`, which tells its observer about each
 * invalid one, a blank-node label that becomes a variable included.
 * `sparqlStatements(...).deleteData` passes a reporting renderer; the
 * deprecated `buildBlankNodeSafeDelete` in `sparql-http.ts` passes one that
 * ignores them.
 */
export function renderBlankNodeSafeDelete(
  quads: DKGQuad[],
  render: SparqlTermRenderer,
): string | null {
  if (quads.length === 0) return null;

  const ground: DKGQuad[] = [];
  const bnode: DKGQuad[] = [];
  for (const q of quads) {
    if (isBlankNodeTerm(q.subject) || isBlankNodeTerm(q.object)) bnode.push(q);
    else ground.push(q);
  }

  const statements: string[] = [];

  if (ground.length > 0) {
    const body = ground.map((q) => {
      const g = q.graph ? `GRAPH ${render.iri(q.graph, 'graph')} ` : '';
      return `${g}{ ${render.rdf(q.subject, 'subject', 'reject')} ${render.iri(q.predicate, 'predicate')} ${render.rdf(q.object, 'object', 'reject')} . }`;
    }).join('\n');
    statements.push(`DELETE DATA {\n${body}\n}`);
  }

  if (bnode.length > 0) {
    // Group by graph first — never join components across graphs.
    const byGraph = new Map<string, DKGQuad[]>();
    for (const q of bnode) {
      const g = q.graph || '';
      let arr = byGraph.get(g);
      if (!arr) { arr = []; byGraph.set(g, arr); }
      arr.push(q);
    }
    for (const [graph, list] of byGraph) {
      for (const component of connectedBlankNodeComponents(list)) {
        const vars = new Map<string, string>();
        const renderTerm = (t: string, position: 'subject' | 'object'): string => {
          if (!isBlankNodeTerm(t)) return render.rdf(t, position, 'reject');
          let v = vars.get(t);
          if (!v) {
            // The label is never sent, but a malformed one is still an invalid
            // term: render it once, only to check it, before it becomes a variable.
            render.rdf(t, position, 'allow');
            v = `?b${vars.size}`;
            vars.set(t, v);
          }
          return v;
        };
        const triples = component
          .map((q) => `${renderTerm(q.subject, 'subject')} ${render.iri(q.predicate, 'predicate')} ${renderTerm(q.object, 'object')} .`)
          .join('\n    ');
        const inner = graph
          ? `GRAPH ${render.iri(graph, 'graph')} {\n    ${triples}\n  }`
          : triples;
        statements.push(`DELETE { ${inner} } WHERE { ${inner} }`);
      }
    }
  }

  return statements.join(';\n');
}
