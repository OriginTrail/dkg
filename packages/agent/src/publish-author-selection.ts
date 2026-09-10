import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';
import type { ResidentAssertionAuthorSelection } from './finalized-assertion-author.js';

/** Identity choice for publishing an already-finalized assertion. */
export type PublishAuthorSelection =
  | { readonly mode: 'author'; readonly agentAddress: string; readonly callerAgentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'callerHint'; readonly callerAgentAddress: string; readonly agentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'residentAuthor'; readonly selectedAuthorAgentAddress: string; readonly callerAgentAddress?: string; readonly agentAddress?: never };

/**
 * The nested model is preferred. The flat variants remain source-compatible
 * with the pre-model API for this patch release, including callers whose
 * options use optional-string annotations. Conflicting flat bags fail at runtime.
 */
export type PublishAuthorSelectionOptions =
  | {
    authorSelection?: PublishAuthorSelection;
    agentAddress?: never;
    callerAgentAddress?: never;
    selectedAuthorAgentAddress?: never;
  }
  | {
    authorSelection?: never;
    /** @deprecated Use authorSelection with mode 'author'. */
    agentAddress?: string;
    /** @deprecated Use authorSelection with mode 'callerHint' or 'residentAuthor'. */
    callerAgentAddress?: string;
    /** @deprecated Use authorSelection with mode 'residentAuthor'. */
    selectedAuthorAgentAddress?: string;
  };

/** All identity decisions consumed by author lookup and durable enqueue. */
export interface PublishIdentityPlan {
  readonly author:
    | { readonly mode: 'author'; readonly agentAddress: string }
    | {
        readonly mode: 'resolve';
        readonly callerHint: string;
        readonly residentSelection: ResidentAssertionAuthorSelection | undefined;
      };
  readonly enqueueCaller: string | undefined;
}

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

/** Snapshot untyped API input without forwarding arbitrary values into lookup. */
export function readResidentAuthorSelection(value: unknown): ResidentAssertionAuthorSelection | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? Object.freeze({ kind: 'address', agentAddress: value })
    : Object.freeze({ kind: 'malformed', displayValue: String(value) });
}

function authorPlan(agentAddress: string, enqueueCaller: string | undefined): PublishIdentityPlan {
  return Object.freeze({
    author: Object.freeze({ mode: 'author', agentAddress }),
    enqueueCaller: enqueueCaller || undefined,
  });
}

function lookupPlan(
  callerHint: string,
  enqueueCaller: string | undefined,
  residentSelection?: ResidentAssertionAuthorSelection,
): PublishIdentityPlan {
  return Object.freeze({
    author: Object.freeze({ mode: 'resolve', callerHint, residentSelection }),
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
    return authorPlan(agentAddress, enqueueCaller);
  }
  return lookupPlan(
    callerAgentAddress ?? defaultCallerHint,
    enqueueCaller,
    readResidentAuthorSelection(selectedAuthorAgentAddress),
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
      return authorPlan(nestedAgentAddress, nestedAgentAddress);
    case 'callerHint':
      if (typeof nestedCallerAgentAddress !== 'string'
        || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) break;
      return lookupPlan(nestedCallerAgentAddress, nestedCallerAgentAddress);
    case 'residentAuthor':
      if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
        || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) break;
      return lookupPlan(
        nestedCallerAgentAddress ?? defaultCallerHint,
        nestedCallerAgentAddress,
        readResidentAuthorSelection(nestedSelectedAuthorAgentAddress),
      );
  }
  return conflict('Invalid or conflicting VM publish authorSelection fields');
}
