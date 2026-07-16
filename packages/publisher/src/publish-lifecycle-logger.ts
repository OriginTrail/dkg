import {
  Logger,
  logKaLifecycleEvent,
  type KaLifecycleLogLevel,
  type KaLifecycleMetadataValue,
  type KaLifecycleStage,
  type OperationContext,
} from '@origintrail-official/dkg-core';

export interface PublishLifecycleLoggerOptions {
  log: Logger;
  ctx: OperationContext;
  localPeerId: string;
  localNodeIdentityId: string;
  resolveAssetUal: (kaId: bigint) => Promise<string>;
}

export class PublishLifecycleLogger {
  private assetUal: string | undefined;
  private identityAllocatedLogged = false;

  constructor(private readonly options: PublishLifecycleLoggerOptions) {}

  get identityAllocatedEmitted(): boolean {
    return this.identityAllocatedLogged;
  }

  async rememberAssetUal(kaId: bigint | undefined): Promise<string | undefined> {
    if (this.assetUal || kaId === undefined) return this.assetUal;
    try {
      this.assetUal = await this.options.resolveAssetUal(kaId);
    } catch {
      this.assetUal = undefined;
    }
    return this.assetUal;
  }

  setAssetUal(assetUal: string): void {
    this.assetUal = assetUal;
  }

  emit(
    stage: KaLifecycleStage,
    event: string,
    input: {
      level?: KaLifecycleLogLevel;
      peer?: string;
      peerNodeIdentityId?: string;
      metadata?: Record<string, KaLifecycleMetadataValue>;
    } = {},
  ): void {
    if (!this.assetUal) return;
    logKaLifecycleEvent(this.options.log, this.options.ctx, {
      assetUal: this.assetUal,
      stage,
      event,
      role: 'publisher',
      localPeerId: this.options.localPeerId,
      localNodeIdentityId: this.options.localNodeIdentityId,
      peer: input.peer,
      peerNodeIdentityId: input.peerNodeIdentityId,
      level: input.level,
      metadata: input.metadata,
    });
    if (stage === 'identity' && event === 'asset_ual_allocated') {
      this.identityAllocatedLogged = true;
    }
  }
}
