// SPDX-License-Identifier: Apache-2.0

export interface ContextGraphJoinResult {
  ok: boolean;
  status: string;
  delivered: number | 'local';
  queued?: boolean;
  alreadyMember?: boolean;
  autoApproved?: boolean;
  /**
   * `approved-metadata-pending`: the curator approved this agent already and
   * the graph's member list is still on its way, so no request was sent.
   */
  joinState?: 'approved-metadata-pending';
}
