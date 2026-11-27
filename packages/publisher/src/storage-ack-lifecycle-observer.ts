import type {
  PublishIntentMsg,
  StorageACKMsg,
} from '@origintrail-official/dkg-core';
import {
  Logger,
  createOperationContext,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  logKaLifecycleEvent,
  type KaLifecycleLogDetail,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { StorageAckDecision, StorageAckDecisionObserver } from './storage-ack-handler.js';

const DEFAULT_STORAGE_ACK_LIFECYCLE_RESOLVE_TIMEOUT_MS = 250;
const MAX_OBSERVER_LOG_MESSAGE_CHARS = 240;

type StorageAckLifecycleValue = string | number | bigint | (() => string | number | bigint | undefined);

export interface StorageAckLifecycleObserverOptions {
  localPeerId: StorageAckLifecycleValue;
  localNodeIdentityId: StorageAckLifecycleValue;
  shouldObserve?: (decision: StorageAckDecision) => boolean;
  detailForDecision?: (decision: StorageAckDecision) => KaLifecycleLogDetail | undefined;
  resolveAssetUalForPublishIntent: (input: {
    intent: PublishIntentMsg;
    ack: StorageACKMsg;
    peerId: string;
  }) => string | undefined | Promise<string | undefined>;
  logger?: Logger;
  resolveTimeoutMs?: number;
  detail?: KaLifecycleLogDetail;
}

export function createStorageAckLifecycleObserver(
  options: StorageAckLifecycleObserverOptions,
): StorageAckDecisionObserver {
  const log = options.logger ?? new Logger('StorageACKHandler');
  const resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_STORAGE_ACK_LIFECYCLE_RESOLVE_TIMEOUT_MS;

  return async (decision: StorageAckDecision) => {
    if (!decision.intent) return;
    if (options.shouldObserve && !options.shouldObserve(decision)) return;
    const ack = decision.ack;
    const declined = isStorageACKDecline(ack);
    const assetUal = await resolveAssetUalWithDeadline({
      decision,
      log,
      resolveTimeoutMs,
      resolveAssetUalForPublishIntent: options.resolveAssetUalForPublishIntent,
    });
    if (!assetUal) return;
    const localPeerId = resolveLifecycleValue(options.localPeerId);
    const localNodeIdentityId = resolveLifecycleValue(options.localNodeIdentityId);
    if (!localPeerId || !localNodeIdentityId) return;

    const signatureR = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR
      : new Uint8Array(ack.coreNodeSignatureR ?? []);
    const signatureVS = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS
      : new Uint8Array(ack.coreNodeSignatureVS ?? []);

    logKaLifecycleEvent(log, createOperationContext('share'), {
      assetUal,
      stage: 'storage_ack',
      event: declined ? 'storage_ack_declined' : 'storage_ack_signed',
      role: 'receiver',
      localPeerId,
      localNodeIdentityId,
      peer: decision.peerId,
      detail: options.detailForDecision?.(decision) ?? options.detail,
      level: declined ? 'warn' : 'info',
      metadata: {
        contextGraphId: ack.contextGraphId,
        declineCode: declined ? ack.declineCode : undefined,
        declineMessage: declined ? ack.declineMessage : undefined,
        retryable: declined ? isTransientStorageACKDeclineCode(ack.declineCode) : undefined,
        ackNodeIdentityId: declined ? undefined : String(ack.nodeIdentityId),
        merkleRoot: declined ? undefined : ethers.hexlify(ack.merkleRoot),
        signatureRBytes: declined ? undefined : signatureR.length,
        signatureVSBytes: declined ? undefined : signatureVS.length,
        subscriptionSource: declined ? undefined : ack.subscriptionSource,
      },
    });
  };
}

async function resolveAssetUalWithDeadline(input: {
  decision: StorageAckDecision;
  log: Logger;
  resolveTimeoutMs: number;
  resolveAssetUalForPublishIntent: StorageAckLifecycleObserverOptions['resolveAssetUalForPublishIntent'];
}): Promise<string | undefined> {
  if (input.resolveTimeoutMs <= 0) {
    return input.resolveAssetUalForPublishIntent({
      intent: input.decision.intent!,
      ack: input.decision.ack,
      peerId: input.decision.peerId,
    });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      input.log.warn(
        createOperationContext('share'),
        `StorageACK lifecycle assetUal resolver exceeded ${input.resolveTimeoutMs}ms; continuing without receiver ACK assetUal`,
      );
      resolve(undefined);
    }, input.resolveTimeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();
  });

  try {
    return await Promise.race([
      input.resolveAssetUalForPublishIntent({
        intent: input.decision.intent!,
        ack: input.decision.ack,
        peerId: input.decision.peerId,
      }),
      timeoutResult,
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    input.log.warn(
      createOperationContext('share'),
      `StorageACK lifecycle assetUal resolver failed: ${compactObserverText(reason)}`,
    );
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveLifecycleValue(value: StorageAckLifecycleValue): string | undefined {
  try {
    const resolved = typeof value === 'function' ? value() : value;
    return resolved === undefined ? undefined : resolved.toString();
  } catch {
    return undefined;
  }
}

function compactObserverText(value: string): string {
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (compacted.length <= MAX_OBSERVER_LOG_MESSAGE_CHARS) return compacted;
  return `${compacted.slice(0, Math.max(0, MAX_OBSERVER_LOG_MESSAGE_CHARS - 3))}...`;
}
