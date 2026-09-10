import type { ResolveFinalizedAssertionAuthorParams } from '../src/finalized-assertion-author.js';
import { readPublishIdentityPlan } from '../src/publish-author-selection.js';

declare const unknownSelector: unknown;
const malformed: ResolveFinalizedAssertionAuthorParams = {
  contextGraphId: 'cg', name: 'ka',
  // @ts-expect-error Untyped resident selectors must be normalized at the API boundary.
  selectedAuthor: unknownSelector,
};
const plan = readPublishIdentityPlan(undefined, 'caller');
// @ts-expect-error The enqueue decision is immutable after normalization.
plan.enqueueCaller = 'other';
void malformed;
