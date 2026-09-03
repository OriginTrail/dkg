import {
  signAgentDelegation,
  verifyAgentDelegation,
  type DKGAgent,
  type SkillRequest,
  type SkillResponse,
} from '@origintrail-official/dkg-agent';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import type { SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';

import {
  assertSemanticContextGraphMember,
  invokeStoredSemanticProgram,
  loadStoredSemanticProgram,
  SemanticProgramError,
  type ConfiguredSemanticRuntimeService,
  type SemanticInvocationResult,
  type SemanticProgramChildInvoker,
  type SemanticMemoryLayer,
} from './semantic-runtime.js';
import {
  SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS,
  SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
  semanticInvocationScope,
  type SemanticInboxInvocationV2,
} from './semantic-runtime-remote-execute-adapter.js';

export { SEMANTIC_RUNTIME_INBOX_SKILL_IRI };

const INVOCATION_TIMEOUT_MS = 10 * 60_000;

interface SemanticInboxError {
  code: string;
  status: number;
  error: string;
}

export function registerSemanticRuntimeInboxSkill(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  config: SemanticRuntimeConfig | undefined,
  llmConfig: LlmConfig | undefined,
  deps: { invoke?: typeof invokeStoredSemanticProgram } = {},
): void {
  agent.registerSkill(SEMANTIC_RUNTIME_INBOX_SKILL_IRI, async (request, senderPeerId) => {
    try {
      const invocation = decodeInvocation(request);
      const expectedScope = semanticInvocationScope(invocation, agent.peerId);
      try {
        verifyAgentDelegation(invocation.authorization, { expectedScope });
      } catch {
        throw new SemanticProgramError(
          'INVOCATION_AUTHORIZATION_INVALID',
          'Wallet authorization signature, scope, or validity is invalid',
          403,
        );
      }
      if (invocation.authorization.delegateePeerId !== senderPeerId) {
        throw new SemanticProgramError(
          'INVOCATION_SENDER_MISMATCH',
          'Wallet authorization is not delegated to the sending DKG node',
          403,
        );
      }
      if (
        !Number.isFinite(invocation.authorization.issuedAtMs)
        || typeof invocation.authorization.expiresAtMs !== 'number'
        || !Number.isFinite(invocation.authorization.expiresAtMs)
        || invocation.authorization.expiresAtMs <= invocation.authorization.issuedAtMs
        || invocation.authorization.expiresAtMs - invocation.authorization.issuedAtMs
          > SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS
      ) {
        throw new SemanticProgramError(
          'INVOCATION_AUTHORIZATION_INVALID',
          'Wallet authorization lifetime exceeds five minutes',
          403,
        );
      }
      const callerAgentAddress = checksumAddress(invocation.authorization.agentAddress);
      await assertRemoteSemanticInvocationAllowed(
        agent,
        invocation.contextGraphId,
        callerAgentAddress,
      );
      const program = await loadStoredSemanticProgram(
        agent,
        invocation.contextGraphId,
        invocation.programIri,
        invocation.programLayer,
        callerAgentAddress,
      );
      const executingAgentAddress = invocation.executionTarget === 'target-node'
        ? localCustodialAgent(agent, agent.getDefaultAgentAddress() ?? '')
        : localCustodialAgent(agent, program.authorAgentAddress);
      if (!executingAgentAddress) {
        throw new SemanticProgramError(
          invocation.executionTarget === 'target-node'
            ? 'TARGET_EXECUTOR_NOT_LOCAL'
            : 'PROGRAM_AUTHOR_NOT_LOCAL',
          invocation.executionTarget === 'target-node'
            ? 'This node has no default custodial wallet available to execute the Program'
            : 'This node does not host the Program author wallet',
          409,
        );
      }
      const result = await (deps.invoke ?? invokeStoredSemanticProgram)(
        agent,
        runtime,
        invocation.contextGraphId,
        invocation.programIri,
        invocation.invocationId,
        invocation.programLayer,
        invocation.executionLayer,
        config,
        llmConfig,
        callerAgentAddress,
        executingAgentAddress,
        childInvoker(agent, runtime, config, llmConfig),
      );
      return {
        success: true,
        outputData: encodeJson(result),
        ...(result.executionUal ? { resultUal: result.executionUal } : {}),
      };
    } catch (error) {
      const failure = semanticFailure(error);
      return {
        success: false,
        outputData: encodeJson(failure),
        error: failure.error,
      };
    }
  });
}

export async function invokeSemanticProgramOnAuthorNode(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  programIri: string,
  invocationId: string,
  programLayer: SemanticMemoryLayer,
  executionLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig: LlmConfig | undefined,
  callerAgentAddress: string,
): Promise<SemanticInvocationResult> {
  const caller = checksumAddress(callerAgentAddress);
  // The forwarding node fails closed unless its local policy view confirms a
  // private CG. The author node repeats the same check against its authoritative
  // membership metadata after verifying the signed inbox request.
  const program = await loadStoredSemanticProgram(
    agent,
    contextGraphId,
    programIri,
    programLayer,
    caller,
  );
  if (localCustodialAgent(agent, program.authorAgentAddress)) {
    if (caller.toLowerCase() !== program.authorAgentAddress.toLowerCase()) {
      await assertRemoteSemanticInvocationAllowed(agent, contextGraphId, caller);
    }
    return invokeStoredSemanticProgram(
      agent,
      runtime,
      contextGraphId,
      programIri,
      invocationId,
      programLayer,
      executionLayer,
      config,
      llmConfig,
      caller,
      undefined,
      childInvoker(agent, runtime, config, llmConfig),
    );
  }

  await assertRemoteSemanticInvocationAllowed(agent, contextGraphId, caller);

  const authorPeers = await agent.findAgentPeerIdsByAddress(program.authorAgentAddress, 2);
  if (authorPeers.length === 0) {
    throw new SemanticProgramError(
      'PROGRAM_AUTHOR_NODE_NOT_FOUND',
      `No DKG node is advertised for Program author ${program.authorAgentAddress}`,
      503,
    );
  }
  if (authorPeers.length !== 1) {
    throw new SemanticProgramError(
      'PROGRAM_AUTHOR_NODE_AMBIGUOUS',
      `Program author ${program.authorAgentAddress} is advertised by multiple DKG nodes`,
      409,
    );
  }
  const [authorPeerId] = authorPeers;
  const localCaller = agent.resolveLocalAgentAddress(caller);
  const callerPrivateKey = agent.getCustodialAgentPrivateKey(localCaller);
  if (!callerPrivateKey) {
    throw new SemanticProgramError(
      'CALLER_SIGNATURE_UNAVAILABLE',
      'The invoking wallet must be a custodial agent on the receiving node',
      409,
    );
  }
  const unsigned = {
    version: 2 as const,
    contextGraphId,
    programIri,
    invocationId,
    programLayer,
    executionLayer,
  };
  const issuedAtMs = Date.now();
  const authorization = await signAgentDelegation({
    agentAddress: caller,
    scope: semanticInvocationScope(unsigned, authorPeerId),
    issuedAtMs,
    expiresAtMs: issuedAtMs + SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS,
    delegateePeerId: agent.peerId,
    agentPrivateKey: callerPrivateKey,
  });
  let response: SkillResponse;
  try {
    response = await agent.invokeSkill(
      authorPeerId,
      SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
      encodeJson({ ...unsigned, authorization }),
      {
        messageId: invocationId,
        timeoutMs: INVOCATION_TIMEOUT_MS,
        requestOwned: true,
      },
    );
  } catch (error) {
    throw new SemanticProgramError(
      'PROGRAM_AUTHOR_NODE_UNREACHABLE',
      `Could not invoke the Program author node: ${safeMessage(error)}`,
      503,
    );
  }
  if (!response.success) {
    const failure = decodeFailure(response.outputData);
    throw new SemanticProgramError(
      failure?.code ?? 'REMOTE_INVOCATION_FAILED',
      failure?.error ?? response.error ?? 'Program author node rejected the invocation',
      failure?.status ?? 502,
    );
  }
  const result = decodeResult(response.outputData, executionLayer);
  if (
    result.invocationId.toLowerCase() !== invocationId.toLowerCase()
    || (executionLayer === 'vm' && response.resultUal !== result.executionUal)
    || (executionLayer !== 'vm' && (response.resultUal !== undefined || result.executionUal !== undefined))
  ) {
    throw new SemanticProgramError(
      'REMOTE_INVOCATION_RESPONSE_INVALID',
      'Program author node returned inconsistent Execution persistence evidence',
      502,
    );
  }
  return result;
}

function childInvoker(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  config: SemanticRuntimeConfig | undefined,
  llmConfig: LlmConfig | undefined,
): SemanticProgramChildInvoker {
  return (input) => invokeSemanticProgramOnAuthorNode(
    agent,
    runtime,
    input.contextGraphId,
    input.programIri,
    input.invocationId,
    input.programLayer,
    input.executionLayer,
    config,
    llmConfig,
    input.callerAgentAddress,
  );
}

async function assertRemoteSemanticInvocationAllowed(
  agent: DKGAgent,
  contextGraphId: string,
  callerAgentAddress: string,
): Promise<void> {
  const isPrivate = await agent.isPrivateContextGraph(contextGraphId).catch(() => false);
  if (!isPrivate) {
    throw new SemanticProgramError(
      'REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED',
      'Remote Program invocation is allowed only for a confirmed private Context Graph',
      403,
    );
  }
  await assertSemanticContextGraphMember(agent, contextGraphId, callerAgentAddress);
}

function localCustodialAgent(agent: DKGAgent, authorAgentAddress: string): string | null {
  const local = agent.listLocalAgents().find(({ agentAddress }) =>
    agentAddress.toLowerCase() === authorAgentAddress.toLowerCase());
  if (!local) return null;
  return agent.getCustodialAgentPrivateKey(local.agentAddress) ? local.agentAddress : null;
}

function decodeInvocation(request: SkillRequest): SemanticInboxInvocationV2 {
  const value = decodeJson(request.inputData) as Partial<SemanticInboxInvocationV2> | null;
  if (
    !value
    || value.version !== 2
    || typeof value.contextGraphId !== 'string'
    || typeof value.programIri !== 'string'
    || typeof value.invocationId !== 'string'
    || !isMemoryLayer(value.programLayer)
    || !isMemoryLayer(value.executionLayer)
    || (value.executionTarget !== undefined
      && value.executionTarget !== 'program-author'
      && value.executionTarget !== 'target-node')
    || typeof value.authorization !== 'object'
    || value.authorization === null
  ) {
    throw new SemanticProgramError(
      'INVALID_INBOX_INVOCATION',
      'Semantic inbox invocation is malformed',
      400,
    );
  }
  return value as SemanticInboxInvocationV2;
}

function decodeResult(
  value: Uint8Array | undefined,
  executionLayer: SemanticMemoryLayer,
): SemanticInvocationResult {
  let result: Partial<SemanticInvocationResult> | null = null;
  try {
    result = value ? decodeJson(value) as Partial<SemanticInvocationResult> | null : null;
  } catch {
    // Mapped to the stable remote-response error below.
  }
  if (
    !result
    || typeof result.invocationId !== 'string'
    || typeof result.executionIri !== 'string'
    || result.executionLayer !== executionLayer
    || (executionLayer === 'vm' && typeof result.executionUal !== 'string')
    || (executionLayer !== 'vm' && result.executionUal !== undefined)
    || (result.outputs !== undefined
      && (!Array.isArray(result.outputs)
        || result.outputs.some((output) => typeof output !== 'string')))
    || result.persisted !== true
  ) {
    throw new SemanticProgramError(
      'REMOTE_INVOCATION_RESPONSE_INVALID',
      'Program author node returned a malformed Execution response',
      502,
    );
  }
  return result as SemanticInvocationResult;
}

function isMemoryLayer(value: unknown): value is SemanticMemoryLayer {
  return value === 'wm' || value === 'swm' || value === 'vm';
}

function decodeFailure(value: Uint8Array | undefined): SemanticInboxError | null {
  try {
    const failure = value ? decodeJson(value) as Partial<SemanticInboxError> | null : null;
    return failure
      && typeof failure.code === 'string'
      && typeof failure.status === 'number'
      && typeof failure.error === 'string'
      ? failure as SemanticInboxError
      : null;
  } catch {
    return null;
  }
}

function semanticFailure(error: unknown): SemanticInboxError {
  return error instanceof SemanticProgramError
    ? { code: error.code, status: error.status, error: error.message }
    : { code: 'REMOTE_INVOCATION_FAILED', status: 500, error: safeMessage(error) };
}

function checksumAddress(value: string): string {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new SemanticProgramError('INVALID_CALLER_WALLET', 'Caller wallet is invalid', 400);
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch {
    throw new SemanticProgramError('INVALID_INBOX_INVOCATION', 'Semantic inbox JSON is invalid', 400);
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
