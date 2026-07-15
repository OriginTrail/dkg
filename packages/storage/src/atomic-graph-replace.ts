import { randomUUID } from 'node:crypto';
import {
  assertSafeIri,
  assertSafeRdfTerm,
} from '@origintrail-official/dkg-core';
import type { Quad } from './triple-store.js';

/** Never expose these operation-internal graphs through graph enumeration. */
export const ATOMIC_GRAPH_REPLACE_STAGING_PREFIX =
  'urn:dkg:internal:atomic-graph-replace:';

export interface AtomicGraphReplaceUpdate {
  update: string;
  cleanup: string;
  stagingGraph?: string;
}

/**
 * Build one SPARQL Update request that replaces a complete named graph.
 *
 * Non-empty replacements are first materialized in a random internal graph and
 * moved into place as the final operation. The target is therefore untouched
 * if parsing or staging fails. Backends used by DKG execute one Update request
 * transactionally; the final MOVE is itself an atomic graph operation as an
 * additional old-or-new guard. A failed request can leave only an internal
 * staging graph, for which `cleanup` is safe to attempt best-effort.
 */
export function buildAtomicGraphReplaceUpdate(
  graphUri: string,
  quads: readonly Quad[],
): AtomicGraphReplaceUpdate {
  const target = assertSafeIri(graphUri);
  assertReplacementPayload(target, quads);

  if (quads.length === 0) {
    return {
      update: `DROP SILENT GRAPH <${target}>`,
      cleanup: '',
    };
  }

  const stagingGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
  const triples = quads
    .map((quad) => `    ${formatResource(quad.subject, 'subject')} <${assertSafeIri(unwrapIri(quad.predicate))}> ${formatObject(quad.object)} .`)
    .join('\n');
  const cleanup = `DROP SILENT GRAPH <${stagingGraph}>`;
  return {
    stagingGraph,
    cleanup,
    update:
      `${cleanup};\n` +
      `INSERT DATA {\n  GRAPH <${stagingGraph}> {\n${triples}\n  }\n};\n` +
      // The final MOVE must NOT be SILENT: if the staging graph is missing the
      // commit did not happen, and SILENT would report that as success while
      // the stale target content survives.
      `MOVE GRAPH <${stagingGraph}> TO GRAPH <${target}>`,
  };
}

export function isAtomicGraphReplaceStagingGraph(graphUri: string): boolean {
  return graphUri.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX);
}

function assertReplacementPayload(graphUri: string, quads: readonly Quad[]): void {
  for (const [index, quad] of quads.entries()) {
    if (quad.graph !== graphUri) {
      throw new Error(
        `Atomic graph replacement quad ${index} targets "${quad.graph}" instead of "${graphUri}"`,
      );
    }
    if (quad.subject.startsWith('_:') || quad.object.startsWith('_:')) {
      throw new Error(
        `Atomic graph replacement requires canonical skolem IRIs; quad ${index} still contains a blank node`,
      );
    }
  }
}

function formatResource(term: string, role: string): string {
  if (term.startsWith('"')) {
    throw new Error(`Atomic graph replacement ${role} must be an IRI`);
  }
  return `<${assertSafeIri(unwrapIri(term))}>`;
}

function formatObject(term: string): string {
  if (term.startsWith('"')) {
    const normalized = normalizeLiteralDatatype(term);
    assertSafeRdfTerm(normalized);
    return normalized;
  }
  return formatResource(term, 'object');
}

function normalizeLiteralDatatype(term: string): string {
  const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  return bareDatatype
    ? `${bareDatatype[1]}^^<${assertSafeIri(unwrapIri(bareDatatype[2]))}>`
    : term;
}

function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>')
    ? term.slice(1, -1)
    : term;
}
