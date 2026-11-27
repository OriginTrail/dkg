import type { ContextGraphJoinPolicyStore } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';

/** The agent's join policy, its audit and the automatic-approval ledger, kept in the node's dashboard database. */
export function createContextGraphJoinPolicyStore(dashDb: DashboardDB): ContextGraphJoinPolicyStore {
  return {
    load: async (contextGraphId) => dashDb.getContextGraphJoinPolicy(contextGraphId),
    save: async (record) => {
      dashDb.setContextGraphJoinPolicy(record);
    },
    appendAudit: async (event) => {
      dashDb.appendContextGraphJoinPolicyAudit(event);
    },
    saveWithAudit: async (record, event) => {
      dashDb.setContextGraphJoinPolicyWithAudit(record, event);
    },
    getAutomaticApprovalUsage: async (contextGraphId, timestamp) =>
      dashDb.getContextGraphAutomaticApprovalUsage(contextGraphId, timestamp),
    reserveAutomaticApproval: async (input) =>
      dashDb.reserveContextGraphAutomaticApproval(input),
    markAutomaticApprovalRepairPending: async (input) =>
      dashDb.markContextGraphAutomaticApprovalRepairPending(input),
    releaseAutomaticApproval: async (input) =>
      dashDb.releaseContextGraphAutomaticApproval(input),
    getAutomaticApprovalRepair: async (contextGraphId, requestDigest) =>
      dashDb.getContextGraphAutomaticApprovalRepair(contextGraphId, requestDigest),
    commitAutomaticApproval: async (input) =>
      dashDb.commitContextGraphAutomaticApproval(input),
  };
}
