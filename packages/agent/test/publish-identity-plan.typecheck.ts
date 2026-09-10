import type { ResolveFinalizedAssertionAuthorParams } from '../src/finalized-assertion-author.js';
import { readPublishIdentityPlan } from '../src/publish-author-selection.js';
import {
  resolveFinalizedAssertionAuthor,
  type AssertionAuthorQueryStore,
  type ResolveFinalizedAssertionAuthorParams as PublishedResolverParams,
} from '@origintrail-official/dkg-agent/dist/finalized-assertion-author.js';

declare const store: AssertionAuthorQueryStore;
declare const legacyOptions: { callerAgentAddress?: string; selectedAuthorAgentAddress?: string };
void resolveFinalizedAssertionAuthor(store, { contextGraphId: 'cg', name: 'ka', ...legacyOptions });
const legacySelection: PublishedResolverParams = {
  contextGraphId: 'cg', name: 'ka', callerAgentAddress: 'curator', selectedAuthorAgentAddress: 'member',
};
void resolveFinalizedAssertionAuthor(store, legacySelection);
void resolveFinalizedAssertionAuthor(store, {
  contextGraphId: 'cg', name: 'ka', selectedAuthor: { kind: 'address', agentAddress: 'member' },
});

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
