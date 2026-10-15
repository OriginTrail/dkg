import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';

/** The local confirmed publisher has already written VM and drained this exact SWM root. */
export async function retireLegacySwmAfterConfirmedLocalPublish(
  agent: DKGAgent,
  log: Pick<Logger, 'warn'>,
  contextGraphId: string,
  kaUal: string,
  assertionVersion: string,
  subGraphName: string | undefined,
  ctx: OperationContext,
): Promise<boolean> {
  try {
    await agent.retireLegacySwmAfterVerifiedVmTwin({
      contextGraphId,
      kaUal,
      assertionVersion,
      subGraphName,
    });
    return true;
  } catch (err) {
    log.warn(
      ctx,
      `Failed to retire the legacy SWM boundary after confirmed local VM publish: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}
