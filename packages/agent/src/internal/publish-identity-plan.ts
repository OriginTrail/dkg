import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import type { PublishAuthorSelectionOptions } from '../publish-author-selection.js';
import {
  readResidentAuthorBoundarySelection,
} from './finalized-assertion-author.js';

/** All identity decisions consumed by author lookup and durable enqueue. */
export interface PublishIdentityPlan {
  readonly author:
    | { readonly mode: 'author'; readonly agentAddress: string }
    | { readonly mode: 'callerHint'; readonly callerHint: string }
    | {
        readonly mode: 'residentAuthor';
        readonly agentAddress: string;
      };
  readonly enqueueCaller: string | undefined;
}

export type PublishIdentityBoundary =
  | { readonly kind: 'valid'; readonly plan: PublishIdentityPlan }
  | {
      readonly kind: 'invalidResidentAuthor';
      readonly displayValue: string;
      readonly enqueueCaller: string | undefined;
    };

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

function validIdentity(
  author: PublishIdentityPlan['author'],
  enqueueCaller: string | undefined,
): PublishIdentityBoundary {
  return Object.freeze({ kind: 'valid', plan: identityPlan(author, enqueueCaller) });
}

function invalidResidentIdentity(
  displayValue: string,
  enqueueCaller: string | undefined,
): PublishIdentityBoundary {
  return Object.freeze({
    kind: 'invalidResidentAuthor',
    displayValue,
    enqueueCaller: enqueueCaller || undefined,
  });
}

/** Adapt released flat-field quirks once, before any asynchronous author lookup. */
function readLegacyPublishIdentityBoundary(
  agentAddress: unknown,
  callerAgentAddress: unknown,
  selectedAuthorAgentAddress: unknown,
  defaultCallerHint: string,
): PublishIdentityBoundary {
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
    return validIdentity({ mode: 'author', agentAddress }, enqueueCaller);
  }
  const residentSelection = readResidentAuthorBoundarySelection(selectedAuthorAgentAddress);
  if (residentSelection?.kind === 'invalid') {
    return invalidResidentIdentity(residentSelection.displayValue, enqueueCaller);
  }
  return validIdentity(
    residentSelection
      ? { mode: 'residentAuthor', agentAddress: residentSelection.agentAddress }
      : { mode: 'callerHint', callerHint: callerAgentAddress ?? defaultCallerHint },
    enqueueCaller,
  );
}

/** Normalize either public syntax into one immutable, behavior-complete plan. */
export function readPublishIdentityBoundary(
  options: PublishAuthorSelectionOptions | undefined,
  defaultCallerHint: string,
): PublishIdentityBoundary {
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
    return readLegacyPublishIdentityBoundary(
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
      return validIdentity({ mode: 'author', agentAddress: nestedAgentAddress }, nestedAgentAddress);
    case 'callerHint':
      if (typeof nestedCallerAgentAddress !== 'string'
        || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) break;
      return validIdentity({ mode: 'callerHint', callerHint: nestedCallerAgentAddress }, nestedCallerAgentAddress);
    case 'residentAuthor':
      if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
        || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) break;
      const residentSelection = readResidentAuthorBoundarySelection(nestedSelectedAuthorAgentAddress)!;
      if (residentSelection.kind === 'invalid') {
        return invalidResidentIdentity(residentSelection.displayValue, nestedCallerAgentAddress);
      }
      return validIdentity(
        { mode: 'residentAuthor', agentAddress: residentSelection.agentAddress },
        nestedCallerAgentAddress,
      );
  }
  return conflict('Invalid or conflicting VM publish authorSelection fields');
}
