import type { PcaConfirmationOutcome } from '@origintrail-official/dkg-agent';

/** The minimal agent surface the register-agent orchestration needs. */
type PcaRegisterAgentPort = {
  registerPublishingConvictionAgent(
    accountId: bigint,
    agent: string,
  ): Promise<{ hash: string; blockNumber: number; success: boolean } | null>;
  confirmPublishingConvictionAgentRegistration(
    accountId: bigint,
    agent: string,
  ): Promise<PcaConfirmationOutcome>;
};

/**
 * The DOMAIN result of a register-agent attempt — no HTTP status and no wire
 * response body (the route maps and serializes these):
 *   - `unavailable` — the chain adapter exposes no publishing-conviction surface.
 *   - `reverted`    — the registration tx mined but reverted; never a registration.
 *   - `registered`  — mined successfully; carries the mined tx (hash/block) and
 *                     the advisory confirmation outcome.
 */
export type RegisterPcaAgentOutcome =
  | { kind: 'unavailable' }
  | { kind: 'reverted' }
  | { kind: 'registered'; txHash: string; blockNumber: number; confirmation: PcaConfirmationOutcome };

/**
 * Register `agentAddr` as a conviction agent on PCA `accountId`, then confirm it.
 * A pure orchestration over the agent facade: it performs the chain call and
 * confirmation and returns only domain data.
 */
export async function resolveRegisterPcaAgent(
  agent: PcaRegisterAgentPort,
  accountId: bigint,
  agentAddr: string,
): Promise<RegisterPcaAgentOutcome> {
  const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
  if (result === null) return { kind: 'unavailable' };
  if (result.success === false) return { kind: 'reverted' };
  const confirmation = await agent.confirmPublishingConvictionAgentRegistration(accountId, agentAddr);
  return { kind: 'registered', txHash: result.hash, blockNumber: result.blockNumber, confirmation };
}
