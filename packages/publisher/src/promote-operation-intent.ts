// SPDX-License-Identifier: Apache-2.0

/** Preserve the public share operation identifier format for both admission paths. */
export function createShareOperationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Durable v1 envelope, shared by creation, replay validation and finalization. */
export type PromoteOperationIntent = Readonly<{
  version: 1;
  operationId: string;
  timestampMs: number;
  publisherPeerId?: string;
  confirmationRequired: boolean;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: readonly string[];
}>;

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

function canonicalizeAllowedPeers(peers: readonly string[]): readonly string[] {
  return [...new Set(peers.map((peer) => peer.trim()).filter(Boolean))].sort();
}

export function assertPromoteOperationIntent(
  parsed: unknown,
  expectedOperationId: string,
): asserts parsed is PromoteOperationIntent {
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
    && allowedPeers.length === canonicalAllowedPeers.length
    && allowedPeers.every((peer, index) => peer === canonicalAllowedPeers[index])
    && ((accessPolicy === 'allowList') === (canonicalAllowedPeers.length > 0));
  if (!valid) {
    throw Object.assign(
      new Error(`Durable promote intent for operation ${expectedOperationId} is missing or corrupt`),
      { code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' },
    );
  }
}

/** Validate a caller-owned object, then return an immutable independent snapshot. */
export function validatePromoteOperationIntent(parsed: unknown, expectedOperationId: string): PromoteOperationIntent {
  assertPromoteOperationIntent(parsed, expectedOperationId);
  return Object.freeze({
    version: 1, operationId: parsed.operationId, timestampMs: parsed.timestampMs,
    ...(parsed.publisherPeerId ? { publisherPeerId: parsed.publisherPeerId } : {}),
    confirmationRequired: parsed.confirmationRequired, accessPolicy: parsed.accessPolicy,
    allowedPeers: Object.freeze([...parsed.allowedPeers]),
  });
}
