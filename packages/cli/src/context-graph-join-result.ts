// SPDX-License-Identifier: Apache-2.0

export interface ContextGraphJoinResult {
  ok: boolean;
  status: string;
  delivered: number | 'local';
  queued?: boolean;
  alreadyMember?: boolean;
  autoApproved?: boolean;
}
