import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import type { PublishAuthorSelectionOptions } from '../publish-author-selection.js';
import {
  readResidentAuthorSelection,
  type ResidentAssertionAuthorSelection,
} from './resident-assertion-author-selection.js';

/** All identity decisions consumed by author lookup and durable enqueue. */
export interface PublishIdentityPlan {
  readonly author:
    | { readonly mode: 'author'; readonly agentAddress: string }
    | { readonly mode: 'callerHint'; readonly callerHint: string }
    | {
        readonly mode: 'residentAuthor';
        readonly residentSelection: ResidentAssertionAuthorSelection;
      };
  readonly enqueueCaller: string | undefined;
}

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

function identityPlan(
  author: PublishIdentityPlan['author'],
  enqueueCaller: string | undefined,
): PublishIdentityPlan {
  return Object.freeze({
    author: Object.freeze(author),
    enqueueCaller: enqueueCaller || undefined,
  });
}

/** Adapt released flat-field quirks once, before any asynchronous author lookup. */
function readLegacyPublishIdentityPlan(
  agentAddress: unknown,
  callerAgentAddress: unknown,
  selectedAuthorAgentAddress: unknown,
  defaultCallerHint: string,
): PublishIdentityPlan {
  if ((agentAddress !== undefined && typeof agentAddress !== 'string')
    || (callerAgentAddress !== undefined && typeof callerAgentAddress !== 'string')) {
    return conflict('Invalid or conflicting VM publish author selection fields');
  }
  // An empty authoritative selector is ignored. An explicitly empty caller
  // beside a nonempty author override suppresses the enqueue caller stamp.
  const enqueueCaller = callerAgentAddress ?? agentAddress;
  if (agentAddress) {
    if (callerAgentAddress || selectedAuthorAgentAddress !== undefined) {
      return conflict('Invalid or conflicting VM publish author selection fields');
    }
    return identityPlan({ mode: 'author', agentAddress }, enqueueCaller);
  }
  const residentSelection = readResidentAuthorSelection(selectedAuthorAgentAddress);
  return identityPlan(
    residentSelection === undefined
      ? { mode: 'callerHint', callerHint: callerAgentAddress ?? defaultCallerHint }
      : { mode: 'residentAuthor', residentSelection },
    enqueueCaller,
  );
}

/** Normalize either public syntax into one immutable, behavior-complete plan. */
export function readPublishIdentityPlan(
  options: PublishAuthorSelectionOptions | undefined,
  defaultCallerHint: string,
): PublishIdentityPlan {
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
  if (selection === undefined) {
    return readLegacyPublishIdentityPlan(
      agentAddress, callerAgentAddress, selectedAuthorAgentAddress, defaultCallerHint,
    );
  }
  if (selection === null || typeof selection !== 'object') return conflict('Invalid VM publish authorSelection');
  const {
    mode,
    agentAddress: nestedAgentAddress,
    callerAgentAddress: nestedCallerAgentAddress,
    selectedAuthorAgentAddress: nestedSelectedAuthorAgentAddress,
  } = selection as Record<string, unknown>;
  switch (mode) {
    case 'author':
      if (typeof nestedAgentAddress !== 'string' || nestedAgentAddress.length === 0
        || nestedCallerAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) break;
      return identityPlan({ mode: 'author', agentAddress: nestedAgentAddress }, nestedAgentAddress);
    case 'callerHint':
      if (typeof nestedCallerAgentAddress !== 'string'
        || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) break;
      return identityPlan({ mode: 'callerHint', callerHint: nestedCallerAgentAddress }, nestedCallerAgentAddress);
    case 'residentAuthor':
      if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
        || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) break;
      return identityPlan(
        {
          mode: 'residentAuthor',
          // Presence was checked above; malformed values remain explicit selectors.
          residentSelection: readResidentAuthorSelection(nestedSelectedAuthorAgentAddress)!,
        },
        nestedCallerAgentAddress,
      );
  }
  return conflict('Invalid or conflicting VM publish authorSelection fields');
}
