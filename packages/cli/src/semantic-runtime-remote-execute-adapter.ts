import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  signAgentDelegation,
  type DKGAgent,
  type SignedAgentDelegation,
  type SkillResponse,
} from '@origintrail-official/dkg-agent';
import type { RuntimeAdapterOperation } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';

export const SEMANTIC_RUNTIME_INBOX_SKILL_IRI =
  'https://dkg.origintrail.io/skill#semantic-runtime-invoke';
export const SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS = 5 * 60_000;
const INVOCATION_TIMEOUT_MS = 10 * 60_000;
const MAX_NODE_ID_BYTES = 512;
const MAX_PROGRAM_IRI_BYTES = 2_048;

export type SemanticMemoryLayer = 'wm' | 'swm' | 'vm';
export type SemanticExecutionTarget = 'program-author' | 'target-node';

export interface SemanticInboxInvocationV2 {
  version: 2;
  contextGraphId: string;
  programIri: string;
  invocationId: string;
  programLayer: SemanticMemoryLayer;
  executionLayer: SemanticMemoryLayer;
  executionTarget?: SemanticExecutionTarget;
  authorization: SignedAgentDelegation;
}

export interface RemoteExecuteInput {
  nodeId: string;
  programIri: string;
}

export interface RemoteExecuteResult {
  invocationId: string;
  executionIri: string;
  executionLayer: SemanticMemoryLayer;
  executionUal?: string;
  persisted: true;
}

interface RemoteFailure {
  code: string;
  status: number;
  error: string;
}

class RemoteInvocationRejected extends Error {}

export function createRemoteExecuteAdapter(
  agent: DKGAgent,
  contextGraphId: string,
  executingAgentAddress: string,
  programLayer: SemanticMemoryLayer,
  executionLayer: SemanticMemoryLayer,
): RuntimeAdapterOperation<RemoteExecuteInput, string> {
  const implementationHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
  return {
    id: 'remote-execute',
    version: '1',
    witInterface: 'origintrail:semantic-runtime/remote-execute@0.1.0',
    implementationVersion: '1',
    implementationHash,
    enabled: () => Boolean(resolveExecutionSigner(agent, executingAgentAddress)),
    effectClass: 'remote-execution',
    verb: 'execute',
    idempotencyClass: 'idempotent_with_key',
    reconciliationRule: 'retry-same-wallet-bound-invocation-id',
    validateInput(value): RemoteExecuteInput {
      if (
        typeof value !== 'object'
        || value === null
        || !('nodeId' in value)
        || typeof value.nodeId !== 'string'
        || value.nodeId.length === 0
        || Buffer.byteLength(value.nodeId, 'utf8') > MAX_NODE_ID_BYTES
        || !('programIri' in value)
        || typeof value.programIri !== 'string'
        || value.programIri.length === 0
        || Buffer.byteLength(value.programIri, 'utf8') > MAX_PROGRAM_IRI_BYTES
      ) throw new Error('INVALID_REMOTE_EXECUTE_ARGUMENT');
      return { nodeId: value.nodeId, programIri: value.programIri };
    },
    async dispatch(authorization, input) {
      const isPrivate = await agent.isPrivateContextGraph(contextGraphId).catch(() => false);
      if (!isPrivate) {
        throw new Error(
          'REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED:remote-execute is restricted to private Context Graphs',
        );
      }
      const signer = resolveExecutionSigner(agent, executingAgentAddress);
      if (!signer) throw new Error('EXECUTOR_SIGNATURE_UNAVAILABLE');
      const invocationId = invocationUuid(authorization.effectId);
      const unsigned: Omit<SemanticInboxInvocationV2, 'authorization'> = {
        version: 2,
        contextGraphId,
        programIri: input.programIri,
        invocationId,
        programLayer,
        executionLayer,
        executionTarget: 'target-node',
      };
      const issuedAtMs = Date.now();
      const signed = await signAgentDelegation({
        agentAddress: signer.address,
        scope: semanticInvocationScope(unsigned, input.nodeId),
        issuedAtMs,
        expiresAtMs: issuedAtMs + SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS,
        delegateePeerId: agent.peerId,
        agentPrivateKey: signer.privateKey,
      });
      let response: SkillResponse;
      try {
        response = await agent.invokeSkill(
          input.nodeId,
          SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
          encodeJson({ ...unsigned, authorization: signed }),
          { messageId: invocationId, timeoutMs: INVOCATION_TIMEOUT_MS, requestOwned: true },
        );
      } catch (error) {
        throw new Error(`REMOTE_NODE_UNREACHABLE:${safeMessage(error)}`);
      }
      if (!response.success) {
        const failure = decodeFailure(response.outputData);
        throw new RemoteInvocationRejected(
          `${failure?.code ?? 'REMOTE_INVOCATION_FAILED'}:${failure?.error ?? response.error ?? 'Remote node rejected the invocation'}`,
        );
      }
      const result = decodeRemoteResult(response.outputData, executionLayer);
      if (
        result.invocationId.toLowerCase() !== invocationId
        || (executionLayer === 'vm' && response.resultUal !== result.executionUal)
        || (executionLayer !== 'vm' && (response.resultUal !== undefined || result.executionUal !== undefined))
      ) throw new Error('REMOTE_INVOCATION_RESPONSE_INVALID');
      const output = JSON.stringify({
        executionIri: result.executionIri,
        ...(result.executionUal ? { executionUal: result.executionUal } : {}),
      });
      return {
        status: 'succeeded',
        output,
        evidenceRef: result.executionUal ?? result.executionIri,
      };
    },
    reconcile: async () => ({
      status: 'unknown',
      evidenceRef: 'urn:sr:reconciliation:retry-same-invocation-required',
    }),
    couldHaveReachedTarget: (error) => !(
      error instanceof Error
      && (
        error instanceof RemoteInvocationRejected
        || error.message === 'EXECUTOR_SIGNATURE_UNAVAILABLE'
        || error.message === 'INVALID_REMOTE_EXECUTE_ARGUMENT'
        || error.message.startsWith('PROGRAM_CONTEXT_GRAPH_FORBIDDEN:')
        || error.message.startsWith('REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED:')
      )
    ),
  };
}

