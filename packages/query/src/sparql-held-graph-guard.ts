import { isSparqlKeyword, type SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import type { VariableAllocator } from './sparql-rewrite-names.js';

const HELD = '__dkgHeld';

/** `FILTER EXISTS { ?s ?p ?o }` over fresh variables: the graph a block reads holds a triple. */
export function heldGraphGuard(allocate: VariableAllocator): string {
  return `FILTER EXISTS { ${allocate(`${HELD}S`)} ${allocate(`${HELD}P`)} ${allocate(`${HELD}O`)} }`;
}

/**
 * The index of the closing brace of a held-graph guard that starts at `index`, or -1. A
 * rewrite that reads the caller's pattern keeps the guard where it is, inside the graph read.
 */
export function heldGraphGuardEnd(tokens: readonly SparqlLexicalToken[], index: number): number {
  const symbol = (at: number, value: string) => tokens[at]?.kind === 'symbol' && tokens[at].logicalValue === value;
  const held = (at: number) => {
    const token = tokens[at];
    return token?.kind === 'variable' && token.logicalValue.slice(1).startsWith(HELD);
  };
  return isSparqlKeyword(tokens, index, 'FILTER') && isSparqlKeyword(tokens, index + 1, 'EXISTS') && symbol(index + 2, '{')
    && held(index + 3) && held(index + 4) && held(index + 5) && symbol(index + 6, '}') ? index + 6 : -1;
}
