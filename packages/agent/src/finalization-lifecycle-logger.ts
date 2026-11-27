import {
  Logger,
  logKaLifecycleEvent,
  type KaLifecycleLogLevel,
  type KaLifecycleMetadataValue,
  type OperationContext,
} from '@origintrail-official/dkg-core';

export interface FinalizationLifecycleLogOptions {
  localPeerId?: string;
  localNodeIdentityId?: string | number | bigint;
}

export interface FinalizationLifecycleLogOptionsSource {
  getLifecycleLogOptions(): FinalizationLifecycleLogOptions | undefined;
}

export interface FinalizationLifecycleFields {
  ual?: string;
  contextGraphId?: string;
  targetContextGraphId?: string;
  txHash?: string;
  publisherAddress?: string;
  subGraphName?: string;
  blockNumber?: string | number | bigint | { toString(): string };
  batchId?: string | number | bigint | { toString(): string };
  rootEntityCount?: number;
  swmStatementCount?: number;
  outcome?: string;
  retryable?: boolean;
  reason?: string;
  level?: KaLifecycleLogLevel;
}

export interface FinalizationLifecycleDecision {
  event: string;
  fields: FinalizationLifecycleFields;
}

export function finalizationLifecycleDecision(
  event: string,
  fields: FinalizationLifecycleFields,
): FinalizationLifecycleDecision {
  return { event, fields };
}

export class FinalizationLifecycleLogger {
  constructor(
    private readonly log: Logger,
    private readonly options:
      | FinalizationLifecycleLogOptions
      | FinalizationLifecycleLogOptionsSource
      | undefined,
  ) {}

  record(ctx: OperationContext, decision: FinalizationLifecycleDecision): void {
    const msg = decision.fields;
    if (!msg.ual) return;
    const options = this.options && 'getLifecycleLogOptions' in this.options
      ? this.options.getLifecycleLogOptions()
      : this.options;
    logKaLifecycleEvent(this.log, ctx, {
      level: msg.level,
      assetUal: msg.ual,
      stage: 'finalization',
      event: decision.event,
      role: 'receiver',
      localPeerId: options?.localPeerId ?? 'unknown',
      localNodeIdentityId: options?.localNodeIdentityId?.toString() ?? 'unknown',
      metadata: this.metadata(msg),
    });
  }

  private metadata(msg: FinalizationLifecycleFields): Record<string, KaLifecycleMetadataValue> {
    return {
      contextGraphId: msg.contextGraphId,
      targetContextGraphId: msg.targetContextGraphId,
      txHash: msg.txHash,
      publisherAddress: msg.publisherAddress,
      subGraphName: msg.subGraphName,
      blockNumber: msg.blockNumber?.toString(),
      batchId: msg.batchId?.toString(),
      rootEntityCount: msg.rootEntityCount,
      swmStatementCount: msg.swmStatementCount,
      outcome: msg.outcome,
      retryable: msg.retryable,
      reason: msg.reason,
    };
  }
}
