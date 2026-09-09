import { PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE } from '@origintrail-official/dkg-core';

/** Identity choice for publishing an already-finalized assertion. */
export type PublishAuthorSelection =
  | { readonly mode: 'author'; readonly agentAddress: string; readonly callerAgentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'callerHint'; readonly callerAgentAddress: string; readonly agentAddress?: never; readonly selectedAuthorAgentAddress?: never }
  | { readonly mode: 'residentAuthor'; readonly selectedAuthorAgentAddress: string; readonly callerAgentAddress?: string; readonly agentAddress?: never }
  | { readonly mode: 'default'; readonly agentAddress?: never; readonly callerAgentAddress?: never; readonly selectedAuthorAgentAddress?: never };

export interface PublishAuthorSelectionOptions {
  authorSelection?: PublishAuthorSelection;
  // Reject old identity bags even when passed through a widened variable.
  agentAddress?: never;
  callerAgentAddress?: never;
  selectedAuthorAgentAddress?: never;
}

function conflict(message: string): never {
  throw Object.assign(new Error(message), { code: PUBLISH_AUTHOR_SELECTION_CONFLICT_CODE });
}

/** Snapshot the selection before author lookup; reject contradictory untyped input. */
export function readPublishAuthorSelection(options?: PublishAuthorSelectionOptions): PublishAuthorSelection {
  if (options && (['agentAddress', 'callerAgentAddress', 'selectedAuthorAgentAddress'] as const).some(key => options[key] !== undefined)) {
    return conflict('VM publish identity fields belong in authorSelection; choose one selection mode');
  }
  const selection = options?.authorSelection;
  if (selection === undefined) return Object.freeze({ mode: 'default' });
  if (selection === null || typeof selection !== 'object') return conflict('Invalid VM publish authorSelection');
  const { mode, agentAddress, callerAgentAddress, selectedAuthorAgentAddress } = selection;
  switch (mode) {
    case 'author':
      if (typeof agentAddress !== 'string' || agentAddress.length === 0 || callerAgentAddress !== undefined || selectedAuthorAgentAddress !== undefined) break;
      return Object.freeze({ mode, agentAddress });
    case 'callerHint':
      if (typeof callerAgentAddress !== 'string' || agentAddress !== undefined || selectedAuthorAgentAddress !== undefined) break;
      return Object.freeze({ mode, callerAgentAddress });
    case 'residentAuthor':
      if (agentAddress !== undefined || selectedAuthorAgentAddress === undefined || (callerAgentAddress !== undefined && typeof callerAgentAddress !== 'string')) break;
      // Resident-selector validation stays with the canonical assertion-author
      // resolver, including its existing ASSERTION_AUTHOR_NOT_RESIDENT errors.
      return Object.freeze({ mode, selectedAuthorAgentAddress, ...(callerAgentAddress === undefined ? {} : { callerAgentAddress }) });
    case 'default':
      if (agentAddress !== undefined || callerAgentAddress !== undefined || selectedAuthorAgentAddress !== undefined) break;
      return Object.freeze({ mode });
  }
  return conflict('Invalid or conflicting VM publish authorSelection fields');
}

/** Preserve the enqueuing caller separately from the resolved member author. */
export function publishAuthorCallerIdentity(selection: PublishAuthorSelection): string | undefined {
  return selection.mode === 'author' ? selection.agentAddress : selection.callerAgentAddress;
}
