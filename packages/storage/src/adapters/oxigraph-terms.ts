// SPDX-License-Identifier: Apache-2.0
import oxigraph from 'oxigraph';
import { formatCanonicalRdfTerm, parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad as DKGQuad } from '../triple-store.js';

export function parseTerm(term: string): oxigraph.NamedNode | oxigraph.Literal | oxigraph.BlankNode {
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

export function toOxQuad(q: DKGQuad): oxigraph.Quad | null {
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

export function fromOxQuad(oxq: oxigraph.Quad): DKGQuad {
  return {
    subject: termToString(oxq.subject),
    predicate: oxq.predicate.value,
    object: termToString(oxq.object),
    graph:
      oxq.graph.termType === 'DefaultGraph' ? '' : oxq.graph.value,
  };
}

export function termToString(t: oxigraph.Term): string {
  return formatCanonicalRdfTerm(t);
}