export function semanticInvocationScope(
  invocation: Pick<SemanticInboxInvocationV2,
    'version' | 'contextGraphId' | 'programIri' | 'invocationId' | 'programLayer' | 'executionLayer' | 'executionTarget'>,
  targetPeerId: string,
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    invocation.version,
    invocation.contextGraphId,
    invocation.programIri,
    invocation.invocationId.toLowerCase(),
    invocation.programLayer,
    invocation.executionLayer,
    invocation.executionTarget ?? 'program-author',
    targetPeerId,
  ])).digest('hex');
  return `dkg.semantic-runtime.invoke.v2:${digest}`;
}

function resolveExecutionSigner(
  agent: DKGAgent,
  executingAgentAddress: string,
): { address: string; privateKey: string } | null {
  let address: string;
  try {
    address = ethers.getAddress(executingAgentAddress);
  } catch {
    return null;
  }
  const local = agent.resolveLocalAgentAddress(address);
  const privateKey = agent.getCustodialAgentPrivateKey(local);
  return privateKey ? { address, privateKey } : null;
}

function invocationUuid(effectId: string): string {
  const bytes = createHash('sha256').update(`dkg.remote-execute.v1\0${effectId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeRemoteResult(
  value: Uint8Array | undefined,
  executionLayer: SemanticMemoryLayer,
): RemoteExecuteResult {
  let result: Partial<RemoteExecuteResult> | null = null;
  try {
    result = value ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) : null;
  } catch {
    // Report the stable response error below.
  }
  if (
    !result
    || typeof result.invocationId !== 'string'
    || typeof result.executionIri !== 'string'
    || result.executionLayer !== executionLayer
    || (executionLayer === 'vm' && typeof result.executionUal !== 'string')
    || (executionLayer !== 'vm' && result.executionUal !== undefined)
    || result.persisted !== true
  ) throw new Error('REMOTE_INVOCATION_RESPONSE_INVALID');
  return result as RemoteExecuteResult;
}

function decodeFailure(value: Uint8Array | undefined): RemoteFailure | null {
  try {
    const failure = value
      ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as Partial<RemoteFailure>
      : null;
    return failure
      && typeof failure.code === 'string'
      && typeof failure.status === 'number'
      && typeof failure.error === 'string'
      ? failure as RemoteFailure
      : null;
  } catch {
    return null;
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
