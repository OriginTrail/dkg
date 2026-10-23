// SPDX-License-Identifier: Apache-2.0
import type { AssertionSeal } from '@origintrail-official/dkg-core';
import type { PublishResult } from '@origintrail-official/dkg-publisher';

/** Agent-owned sealed named-KA publication, including its local repair scheduling state. */
export interface NamedKaVmPublishResult extends PublishResult {
  readonly assertionUri: string;
  readonly seal: AssertionSeal;
  /** Chain confirmation succeeded; agent-owned local lifecycle repair is still scheduled. */
  readonly lifecycleRepairPending?: boolean;
}
