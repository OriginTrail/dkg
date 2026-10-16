// SPDX-License-Identifier: Apache-2.0

/**
 * A second look at the agent gate of a shared-memory write whose signer the
 * receiver's projected gate did not contain.
 *
 * The projected gate is the receiver's local view of the roster. For a member
 * it is the curator's metadata as of its last refresh, so a writer approved
 * after that refresh is absent from it until the next one lands, and that one
 * can lag or fail while the writer's first share is already in flight.
 * Rejecting on the stale view alone was a permanent rejection: the sender's
 * fan-out never retried and the write was lost. The sync-authorization path
 * already refreshes the metadata and re-reads its gate on the same miss; this
 * module gives the write path the same second look.
 *
 * The oracle is injected by the agent. It refreshes the graph's metadata from
 * the curator and re-resolves the canonical gate (the chain roster for a
 * registered graph). Its answer separates three cases the projected gate could
 * not tell apart: the fresh gate contains the signer (the envelope is verified
 * again against it), the fresh gate excludes the signer (permanent rejection),
 * or no fresh gate could be obtained (a retryable rejection, so the sender's
 * fan-out tries again on its watchdog instead of dropping the share).
 */

export type SwmAgentGateRefreshResult =
  | { readonly kind: 'available'; readonly agentAddresses: readonly string[] }
  | { readonly kind: 'ungated' }
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      /** Whether the authority can heal on its own, so the sender may retry. */
      readonly retryable: boolean;
    };

/**
 * Fresh agent gate for one signer the projected gate lacked. Called at most
 * once per rejected envelope, only after the envelope's signature verified, so
 * only an authenticated signer can make the receiver read.
 */
export type SwmAgentGateRefreshOracle = (
  contextGraphId: string,
  signerAddress: string,
) => Promise<SwmAgentGateRefreshResult>;

export type AgentEnvelopeRetryVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly retryable: boolean };

export interface RetryAgentEnvelopeInput {
  oracle: SwmAgentGateRefreshOracle | undefined;
  contextGraphId: string;
  /**
   * The verified signer the projected gate did not contain, or `undefined`
   * when the envelope failed for another reason (then nothing is refreshed:
   * a bad signature does not become good on a fresh gate).
   */
  signerAddress: string | undefined;
  /** The envelope verification again, against the fresh gate. */
  verify: (agentGateAddresses: string[]) => Promise<boolean>;
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
}

export async function retryAgentEnvelopeWithRefreshedGate(
  input: RetryAgentEnvelopeInput,
): Promise<AgentEnvelopeRetryVerdict> {
  const { oracle, contextGraphId, signerAddress, verify, logWarn, logInfo } = input;
  if (oracle === undefined || signerAddress === undefined) {
    return { accepted: false, retryable: false };
  }
  let fresh: SwmAgentGateRefreshResult;
  try {
    fresh = await oracle(contextGraphId, signerAddress);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logWarn(
      `SWM write by ${signerAddress} to context graph "${contextGraphId}" deferred: agent gate refresh failed (${detail})`,
    );
    return { accepted: false, retryable: true };
  }
  switch (fresh.kind) {
    case 'unavailable':
      logWarn(
        `SWM write by ${signerAddress} to context graph "${contextGraphId}" ${fresh.retryable ? 'deferred' : 'rejected'}: `
          + `agent gate authority is unavailable (${fresh.reason})`,
      );
      return { accepted: false, retryable: fresh.retryable };
    case 'ungated':
      logWarn(
        `SWM write by ${signerAddress} to context graph "${contextGraphId}" rejected: the refreshed gate has no agent roster`,
      );
      return { accepted: false, retryable: false };
    case 'available': {
      const accepted = await verify([...fresh.agentAddresses]);
      if (accepted) {
        logInfo(
          `SWM write by ${signerAddress} to context graph "${contextGraphId}" accepted after an agent gate refresh `
            + `(gateCount=${fresh.agentAddresses.length})`,
        );
      }
      return accepted ? { accepted: true } : { accepted: false, retryable: false };
    }
  }
}
