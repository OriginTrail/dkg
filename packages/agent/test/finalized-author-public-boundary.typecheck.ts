import type { ResolveFinalizedAssertionAuthorParams } from '../src/finalized-assertion-author.js';
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
void malformed;

// @ts-expect-error The normalized model is not re-exported by the released deep resolver.
export type { ResidentAssertionAuthorSelection } from '@origintrail-official/dkg-agent/dist/finalized-assertion-author.js';
// @ts-expect-error Public selection contracts do not expose internal identity resolution.
export { resolveFinalizedPublishIdentity } from '@origintrail-official/dkg-agent/dist/publish-author-selection.js';
// @ts-expect-error Public selection contracts do not expose the boundary parser.
export { readResidentAuthorBoundarySelection as publicResidentReader } from '@origintrail-official/dkg-agent/dist/publish-author-selection.js';
// @ts-expect-error Internal normalized resolution is blocked by package exports.
export { resolveResidentFinalizedAssertionAuthor } from '@origintrail-official/dkg-agent/dist/internal/finalized-assertion-author.js';
// @ts-expect-error Finalized publish identity resolution is internal.
export { resolveFinalizedPublishIdentity } from '@origintrail-official/dkg-agent/dist/internal/finalized-publish-identity.js';
