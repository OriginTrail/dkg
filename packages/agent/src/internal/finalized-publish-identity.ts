import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import type { PublishAuthorSelectionOptions } from '../publish-author-selection.js';
import {
  readResidentAuthorBoundarySelection,
  resolveResidentFinalizedAssertionAuthor,
  type AssertionAuthorCoordinate,
  type AssertionAuthorQueryStore,
  type ResidentAuthorBoundarySelection,
} from './finalized-assertion-author.js';

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

/** Each choice carries exactly the state its resolution branch needs. */
export type FinalizedPublishIdentityPlan =
  | { readonly kind: 'author'; readonly agentAddress: string; readonly enqueueCaller: string | undefined }
  | { readonly kind: 'callerHint'; readonly callerAgentAddress: string; readonly enqueueCaller: string | undefined }
  | { readonly kind: 'residentAuthor'; readonly selectedAuthor: ResidentAuthorBoundarySelection; readonly enqueueCaller: string | undefined };

/** Pure compatibility parsing; capture public fields before any store access. */
function parseFinalizedPublishIdentityPlan(
  options: PublishAuthorSelectionOptions | undefined,
  defaultCallerHint: string,
): FinalizedPublishIdentityPlan {
  const rawOptions = options as Record<string, unknown> | undefined;
  const selection = rawOptions?.authorSelection;
  const agentAddress = rawOptions?.agentAddress;
  const callerAgentAddress = rawOptions?.callerAgentAddress;
  const selectedAuthorAgentAddress = rawOptions?.selectedAuthorAgentAddress;
  if (selection !== undefined && (agentAddress !== undefined
    || callerAgentAddress !== undefined || selectedAuthorAgentAddress !== undefined)) {
    return conflict('VM publish identity fields must use either authorSelection or the compatible flat form');
  }
  if (selection === undefined) {
    if ((agentAddress !== undefined && typeof agentAddress !== 'string')
      || (callerAgentAddress !== undefined && typeof callerAgentAddress !== 'string')) {
      return conflict('Invalid or conflicting VM publish author selection fields');
    }
    // Released flat fields ignore an empty author; an explicitly empty caller
    // still suppresses the authoritative author's caller stamp.
    const enqueueCaller = (callerAgentAddress ?? agentAddress) || undefined;
    if (agentAddress) {
      if (callerAgentAddress || selectedAuthorAgentAddress !== undefined) {
        return conflict('Invalid or conflicting VM publish author selection fields');
      }
      return { kind: 'author', agentAddress, enqueueCaller };
    }
    return selectedAuthorAgentAddress === undefined
      ? { kind: 'callerHint', callerAgentAddress: callerAgentAddress ?? defaultCallerHint, enqueueCaller }
      : { kind: 'residentAuthor', selectedAuthor: readResidentAuthorBoundarySelection(selectedAuthorAgentAddress), enqueueCaller };
  }
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
      return { kind: 'author', agentAddress: nestedAgentAddress, enqueueCaller: nestedAgentAddress };
    case 'callerHint':
      if (typeof nestedCallerAgentAddress !== 'string'
        || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) {
        return conflict('Invalid or conflicting VM publish authorSelection fields');
      }
      return { kind: 'callerHint', callerAgentAddress: nestedCallerAgentAddress, enqueueCaller: nestedCallerAgentAddress || undefined };
    case 'residentAuthor':
      if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
        || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) {
        return conflict('Invalid or conflicting VM publish authorSelection fields');
      }
      return {
        kind: 'residentAuthor',
        selectedAuthor: readResidentAuthorBoundarySelection(nestedSelectedAuthorAgentAddress),
        enqueueCaller: nestedCallerAgentAddress || undefined,
      };
    default:
      return conflict('Invalid or conflicting VM publish authorSelection fields');
  }
}

/** Resolve a normalized choice with one canonical resident-author lookup. */
export async function resolveFinalizedPublishIdentity(
  store: AssertionAuthorQueryStore,
  { contextGraphId, name, subGraphName }: AssertionAuthorCoordinate,
  options: PublishAuthorSelectionOptions | undefined,
  defaultCallerHint: string,
): Promise<{ readonly agentAddress: string; readonly enqueueCaller: string | undefined }> {
  const plan = parseFinalizedPublishIdentityPlan(options, defaultCallerHint);
  switch (plan.kind) {
    case 'author':
      return { agentAddress: plan.agentAddress, enqueueCaller: plan.enqueueCaller };
    case 'callerHint': {
      const author = await resolveResidentFinalizedAssertionAuthor(store, {
        contextGraphId, name, subGraphName, selection: plan,
      });
      return { agentAddress: author ?? plan.callerAgentAddress, enqueueCaller: plan.enqueueCaller };
    }
    case 'residentAuthor': {
      const author = await resolveResidentFinalizedAssertionAuthor(store, {
        contextGraphId, name, subGraphName, selection: plan,
      });
      if (author === undefined) {
        throw new Error(
          `publishFromFinalizedAssertion: assertion "${name}" in context graph "${contextGraphId}" is not finalized or does not exist.`,
        );
      }
      return { agentAddress: author, enqueueCaller: plan.enqueueCaller };
    }
    default: {
      const unreachable: never = plan;
      throw new Error(`Unsupported finalized-publish identity plan: ${unreachable}`);
    }
  }
}
