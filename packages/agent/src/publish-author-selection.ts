import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';

/** Identity choice for publishing an already-finalized assertion. */
export type PublishAuthorSelection =
  | { readonly mode: 'author'; readonly agentAddress: string; readonly callerAgentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'callerHint'; readonly callerAgentAddress: string; readonly agentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'residentAuthor'; readonly selectedAuthorAgentAddress: string; readonly callerAgentAddress?: string; readonly agentAddress?: never };

/**
 * The nested model is preferred. The flat variants remain source-compatible
 * with the pre-model API for this patch release, while still rejecting bags
 * that mix authoritative and caller identities.
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
    agentAddress: string;
    callerAgentAddress?: never;
    selectedAuthorAgentAddress?: never;
  }
  | {
    authorSelection?: never;
    agentAddress?: never;
    callerAgentAddress?: string;
    selectedAuthorAgentAddress?: string;
  };

type NormalizedPublishAuthorSelection =
  | PublishAuthorSelection
  | {
    readonly mode: 'residentAuthor';
    readonly selectedAuthorAgentAddress: unknown;
    readonly callerAgentAddress?: string;
    readonly agentAddress?: never;
  }
  | { readonly mode: 'default' };

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

/** Snapshot the selection before author lookup; reject contradictory untyped input. */
export function readPublishAuthorSelection(options?: PublishAuthorSelectionOptions): NormalizedPublishAuthorSelection {
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
  if (selection === undefined && hasFlatSelection) {
    if (agentAddress !== undefined) {
      if (typeof agentAddress !== 'string' || agentAddress.length === 0
        || callerAgentAddress !== undefined || selectedAuthorAgentAddress !== undefined) {
        return conflict('Invalid or conflicting VM publish author selection fields');
      }
      return Object.freeze({ mode: 'author', agentAddress });
    }
    if (selectedAuthorAgentAddress !== undefined) {
      if (callerAgentAddress !== undefined && typeof callerAgentAddress !== 'string') {
        return conflict('Invalid or conflicting VM publish author selection fields');
      }
      return Object.freeze({
        mode: 'residentAuthor',
        selectedAuthorAgentAddress,
        ...(callerAgentAddress === undefined ? {} : { callerAgentAddress }),
      });
    }
    if (typeof callerAgentAddress !== 'string') {
      return conflict('Invalid or conflicting VM publish author selection fields');
    }
    return Object.freeze({ mode: 'callerHint', callerAgentAddress });
  }
  if (selection === undefined) return Object.freeze({ mode: 'default' });
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
      return Object.freeze({ mode, agentAddress: nestedAgentAddress });
    case 'callerHint':
      if (typeof nestedCallerAgentAddress !== 'string'
        || nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress !== undefined) break;
      return Object.freeze({ mode, callerAgentAddress: nestedCallerAgentAddress });
    case 'residentAuthor':
      if (nestedAgentAddress !== undefined || nestedSelectedAuthorAgentAddress === undefined
        || (nestedCallerAgentAddress !== undefined && typeof nestedCallerAgentAddress !== 'string')) break;
      // Resident-selector validation stays with the canonical assertion-author
      // resolver, including its existing ASSERTION_AUTHOR_NOT_RESIDENT errors.
      return Object.freeze({
        mode,
        selectedAuthorAgentAddress: nestedSelectedAuthorAgentAddress,
        ...(nestedCallerAgentAddress === undefined ? {} : { callerAgentAddress: nestedCallerAgentAddress }),
      });
  }
  return conflict('Invalid or conflicting VM publish authorSelection fields');
}

/** Preserve the enqueuing caller separately from the resolved member author. */
export function publishAuthorCallerIdentity(selection: NormalizedPublishAuthorSelection): string | undefined {
  if (selection.mode === 'author') return selection.agentAddress;
  return selection.mode === 'default' ? undefined : selection.callerAgentAddress;
}
