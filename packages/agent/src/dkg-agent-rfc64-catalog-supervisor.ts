// SPDX-License-Identifier: Apache-2.0

/** Explicit lifecycle owner for the independent RFC-64 catalog workloads. */

import type { OperationContext } from '@origintrail-official/dkg-core';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

export class Rfc64CatalogSupervisorMethods extends DKGAgentBase {
  startRfc64CatalogSupervisorsV1(this: DKGAgent, ctx: OperationContext): void {
    this.startRfc64PublicCatalogBootstrapV1(ctx);
    this.startRfc64SwmCatalogProjectionSupervisorV1(ctx);
  }

  async whenRfc64CatalogSupervisorsIdleV1(this: DKGAgent): Promise<void> {
    await Promise.all([
      this.whenRfc64PublicCatalogBootstrapIdleV1(),
      this.whenRfc64SwmCatalogProjectionSupervisorIdleV1(),
    ]);
  }

  async closeRfc64CatalogSupervisorsV1(this: DKGAgent): Promise<void> {
    // Fence both independent owners before awaiting either one, so one cannot
    // admit follow-up work while the other is draining.
    await Promise.all([
      this.closeRfc64PublicCatalogBootstrapV1(),
      this.closeRfc64SwmCatalogProjectionSupervisorV1(),
    ]);
  }
}
