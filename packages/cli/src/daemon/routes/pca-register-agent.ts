import { pcaConfirmationToWire, type RegisterPcaAgentResponse } from '../../pca-confirmation-wire.js';
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
 * The DOMAIN outcome of a register-agent attempt (no HTTP concepts — the route
 * maps these to responses):
 *   - `unavailable` — the chain adapter exposes no publishing-conviction surface.
 *   - `reverted`    — the registration tx mined but reverted; never a registration.
 *   - `registered`  — the tx mined successfully; `body` is the coherent wire response
 *                     (`registered:true` + the advisory derived from the confirmation).
 */
export type RegisterPcaAgentOutcome =
  | { kind: 'unavailable' }
  | { kind: 'reverted' }
  | { kind: 'registered'; body: RegisterPcaAgentResponse };

/**
 * Register `agentAddr` as a conviction agent on PCA `accountId`, then derive the
 * advisory confirmation. A pure orchestration over the agent facade: it performs
 * the chain call and confirmation, but classifies only domain outcomes.
 */
export async function resolveRegisterPcaAgent(
  agent: PcaRegisterAgentPort,
  accountId: bigint,
  agentAddr: string,
): Promise<RegisterPcaAgentOutcome> {
  const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
  if (result === null) return { kind: 'unavailable' };
  if (result.success === false) return { kind: 'reverted' };
  // Spread the advisory object (do NOT destructure) so its discriminated-union
  // correlation between `verified` and `adapterSupported` is preserved on the body.
  const advisory = pcaConfirmationToWire(
    await agent.confirmPublishingConvictionAgentRegistration(accountId, agentAddr),
  );
  return {
    kind: 'registered',
    body: {
      accountId: accountId.toString(),
      agent: agentAddr,
      registered: true,
      ...advisory,
      txHash: result.hash,
      blockNumber: result.blockNumber,
    },
  };
}
