// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';

// Preserve the publisher metadata wire contract. General core/RDF escapers
// additionally escape tabs/control characters, and core IRI validators have
// different accepted inputs. Both metadata and local controls use these exact
// compatibility rules; consumers must not define separate copies.
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export function rdfLiteralLexicalValue(value: string): string | undefined {
  const match = /^("(?:\\.|[^"\\])*")/.exec(value);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

export function assertSafeGraphIriForSparql(graphIri: string): void {
  // GRAPH <...> must not allow delimiter/control chars that can alter query structure.
  if (/[<>"{}|^`\\\s]/.test(graphIri)) {
    throw new Error(`Unsafe graph IRI for SPARQL query: "${graphIri}"`);
  }
}

export function mq(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

export function lit(val: string): string {
  const escaped = val
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

export function intLit(val: number | bigint): string {
  return `"${val}"^^<${XSD}integer>`;
}
