import { boundedResult, finalizeBoundedQuery, type BoundedQueryPolicy, type BoundedQueryResponse } from '../src/daemon/bounded-query.js';

declare const response: BoundedQueryResponse;
if (response.mode === 'page') {
  const complete: false = response.resultComplete;
  const page: true = response.pageComplete;
  const offset: number | null = response.nextOffset;
  void [complete, page, offset];
} else {
  const complete: true = response.resultComplete;
  // @ts-expect-error Complete results have no paging metadata.
  void response.nextOffset;
  void complete;
}
// @ts-expect-error Page results require all paging metadata.
const missingPage: BoundedQueryResponse = { mode: 'page', resultComplete: false, result: { type: 'bindings', bindings: [] } };
// @ts-expect-error Complete mode cannot claim an incomplete result.
const incomplete: BoundedQueryResponse = { mode: 'complete', resultComplete: false, result: { type: 'bindings', bindings: [] } };
void [missingPage, incomplete];


// Preserve the canonical SELECT contract through each public helper.
const responseValue: string = response.result.bindings[0]!.s;
const bounded = boundedResult([{ s: 'urn:example:entity' }], 10);
if (bounded.ok) {
  const value: string = bounded.result.bindings[0]!.s;
  void value;
}
declare const policy: BoundedQueryPolicy;
const finalized = finalizeBoundedQuery(policy, [{ s: 'urn:example:entity' }]);
if (finalized.ok) {
  const value: string = finalized.response.result.bindings[0]!.s;
  void value;
}
// @ts-expect-error SELECT bindings contain RDF term strings, never arbitrary objects.
void boundedResult([{ s: { arbitrary: true } }], 10);
// @ts-expect-error Finalization must retain the same string-valued binding contract.
void finalizeBoundedQuery(policy, [{ s: { arbitrary: true } }]);
void responseValue;
