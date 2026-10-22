import { indexSparqlStructure, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import type { AdmittedReadDeadline } from '../admitted-read-cancellation.js';
import { readResponseTextBounded } from '../http-response-limit.js';
import { UnsupportedTripleStoreCapabilityError } from '../unsupported-capability-error.js';
import { completeBlazegraphWriteResponse } from './blazegraph-persistence.js';

/** Bound the request to one supported native operation, never a statement batch.
 * Blazegraph still performs complete grammar validation before executing it. */
export function assertSingleBlazegraphUpdate(sparql: string): void {
  const scan = prepareSparql(sparql), structure = indexSparqlStructure(scan);
  const refuse = () => { throw new UnsupportedTripleStoreCapabilityError('atomicUpdate', 'BlazegraphStore'); };
  if (scan.status !== 'valid' || scan.unterminated || !structure.balanced) return refuse();
  const top = scan.tokens.filter((_, index) => index >= scan.prologue.endTokenIndex
    && structure.braces.depthBefore[index] === 0 && structure.parentheses.depthBefore[index] === 0
    && structure.brackets.depthBefore[index] === 0);
  if (top.some(token => token.kind === 'symbol' && token.logicalValue === ';')) return refuse();
  const words = top.filter(token => token.kind === 'word').map(token => token.upper).join(' ');
  if (!['INSERT DATA', 'DELETE DATA', 'DELETE WHERE', 'INSERT WHERE', 'DELETE INSERT WHERE'].includes(words)) refuse();
}

/** One transport boundary, retaining the caller's admission and original deadline. */
export async function postBlazegraphWriteRequest(url: string, body: string, contentType: string,
  deadline: AdmittedReadDeadline, responsePolicy: 'insert' | 'update' | 'bulk group',
): Promise<void> {
  deadline.check();
  const response = await deadline.waitFor(fetch(url, {
    method: 'POST', headers: { 'Content-Type': contentType }, body, signal: deadline.signal,
  }));
  if (responsePolicy === 'bulk group') {
    await deadline.waitFor(readResponseTextBounded(response, 64 * 1024));
    if (!response.ok) throw new Error(`Blazegraph bulk group failed (${response.status})`);
  } else if (!response.ok) {
    const text = await deadline.waitFor(response.text().catch(() => ''));
    throw new Error(`Blazegraph ${responsePolicy} failed (${response.status}): ${text.slice(0, responsePolicy === 'insert' ? 200 : 300)}`);
  } else await completeBlazegraphWriteResponse(response, deadline);
}
