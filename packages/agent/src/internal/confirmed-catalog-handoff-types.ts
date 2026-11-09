// SPDX-License-Identifier: Apache-2.0
import type { AssertionSeal, OperationContext } from '@origintrail-official/dkg-core';

/** Identity and timing shared by publication completion and promotion transfer. */
export interface ConfirmedVmIdentityAndTimingV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  readonly shareOperationId?: string;
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
}
