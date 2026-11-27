function nonEmptyAgentAddresses(agentAddresses: readonly string[]): readonly string[] {
  if (agentAddresses.length === 0) {
    throw new TypeError('WorkspaceAgentEncryptionKeyMissingError needs at least one agent address');
  }
  return [...agentAddresses];
}

/**
 * No authenticated workspace encryption key is known on this node for one or
 * more recipient agents: it has neither their signed join requests nor their
 * profiles (#2849). For one agent the message stays the historical one;
 * callers that can fetch the keys read `agentAddresses`.
 */
export class WorkspaceAgentEncryptionKeyMissingError extends Error {
  /** The first agent without a key. */
  readonly agentAddress: string;
  /** Every agent without a key, in recipient order. */
  readonly agentAddresses: readonly string[];

  constructor(agentAddresses: readonly string[], message?: string) {
    const [first, ...rest] = nonEmptyAgentAddresses(agentAddresses);
    super(message ?? (
      `Missing public encryption key for DKG agent ${first}`
      + (rest.length > 0 ? ` (also missing for ${rest.join(', ')})` : '')
    ));
    this.name = 'WorkspaceAgentEncryptionKeyMissingError';
    this.agentAddresses = nonEmptyAgentAddresses(agentAddresses);
    this.agentAddress = this.agentAddresses[0]!;
  }
}

/** Also recognises the error across duplicate module instances. */
export function isWorkspaceAgentEncryptionKeyMissingError(
  error: unknown,
): error is WorkspaceAgentEncryptionKeyMissingError {
  if (error instanceof WorkspaceAgentEncryptionKeyMissingError) return true;
  if (!(error instanceof Error) || error.name !== 'WorkspaceAgentEncryptionKeyMissingError') return false;
  const { agentAddress, agentAddresses } = error as { agentAddress?: unknown; agentAddresses?: unknown };
  return typeof agentAddress === 'string'
    && Array.isArray(agentAddresses)
    && agentAddresses.length > 0
    && agentAddresses.every((address) => typeof address === 'string');
}

