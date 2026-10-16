import type { BoundedQueryResponse } from '../src/daemon/bounded-query.js';

declare const response: BoundedQueryResponse;
if (response.mode === 'page') {
  const complete: false = response.resultComplete;
  const page: true = response.pageComplete;
  const offset: number | null = response.nextOffset;
  void [complete, page, offset];
} else {
  const complete: true = response.resultComplete;
  // @ts-expect-error Complete results have no paging metadata.
  response.nextOffset;
  void complete;
}
// @ts-expect-error Page results require all paging metadata.
const missingPage: BoundedQueryResponse = { mode: 'page', resultComplete: false, result: { type: 'bindings', bindings: [] } };
// @ts-expect-error Complete mode cannot claim an incomplete result.
const incomplete: BoundedQueryResponse = { mode: 'complete', resultComplete: false, result: { type: 'bindings', bindings: [] } };
void [missingPage, incomplete];
