// SPDX-License-Identifier: Apache-2.0
import type { AssertionCoordinateV1, ContextGraphIdV1 } from '@origintrail-official/dkg-core';
import type { ConfirmedVmIdentityAndTimingV1 } from './confirmed-catalog-handoff-types.js';

/** Legacy callers may omit selection; the publication entry normalizes it once. */
export interface ObserveRfc64ConfirmedVmParamsV1 extends ConfirmedVmIdentityAndTimingV1 {
  readonly catalogObligationRequired?: boolean;
}

/** Only validated root publication identities may create a version-2 durable obligation. */
export interface RequiredConfirmedPublicationV1 extends ConfirmedVmIdentityAndTimingV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly subGraphName: null;
  readonly catalogObligationRequired: true;
}
