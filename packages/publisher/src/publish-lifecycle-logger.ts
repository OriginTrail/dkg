import {
  Logger,
  logKaLifecycleEvent,
  type KaLifecycleLogLevel,
  type KaLifecycleMetadataValue,
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

  identityAllocated(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('identity', 'asset_ual_allocated', { metadata });
    if (this.assetUal) this.identityAllocatedLogged = true;
  }

  workspaceWritten(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('wm', 'write', { metadata });
  }

  swmSharePrepared(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('swm_share', 'prepared', { metadata });
  }

  storageAckRequested(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('storage_ack', 'request', { metadata });
  }

  storageAckSucceeded(
    peer: string,
    peerNodeIdentityId: string,
    metadata?: Record<string, KaLifecycleMetadataValue>,
  ): void {
    this.emit('storage_ack', 'success', { peer, peerNodeIdentityId, metadata });
  }

  storageAckOutcome(
    event: string,
    input: {
      level?: KaLifecycleLogLevel;
      peer?: string;
      metadata?: Record<string, KaLifecycleMetadataValue>;
    } = {},
  ): void {
    this.emit('storage_ack', event, input);
  }

  storageAckQuorum(
    input: {
      level?: KaLifecycleLogLevel;
      metadata?: Record<string, KaLifecycleMetadataValue>;
    } = {},
  ): void {
    this.emit('storage_ack', 'quorum', input);
  }

  storageAckFailed(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('storage_ack', 'failure', { level: 'warn', metadata });
  }

  chainSubmitted(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('chain', 'submit', { metadata });
  }

  chainConfirmed(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('chain', 'confirm', { metadata });
  }

  chainFailed(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('chain', 'failure', { level: 'error', metadata });
  }

  vmPromoted(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('vm', 'promote', { metadata });
  }

  publishCompleted(metadata?: Record<string, KaLifecycleMetadataValue>): void {
    this.emit('finalization', 'complete', { metadata });
  }

  private emit(
    stage: Parameters<typeof logKaLifecycleEvent>[2]['stage'],
    event: string,
    input: {
      level?: KaLifecycleLogLevel;
      peer?: string;
      peerNodeIdentityId?: string;
      metadata?: Record<string, KaLifecycleMetadataValue>;
    },
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
  }
}
