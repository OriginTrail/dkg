import type { Quad } from '@origintrail-official/dkg-storage';
import {
  batchRejectionAssertionName,
  batchRejectionRecordToQuads,
  buildBatchRejectionRecord,
  type BatchRejectionRecord,
  type VerifyBatchResult,
} from './verify-batch.js';

export interface BatchRejectionAgentLaneOptions {
  agentAddress?: string;
}

export interface BatchRejectionAuthorLaneOptions extends BatchRejectionAgentLaneOptions {
  authorAgentAddress?: string;
}

export interface BatchRejectionReporterAgent {
  readonly assertion: {
    create(contextGraphId: string, name: string, opts?: BatchRejectionAgentLaneOptions): Promise<unknown>;
    write(contextGraphId: string, name: string, quads: Quad[], opts?: BatchRejectionAgentLaneOptions): Promise<unknown>;
    finalize(contextGraphId: string, name: string, opts?: BatchRejectionAuthorLaneOptions): Promise<unknown>;
    promote(
      contextGraphId: string,
      name: string,
      opts?: BatchRejectionAuthorLaneOptions,
    ): Promise<{ shareOperationId?: string; promotedCount?: number }>;
  };
  readonly peerId?: string;
}

export interface ReportBatchRejectionInput {
  contextGraphId: string;
  batchId?: string;
  verifyResult: VerifyBatchResult;
  rejectedBy?: { agentAddress: string; peerId?: string };
  agentAddress?: string;
}

export interface ReportBatchRejectionResult {
  record: BatchRejectionRecord;
  assertionName: string;
  gossiped: boolean;
  shareOperationId?: string;
  promotedCount?: number;
  gossipError?: string;
}

export async function reportBatchRejectionWithLifecycle(
  agent: BatchRejectionReporterAgent,
  input: ReportBatchRejectionInput,
): Promise<ReportBatchRejectionResult> {
  const rejectedBy = input.rejectedBy ?? {
    agentAddress: input.agentAddress ?? agent.peerId ?? 'unknown',
    peerId: agent.peerId,
  };
  const record = buildBatchRejectionRecord({
    contextGraphId: input.contextGraphId,
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    verifyResult: input.verifyResult,
    rejectedBy,
  });
  const assertionName = batchRejectionAssertionName(record);
  const quads = batchRejectionRecordToQuads(record);
  const lane: BatchRejectionAgentLaneOptions = input.agentAddress ? { agentAddress: input.agentAddress } : {};
  const authorLane: BatchRejectionAuthorLaneOptions = input.agentAddress ? { ...lane, authorAgentAddress: input.agentAddress } : {};

  try {
    await agent.assertion.create(input.contextGraphId, assertionName, lane);
    await agent.assertion.write(input.contextGraphId, assertionName, quads, lane);
    await agent.assertion.finalize(input.contextGraphId, assertionName, authorLane);
    const share = await agent.assertion.promote(input.contextGraphId, assertionName, authorLane);
    return {
      record,
      assertionName,
      gossiped: true,
      promotedCount: share.promotedCount,
      ...(share.shareOperationId ? { shareOperationId: share.shareOperationId } : {}),
    };
  } catch (err) {
    return {
      record,
      assertionName,
      gossiped: false,
      gossipError: err instanceof Error ? err.message : String(err),
    };
  }
}
