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
