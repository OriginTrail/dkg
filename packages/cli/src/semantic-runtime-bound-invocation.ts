import { createHash } from 'node:crypto';

import type { SignedAgentDelegation } from '@origintrail-official/dkg-agent';
import { sparqlIri, validateContextGraphId } from '@origintrail-official/dkg-core';

/** No caller-selected source, executor, query, parameters or output layer. */
export interface BoundSemanticInboxInvocationV3 {
  version: 3;
  kind: 'bound-operation';
  contextGraphId: string;
  operationIri: string;
  invocationId: string;
  authorization: SignedAgentDelegation;
}

export type UnsignedBoundSemanticInvocation = Omit<BoundSemanticInboxInvocationV3, 'authorization'>;

export function assertBoundSemanticInvocation(value: unknown): asserts value is UnsignedBoundSemanticInvocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_BOUND_INVOCATION');
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !['version', 'kind', 'contextGraphId', 'operationIri', 'invocationId', 'authorization'].includes(key))
    || request.version !== 3 || request.kind !== 'bound-operation'
    || typeof request.contextGraphId !== 'string' || !validateContextGraphId(request.contextGraphId).valid
    || typeof request.operationIri !== 'string' || request.operationIri.length > 2_048
    || !/^[a-z][a-z0-9+.-]*:/i.test(request.operationIri)
    || typeof request.invocationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.invocationId)) {
    throw new Error('INVALID_BOUND_INVOCATION');
  }
  sparqlIri(request.operationIri);
}

/** Version and kind separate operation grants from ordinary Program invocation. */
export function boundSemanticInvocationScope(request: UnsignedBoundSemanticInvocation, targetPeerId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([
    request.version, request.kind, request.contextGraphId, request.operationIri,
    request.invocationId.toLowerCase(), targetPeerId,
  ])).digest('hex');
  return `dkg.semantic-runtime.bound-operation.v3:${digest}`;
}
