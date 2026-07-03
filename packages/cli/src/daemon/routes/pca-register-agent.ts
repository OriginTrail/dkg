// #1346 — POST /api/pca/:id/agent orchestration + response assembly, in a
// focused module so `pca.ts` stays parse / validate / dispatch. Returns a
// discriminated outcome the route serializes (input validation + chain-error
// classification stay in the route). No dependency back on pca.ts, so the
// shared 503 body / response mapping stays there.
import { pcaConfirmationToWire, type RegisterPcaAgentResponse } from '../../pca-confirmation-wire.js';
import type { PcaConfirmationOutcome } from '@origintrail-official/dkg-agent';

/** The minimal agent surface this orchestration needs. */
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
 * The outcome of a register-agent attempt, for the route to serialize:
 *   - `unavailable`  — no chain surface (→ 503).
 *   - `tx-failed`    — the tx mined but reverted (success:false) (→ 502); never
 *                      reported as a registered agent.
 *   - `registered`   — mined + successful; `body` is the strict wire response
 *                      (registered:true + advisory derived at this boundary).
 */
export type RegisterPcaAgentOutcome =
  | { kind: 'unavailable' }
  | { kind: 'tx-failed'; error: string }
  | { kind: 'registered'; body: RegisterPcaAgentResponse };

export async function resolveRegisterPcaAgent(
  agent: PcaRegisterAgentPort,
  accountId: bigint,
  agentAddr: string,
  idStr: string,
): Promise<RegisterPcaAgentOutcome> {
  const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
  if (result === null) return { kind: 'unavailable' };
  if (result.success === false) {
    return { kind: 'tx-failed', error: 'PCA agent registration transaction was mined but did not succeed on-chain' };
  }
  // Spread the advisory object (do NOT destructure) so its discriminated-union
  // correlation between `verified` and `adapterSupported` is preserved for the
  // typed `RegisterPcaAgentResponse` body.
  const advisory = pcaConfirmationToWire(
    await agent.confirmPublishingConvictionAgentRegistration(accountId, agentAddr),
  );
  return {
    kind: 'registered',
    body: {
      accountId: idStr,
      agent: agentAddr,
      registered: true,
      ...advisory,
      txHash: result.hash,
      blockNumber: result.blockNumber,
    },
  };
}
