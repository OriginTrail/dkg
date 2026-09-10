import type { ResolveFinalizedAssertionAuthorParams } from '../src/finalized-assertion-author.js';
import { readPublishIdentityBoundary } from '../src/internal/publish-identity-plan.js';
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
  contextGraphId: 'cg', name: 'ka',
  // @ts-expect-error Normalized selectors are not a public resolver input.
  selectedAuthor: { kind: 'malformed', displayValue: '[object Object]' },
});

declare const unknownSelector: unknown;
const malformed: ResolveFinalizedAssertionAuthorParams = {
  contextGraphId: 'cg', name: 'ka',
  // @ts-expect-error Untyped resident selectors must be normalized at the API boundary.
  selectedAuthor: unknownSelector,
};
const boundary = readPublishIdentityBoundary(undefined, 'caller');
if (boundary.kind !== 'valid') throw new Error('expected valid plan');
const plan = boundary.plan;
// @ts-expect-error The enqueue decision is immutable after normalization.
plan.enqueueCaller = 'other';
if (plan.author.mode === 'residentAuthor') {
  const requiredAddress: string = plan.author.agentAddress;
  void requiredAddress;
  // @ts-expect-error Invalid boundary values cannot inhabit the normalized plan.
  void plan.author.displayValue;
  // @ts-expect-error Resident selection has no caller-hint policy or fallback.
  void plan.author.callerHint;
} else if (plan.author.mode === 'callerHint') {
  const requiredHint: string = plan.author.callerHint;
  void requiredHint;
  // @ts-expect-error Caller-hint resolution cannot also select a resident author.
  void plan.author.residentSelection;
}
void malformed;

// @ts-expect-error The normalized model is not re-exported by the released deep resolver.
export type { ResidentAssertionAuthorSelection } from '@origintrail-official/dkg-agent/dist/finalized-assertion-author.js';
// @ts-expect-error Public selection contracts do not expose internal plan construction.
export { readPublishIdentityBoundary as publicPlanReader } from '@origintrail-official/dkg-agent/dist/publish-author-selection.js';
// @ts-expect-error Public selection contracts do not expose the boundary parser.
export { readResidentAuthorBoundarySelection as publicResidentReader } from '@origintrail-official/dkg-agent/dist/publish-author-selection.js';
// @ts-expect-error The normalized plan model is internal.
export type { PublishIdentityPlan } from '@origintrail-official/dkg-agent/dist/publish-author-selection.js';
// @ts-expect-error Internal normalized resolution is blocked by package exports.
export { resolveResidentFinalizedAssertionAuthor } from '@origintrail-official/dkg-agent/dist/internal/finalized-assertion-author.js';
