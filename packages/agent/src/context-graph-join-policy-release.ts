// SPDX-License-Identifier: Apache-2.0

/** The part of the join policy store that gives an unused approval reservation back. */
export interface ContextGraphJoinPolicyReservationRelease {
  /**
   * Release an unused reservation: one still reserved and not marked for
   * repair. An admission that ends pending before its membership mutation
   * releases its reservation, so the hourly caps count admissions, not
   * attempts. Returns false when there was nothing to release. Optional:
   * without it a reservation leaves the window by age, as before.
   */
  releaseAutomaticApproval?(input: {
    contextGraphId: string;
    requestDigest: string;
    policyEpoch: number;
    timestamp: number;
    reason: string;
  }): Promise<boolean>;
}
