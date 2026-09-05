// SPDX-License-Identifier: Apache-2.0

/** Durable v1 envelope, shared by creation, replay validation and finalization. */
export type PromoteOperationIntent = {
  version: 1;
  operationId: string;
  timestampMs: number;
  publisherPeerId?: string;
  confirmationRequired: boolean;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
};

type CreatePromoteOperationIntentInput = Omit<
  PromoteOperationIntent,
  'version' | 'allowedPeers'
> & { allowedPeers?: readonly string[] };

export function parsePromoteOperationIntent(
  rawValue: string,
  expectedOperationId: string,
): PromoteOperationIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = undefined;
  }
  return validatePromoteOperationIntent(parsed, expectedOperationId);
}

/** Normalize fresh caller input; replay always uses the previously parsed envelope. */
export function createPromoteOperationIntent(
  input: CreatePromoteOperationIntentInput,
): PromoteOperationIntent {
  const allowedPeers = canonicalizeAllowedPeers(input.allowedPeers ?? []);
  if (input.accessPolicy === 'allowList' && allowedPeers.length === 0) {
    throw new Error('Graph-scoped assertion allowList policy requires allowedPeers');
  }
  if (input.accessPolicy !== 'allowList' && allowedPeers.length > 0) {
    throw new Error('Graph-scoped assertion allowedPeers requires allowList policy');
  }
  const publisherPeerId = input.publisherPeerId?.trim();
  return validatePromoteOperationIntent({
    version: 1,
    operationId: input.operationId,
    timestampMs: input.timestampMs,
    ...(publisherPeerId ? { publisherPeerId } : {}),
    confirmationRequired: input.confirmationRequired,
    accessPolicy: input.accessPolicy,
    allowedPeers,
  }, input.operationId);
}

/** Preserve the v1 JSON field order and reject corrupt in-memory envelopes too. */
export function serializePromoteOperationIntent(intent: PromoteOperationIntent): string {
  return JSON.stringify(validatePromoteOperationIntent(intent, intent.operationId));
}

function canonicalizeAllowedPeers(peers: readonly string[]): string[] {
  return [...new Set(peers.map((peer) => peer.trim()).filter(Boolean))].sort();
}

function validatePromoteOperationIntent(
  parsed: unknown,
  expectedOperationId: string,
): PromoteOperationIntent {
  const candidate = parsed as Partial<PromoteOperationIntent> | undefined;
  const publisherPeerId = candidate?.publisherPeerId;
  const allowedPeers = candidate?.allowedPeers;
  const canonicalAllowedPeers = Array.isArray(allowedPeers) && allowedPeers.every((peer) => typeof peer === 'string')
    ? canonicalizeAllowedPeers(allowedPeers)
    : [];
  const accessPolicy = candidate?.accessPolicy;
  const valid = candidate?.version === 1
    && candidate.operationId === expectedOperationId
    && Number.isSafeInteger(candidate.timestampMs)
    && Number(candidate.timestampMs) > 0
    && (publisherPeerId === undefined
      || (typeof publisherPeerId === 'string'
        && publisherPeerId.length > 0
        && publisherPeerId === publisherPeerId.trim()))
    && typeof candidate.confirmationRequired === 'boolean'
    && (accessPolicy === 'public' || accessPolicy === 'ownerOnly' || accessPolicy === 'allowList')
    && Array.isArray(allowedPeers)
    && allowedPeers.every((peer) => typeof peer === 'string')
    && JSON.stringify(allowedPeers) === JSON.stringify(canonicalAllowedPeers)
    && ((accessPolicy === 'allowList') === (canonicalAllowedPeers.length > 0));
  if (!valid) {
    throw Object.assign(
      new Error(`Durable promote intent for operation ${expectedOperationId} is missing or corrupt`),
      { code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' },
    );
  }
  return {
    version: 1,
    operationId: expectedOperationId,
    timestampMs: candidate.timestampMs!,
    ...(publisherPeerId ? { publisherPeerId } : {}),
    confirmationRequired: candidate.confirmationRequired!,
    accessPolicy,
    allowedPeers: canonicalAllowedPeers,
  };
}
