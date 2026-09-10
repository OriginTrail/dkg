import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import type { PublishAuthorSelectionOptions } from '../publish-author-selection.js';
import {
  resolveResidentFinalizedAssertionAuthor,
  type AssertionAuthorQueryStore,
  type FinalizedAssertionAuthorLookupParams,
} from './finalized-assertion-author.js';

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

/** Snapshot both public identity syntaxes before looking up the resident author. */
export async function resolveFinalizedPublishIdentity(
  store: AssertionAuthorQueryStore,
  { contextGraphId, name, subGraphName }: Pick<
    FinalizedAssertionAuthorLookupParams, 'contextGraphId' | 'name' | 'subGraphName'
  >,
  options: PublishAuthorSelectionOptions | undefined,
  defaultCallerHint: string,
): Promise<{ readonly agentAddress: string; readonly enqueueCaller: string | undefined }> {
  const rawOptions = options as Record<string, unknown> | undefined;
  const selection = rawOptions?.authorSelection;
  const agentAddress = rawOptions?.agentAddress;
  const callerAgentAddress = rawOptions?.callerAgentAddress;
  const selectedAuthorAgentAddress = rawOptions?.selectedAuthorAgentAddress;
  const hasFlatSelection = agentAddress !== undefined
    || callerAgentAddress !== undefined
    || selectedAuthorAgentAddress !== undefined;
  if (selection !== undefined && hasFlatSelection) {
    return conflict('VM publish identity fields must use either authorSelection or the compatible flat form');
  }

  let callerHint = defaultCallerHint;
  let enqueueCaller: string | undefined;
  let residentSelection: unknown;
  let hasResidentSelection = false;
  if (selection === undefined) {
    if ((agentAddress !== undefined && typeof agentAddress !== 'string')
      || (callerAgentAddress !== undefined && typeof callerAgentAddress !== 'string')) {
      return conflict('Invalid or conflicting VM publish author selection fields');
    }
    // Preserve released flat-field behavior: an empty author is ignored, while
    // an explicitly empty caller suppresses the author override's caller stamp.
    enqueueCaller = (callerAgentAddress ?? agentAddress) || undefined;
    if (agentAddress) {
      if (callerAgentAddress || selectedAuthorAgentAddress !== undefined) {
        return conflict('Invalid or conflicting VM publish author selection fields');
      }
      return { agentAddress, enqueueCaller };
    }
    callerHint = callerAgentAddress ?? defaultCallerHint;
    residentSelection = selectedAuthorAgentAddress;
    hasResidentSelection = selectedAuthorAgentAddress !== undefined;
  } else {
    if (selection === null || typeof selection !== 'object') {
      return conflict('Invalid VM publish authorSelection');
    }
    const {
      mode,
      agentAddress: nestedAgentAddress,
      callerAgentAddress: nestedCallerAgentAddress,
      selectedAuthorAgentAddress: nestedSelectedAuthorAgentAddress,
    } = selection as Record<string, unknown>;
    switch (mode) {
      case 'author':
        if (typeof nestedAgentAddress !== 'string' || nestedAgentAddress.length === 0
          || nestedCallerAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) {
          return conflict('Invalid or conflicting VM publish authorSelection fields');
        }
        return { agentAddress: nestedAgentAddress, enqueueCaller: nestedAgentAddress };
      case 'callerHint':
        if (typeof nestedCallerAgentAddress !== 'string'
          || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) {
          return conflict('Invalid or conflicting VM publish authorSelection fields');
        }
        callerHint = nestedCallerAgentAddress;
        enqueueCaller = nestedCallerAgentAddress || undefined;
        break;
      case 'residentAuthor':
        if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
          || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) {
          return conflict('Invalid or conflicting VM publish authorSelection fields');
        }
        residentSelection = nestedSelectedAuthorAgentAddress;
        hasResidentSelection = true;
        enqueueCaller = nestedCallerAgentAddress || undefined;
        break;
      default:
        return conflict('Invalid or conflicting VM publish authorSelection fields');
    }
  }

  const author = await resolveResidentFinalizedAssertionAuthor(store, {
    contextGraphId, name, subGraphName,
    ...(hasResidentSelection
      ? { selectedAuthorAgentAddress: residentSelection }
      : { callerAgentAddress: callerHint }),
  });
  if (hasResidentSelection && author === undefined) {
    throw new Error(
      `publishFromFinalizedAssertion: assertion "${name}" in context graph "${contextGraphId}" is not finalized or does not exist.`,
    );
  }
  return { agentAddress: author ?? callerHint, enqueueCaller };
}
