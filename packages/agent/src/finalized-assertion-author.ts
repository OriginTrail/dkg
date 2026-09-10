import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import {
  resolveResidentFinalizedAssertionAuthor,
  type AssertionAuthorQueryStore,
} from './internal/finalized-assertion-author.js';
import { readResidentAuthorSelection } from './internal/resident-assertion-author-selection.js';

export type { AssertionAuthorQueryStore } from './internal/finalized-assertion-author.js';

/** Released deep-entry-point input. The caller is a hint; the selector must be resident. */
export interface ResolveFinalizedAssertionAuthorParams {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  callerAgentAddress?: string;
  selectedAuthorAgentAddress?: string;
}

/**
 * Resolve a finalized assertion's stored author, preserving the released deep API.
 * Explicit resident selection takes precedence over caller preference; otherwise
 * a unique resident author is used. Missing or ambiguous selections preserve the
 * canonical lookup's candidate diagnostics.
 */
export async function resolveFinalizedAssertionAuthor(
  store: AssertionAuthorQueryStore,
  params: ResolveFinalizedAssertionAuthorParams,
): Promise<string | undefined> {
  // Internal normalization artifacts are not an alternative public syntax.
  // Reject untyped callers too, so an unsupported selector cannot be ignored.
  if ((params as unknown as Record<string, unknown>).selectedAuthor !== undefined) {
    throw Object.assign(
      new Error('Use selectedAuthorAgentAddress at the public author resolver boundary'),
      { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE },
    );
  }
  const { contextGraphId, name, subGraphName, callerAgentAddress, selectedAuthorAgentAddress } = params;
  return resolveResidentFinalizedAssertionAuthor(store, {
    contextGraphId, name, subGraphName, callerAgentAddress,
    selectedAuthor: readResidentAuthorSelection(selectedAuthorAgentAddress),
  });
}
