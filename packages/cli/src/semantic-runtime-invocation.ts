import { ExecutionReceiptJournal } from '@origintrail-official/dkg-semantic-runtime';
import { recoverTerminalExecutionReceipt } from './semantic-runtime-terminal-receipt.js';
import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import { RuntimeEffectBroker, admittedPlanAuthority, encodeCapabilityMetadata, type ComponentToolDispatcher, type SemanticRuntimeConfig, type ExecutionCapabilityDescriptor } from '@origintrail-official/dkg-semantic-runtime';
import { assertSparqlReadOutput } from './semantic-runtime-sparql-adapter.js';
import { programBindingDigest, validateProgramBindings } from './semantic-runtime-program-bindings.js';
import { assertSemanticQueryOutput } from './semantic-runtime-query-pins.js';
import { BoundProgramInvocation, ConfiguredSemanticRuntimeService, InternalResolution, LocalInvocationScope, PersistenceEvidence, SemanticInvocationResult, SemanticMemoryLayer, SemanticProgramChildInvoker, SemanticProgramError, TypeScriptComposition } from './semantic-runtime-types.js';
import { invokeTypeScriptProgram } from './semantic-runtime-typescript-execution.js';
import { assertBoundQueryDefinition, resolveInternal } from './semantic-runtime-resolution.js';
import { bytesEqual, checksumAgentAddress, hashParts, historyIsAtLayer, programPolicyHash, safeMessage, semanticLayerLabel, sourceHashOf, toHex, validateSemanticMemoryLayer } from './semantic-runtime-values.js';
import { assertProgramInvocationAuthorized } from './semantic-runtime-invocation-policy.js';
import { buildExecutionQuads, loadExecutionOutputs, persistExecutionKnowledgeAsset } from './semantic-runtime-execution-persistence.js';

/** Invoke-only access to one tenant-approved, immutable Program/query pair. */
export async function invokeBoundSemanticProgram(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  operationIri: string,
  invocationId: string,
  config: SemanticRuntimeConfig,
  authenticatedCaller: string | undefined,
  inputs?: unknown[],
  composition?: TypeScriptComposition,
): Promise<SemanticInvocationResult> {
  const denied = () => new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'This operation is not authorized for the caller', 403);
  const bindings = config.programBindings ?? [];
  if (!Array.isArray(bindings)) throw new Error('INVALID_PROGRAM_BINDINGS');
  const scopedBindings = bindings.filter((item) => item?.contextGraphId === contextGraphId);
  validateProgramBindings(scopedBindings);
  const selected = scopedBindings.find((item) =>
    item.contextGraphId === contextGraphId && item.operationIri === operationIri);
  if (!authenticatedCaller || !selected?.enabled
    || !selected.allowedCallerAgentAddresses.some((address) => address.toLowerCase() === authenticatedCaller.toLowerCase())) {
    throw denied();
  }
  const binding = structuredClone(selected);
  const digest = programBindingDigest(binding);
  const assertAuthorized = async () => {
    await composition?.assertParent();
    const checkGrant = () => {
      const current = config.programBindings?.find((item) =>
        item.contextGraphId === contextGraphId && item.operationIri === operationIri);
      if (!current?.enabled || programBindingDigest(current) !== digest) throw denied();
    };
    checkGrant();
    for (const graph of new Set([contextGraphId, binding.program.contextGraphId])) {
      if (!(await agent.canReadContextGraph(graph, {
        callerAgentAddress: binding.executorAgentAddress, allowSubscriptionFallback: false,
      }))) throw denied();
    }
    checkGrant();
  };
  await assertAuthorized();
  if (binding.typescript) {
    return invokeTypeScriptProgram(agent, runtime, binding, digest, invocationId, config, authenticatedCaller,
      inputs ?? [], assertAuthorized, composition);
  }
  if (inputs !== undefined && (!Array.isArray(inputs) || inputs.length !== 0)) {
    throw new SemanticProgramError('PROGRAM_INPUTS_UNSUPPORTED', 'S-expression Programs do not accept runtime arguments', 400);
  }
  const result = await invokeStoredSemanticProgram(
    agent, runtime, contextGraphId, binding.program.programIri, invocationId,
    binding.program.programLayer, binding.executionLayer ?? 'wm', config, undefined,
    authenticatedCaller, binding.executorAgentAddress, undefined, undefined,
    { binding, digest, assertAuthorized },
  );
  // Replays and fresh executions both pass the current grant and query contract.
  await assertAuthorized();
  await assertBoundQueryDefinition(agent, binding);
  for (const output of result.outputs ?? []) {
    let parsed: { kind?: unknown; queryIri?: unknown; result?: unknown };
    try { parsed = JSON.parse(output); } catch { throw new SemanticProgramError('PROGRAM_OUTPUT_REJECTED', 'Program output does not match its approved tools', 409); }
    if (parsed?.kind === 'sparql-read' && binding.sparqlRead) {
      try { assertSparqlReadOutput(binding.sparqlRead, contextGraphId, output); }
      catch { throw new SemanticProgramError('PROGRAM_OUTPUT_REJECTED', 'Raw query output differs from its tenant-approved scope or result contract', 409); }
      continue;
    }
    if (parsed?.kind === 'asset-created' && binding.assetCreation) {
      const backed = runtime.store.effectsForExecution(result.executionIri).some((effect) => {
        if (effect.adapterId !== 'dkg/asset-create' || effect.state !== 'succeeded') return false;
        const checkpoint = runtime.store.adapterCheckpoint(effect.effectId);
        return checkpoint && JSON.parse(new TextDecoder().decode(checkpoint.payload)).output === output;
      });
      if (!backed) throw new SemanticProgramError('PROGRAM_OUTPUT_REJECTED', 'Asset receipt lacks a completed creation effect', 409);
      continue;
    }
    if (!binding.query || !parsed || parsed.queryIri !== binding.query.queryIri || Object.keys(parsed).some((key) => !['queryIri', 'result'].includes(key))) {
      throw new SemanticProgramError('PROGRAM_OUTPUT_REJECTED', 'Program output does not match the approved query contract', 409);
    }
    try { assertSemanticQueryOutput(binding.query, parsed.result); }
    catch { throw new SemanticProgramError('PROGRAM_OUTPUT_REJECTED', 'Program output does not match the approved query contract', 409); }
  }
  await assertAuthorized();
  return result;
}

export async function invokeStoredSemanticProgram(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  programIri: string,
  invocationId: string,
  programLayer: SemanticMemoryLayer,
  executionLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
  executingAgentAddress?: string,
  childInvoker?: SemanticProgramChildInvoker,
  scope: LocalInvocationScope = { ancestors: [] },
  bound?: BoundProgramInvocation,
): Promise<SemanticInvocationResult> {
  validateSemanticMemoryLayer(programLayer, 'programLayer');
  validateSemanticMemoryLayer(executionLayer, 'executionLayer');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId)) {
    throw new SemanticProgramError('INVALID_INVOCATION_ID', 'invocationId must be a UUID', 400);
  }
  if (config?.programPolicy && (scope.ancestors.includes(programIri) || scope.ancestors.length >= 8)) {
    throw new SemanticProgramError('PROGRAM_COMPOSITION_LIMIT', 'Pinned Program composition is cyclic or exceeds eight levels', 403);
  }
  const requestIdentity = hashParts([
    programIri, programLayer, executionLayer, callerAgentAddress?.toLowerCase() ?? '',
    executingAgentAddress?.toLowerCase() ?? '', programPolicyHash(config), ...(bound ? [bound.digest] : []), ...scope.ancestors,
  ]);
  const key = `${contextGraphId}\0${invocationId.toLowerCase()}`;
  const existing = runtime.inFlight.get(key);
  if (existing) {
    if (existing.requestIdentity !== requestIdentity) {
      throw new SemanticProgramError(
        'INVOCATION_LAYER_CONFLICT',
        'invocationId is already running with different Program, caller, policy or layers',
        409,
      );
    }
    return existing.promise;
  }
  const invocation = invokeResolved(
    agent,
    runtime,
    contextGraphId,
    programIri,
    invocationId.toLowerCase(),
    programLayer,
    executionLayer,
    config,
    llmConfig,
    callerAgentAddress,
    executingAgentAddress,
    childInvoker,
    scope,
    bound,
  );
  runtime.inFlight.set(key, { requestIdentity, promise: invocation });
  try {
    return await invocation;
  } finally {
    runtime.inFlight.delete(key);
  }
}

/** Both language front ends use this broker, capability and durable write journal. */
export function createProgramToolDispatcher(
  runtime: ConfiguredSemanticRuntimeService,
  resolved: Pick<InternalResolution, 'public' | 'registry' | 'policyHashHex'>,
  authority: import('@origintrail-official/dkg-semantic-runtime').AdmittedPlanAuthority,
  executionIri: string, invocationId: string, assertAuthorized: () => Promise<void>, bound?: BoundProgramInvocation,
): (toolIri: string, input: unknown, callId: string) => Promise<string> {
  const policyFactsDigest = Uint8Array.from(Buffer.from(resolved.policyHashHex, 'hex'));
  const broker = new RuntimeEffectBroker(
    runtime.store,
    {
      evaluate: async () => {
        await assertAuthorized();
        return {
          decision: 'allow',
          policyId: resolved.public.selectedPolicy.iri,
          policyEpoch: 1n,
          factsDigest: policyFactsDigest,
          reasonCode: bound ? 'TENANT_PROGRAM_BINDING_ALLOW' : 'OPERATOR_POLICY_ALLOW',
        };
      },
    },
    resolved.registry,
    authority,
  );
  const capabilityId = `urn:sr:capability:${invocationId}`;
  if (!runtime.store.capability(capabilityId)) {
    const now = Date.now();
    const capabilityVerbs = [...new Set(resolved.public.requiredTools.flatMap((tool) => {
      if (!tool.operation || !tool.semanticVersion) return [];
      const descriptor = resolved.registry.describe(tool.operation, tool.semanticVersion);
      return descriptor ? [descriptor.verb] : [];
    }))];
    const readOnly = [...authority.allowedEffectClasses].every(effectClass => effectClass === 'read');
    // Bound TypeScript Programs spend their shared maxCalls budget per tool.
    // Non-repeatable effects retain separate durable call IDs; consuming the
    // execution-wide capability on their first call would also disable reads.
    runtime.store.putCapability({
      capabilityId,
      executionId: executionIri,
      metadataCbor: encodeCapabilityMetadata({
        subject: resolved.public.executingNode,
        audience: 'dkg-semantic-runtime',
        executionId: executionIri,
        verbs: capabilityVerbs,
        resources: resolved.public.requiredTools.map(tool => tool.toolIri),
        delegationDepth: 0,
        oneShot: !bound?.binding.typescript && !readOnly && !authority.adapterVersions.has('dkg/asset-create'),
        budgetMicros: 0n,
      }),
      hostBindingKey: resolved.public.requiredTools[0]?.adapterHash ?? 'no-adapter',
      policyEpoch: 1n,
      notBefore: now - 1_000,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      oneShot: !bound?.binding.typescript && !readOnly && !authority.adapterVersions.has('dkg/asset-create'),
      consumedAt: null,
      revokedAt: null,
    });
  }

  return async (toolIri, input, callId) => {
    await assertAuthorized();
    const tool = resolved.public.requiredTools.find(candidate => candidate.toolIri === toolIri);
    if (!tool) throw new SemanticProgramError('UNSUPPORTED_PROGRAM_TOOL', 'Tool is not declared and approved', 403);
    if (bound && tool.operation === 'dkg/query') {
      const value = input as { selector?: unknown; parameters?: unknown } | null;
      if (!value || value.selector !== bound.binding.query?.selector
        || (value.parameters !== undefined && (!value.parameters || typeof value.parameters !== 'object'
          || Array.isArray(value.parameters) || Object.keys(value.parameters).length))) {
        throw new SemanticProgramError('PROGRAM_BINDING_QUERY_FORBIDDEN', 'Only the approved catalog query with fixed arguments can be invoked', 403);
      }
    }
    const descriptor = resolved.registry.describe(tool.operation!, tool.semanticVersion!);
    if (!descriptor || !tool.effective) {
      throw new SemanticProgramError('UNSUPPORTED_PROGRAM_TOOL', 'Unsupported WASI tool import', 422);
    }
    const effectId = `urn:sr:effect:${invocationId}:${callId}`;
    const proposal = {
      effectId,
      executionId: executionIri,
      processId: `tool:${tool.operation}`,
      stepId: `tool-${callId}`,
      attemptId: 'attempt-1',
      principal: resolved.public.executingNode,
      adapterId: tool.operation!,
      adapterVersion: tool.semanticVersion!,
      verb: descriptor.verb,
      resource: tool.toolIri,
      normalizedInput: input,
      capabilityId,
      idempotencyKey: `${executionIri}:${callId}`,
      budgetReservation: 0n,
      now: Date.now(),
    };
    let outcome;
    if (descriptor.effectClass === 'read') {
      try {
        outcome = await broker.dispatchRead(proposal);
      } catch (error) {
        throw new SemanticProgramError(
          'QUERY_REQUEST_FAILED',
          `DKG query failed: ${safeMessage(error)}`,
          502,
        );
      }
    } else {
      await broker.prepareEffect(proposal);
      outcome = broker.readOutcome(effectId);
      if (outcome?.state === 'prepared') {
        await broker.dispatchPrepared(effectId, Date.now());
        outcome = broker.readOutcome(effectId);
      } else if (tool.operation === 'dkg/asset-create' && ['unknown', 'reconciling', 'manual_review_required'].includes(outcome?.state ?? '')) {
        await broker.resumeUnknown(effectId, Date.now());
        outcome = broker.readOutcome(effectId);
      }
    }
    if (outcome?.state !== 'succeeded' || typeof outcome.output !== 'string') {
      if (outcome?.state === 'dispatching' || outcome?.state === 'unknown' || outcome?.state === 'reconciling' || outcome?.state === 'manual_review_required') {
        throw new SemanticProgramError(
          'INVOCATION_REQUIRES_RECONCILIATION',
          'The tool call may have reached its target; it will not be dispatched again automatically',
          409,
        );
      }
      throw new SemanticProgramError('TOOL_REQUEST_FAILED', 'WASI tool request failed', 502);
    }
    await assertAuthorized();
    return outcome.output;
  };
}

export async function invokeResolved(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  programIri: string,
  invocationId: string,
  programLayer: SemanticMemoryLayer,
  executionLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
  executingAgentAddress?: string,
  childInvoker?: SemanticProgramChildInvoker,
  scope: LocalInvocationScope = { ancestors: [] },
  bound?: BoundProgramInvocation,
): Promise<SemanticInvocationResult> {
  const pinnedPolicyHash = bound ? '' : programPolicyHash(config);
  const assertAuthorized = async () => {
    await bound?.assertAuthorized();
    if (!pinnedPolicyHash) return;
    if (!config?.programPolicy || programPolicyHash(config) !== pinnedPolicyHash) {
      throw new SemanticProgramError('PROGRAM_POLICY_CHANGED', 'Operator Program policy changed during execution', 403);
    }
    await scope.assertAncestors?.();
    await assertProgramInvocationAuthorized({
      agent, runtime, executionId: `urn:sr:execution:${invocationId}`, config, contextGraphId,
      program: resolved.program, originalCaller: callerAgentAddress ?? resolved.program.authorAgentAddress,
      operatorAddress: resolved.operatorAddress, policyIri: resolved.public.selectedPolicy.iri,
      policyHashHex: resolved.policyHashHex,
    });
  };
  const pinnedChildInvoker: SemanticProgramChildInvoker = async (input) => {
    await assertAuthorized();
    return invokeStoredSemanticProgram(
      agent, runtime, input.contextGraphId, input.programIri, input.invocationId,
      input.programLayer, input.executionLayer, config, llmConfig, input.callerAgentAddress, undefined,
      undefined, { ancestors: [...scope.ancestors, programIri], assertAncestors: assertAuthorized },
    );
  };
  const resolved = await resolveInternal({ agent, contextGraphId, programIri, programLayer, config, llmConfig,
    callerAgentAddress, executingAgentAddress, executionLayer,
    childInvoker: config?.programPolicy ? pinnedChildInvoker : childInvoker,
    assertAuthorized, bound, assetStore: runtime.store });
  const localOperator = agent.listLocalAgents().find(({ agentAddress }) =>
    agentAddress.toLowerCase() === resolved.operatorAddress.toLowerCase());
  if (!localOperator || !agent.getCustodialAgentPrivateKey(localOperator.agentAddress)) {
    throw new SemanticProgramError(
      executingAgentAddress ? 'TARGET_EXECUTOR_NOT_LOCAL' : 'PROGRAM_AUTHOR_NOT_LOCAL',
      executingAgentAddress
        ? 'This node does not host the selected executor wallet as a custodial agent'
        : 'This node does not host the Program author wallet as a custodial agent',
      409,
    );
  }
  resolved.operatorAddress = localOperator.agentAddress;
  const unavailable = resolved.public.requiredTools.find((tool) => !tool.effective);
  if (unavailable) {
    throw new SemanticProgramError(
      'REQUIRED_TOOL_UNAVAILABLE',
      `${unavailable.toolIri} is unavailable: ${unavailable.unavailableReason}`,
      409,
    );
  }
  const executionIri = `urn:sr:execution:${invocationId}`;
  const assertionName = `semantic-execution-${invocationId}`;
  const priorHistory = await agent.assertion.history(contextGraphId, assertionName, {
    agentAddress: resolved.operatorAddress,
  });
  const existingExecution = runtime.store.execution(executionIri);
  const executionGraphRevision = hashParts([
    resolved.policyHashHex,
    sourceHashOf(resolved.program),
    (callerAgentAddress ?? resolved.operatorAddress).toLowerCase(),
    pinnedPolicyHash,
    ...(bound ? [bound.digest] : []),
    ...scope.ancestors,
    contextGraphId,
    programIri,
    programLayer,
    executionLayer,
  ]);
  const journal = new ExecutionReceiptJournal(runtime.store, executionIri);
  if (journal.terminal && existingExecution && ['active', 'completed'].includes(existingExecution.status)) {
    return recoverTerminalExecutionReceipt(agent, runtime.store, journal, {
      contextGraphId, name: assertionName, agentAddress: resolved.operatorAddress,
      layer: executionLayer, requestIdentity: executionGraphRevision,
    }, invocationId, assertAuthorized);
  }
  if (existingExecution?.status === 'completed') {
    if (existingExecution.graphRevision !== executionGraphRevision) {
      throw new SemanticProgramError(
        'INVOCATION_LAYER_CONFLICT',
        'invocationId was already completed with different Program, caller, policy or layers',
        409,
      );
    }
    if (!priorHistory || !historyIsAtLayer(priorHistory, executionLayer)) {
      throw new SemanticProgramError(
        'EXECUTION_PERSISTENCE_INCONSISTENT',
        `Invocation journal says completed but its Execution KA is not in ${semanticLayerLabel(executionLayer)}`,
        500,
      );
    }
    return {
      invocationId,
      executionIri,
      executionLayer,
      ...(executionLayer === 'vm' ? { executionUal: priorHistory.publishedUal } : {}),
      outputs: await loadExecutionOutputs(
        agent,
        contextGraphId,
        executionIri,
        executionLayer,
        resolved.operatorAddress,
      ),
      persisted: true,
    };
  }
  if (existingExecution && existingExecution.graphRevision !== executionGraphRevision) {
    throw new SemanticProgramError(
      'INVOCATION_LAYER_CONFLICT',
      'invocationId already belongs to different Program, caller, policy or layers',
      409,
    );
  }
  if (existingExecution && existingExecution.status !== 'active') {
    throw new SemanticProgramError(
      'INVOCATION_NOT_RETRYABLE',
      `Invocation is ${existingExecution.status} and will not be dispatched again`,
      409,
    );
  }

  const artifactHash = toHex(resolved.plan.canonicalHash);
  runtime.store.registerStrategyArtifact({
    artifactHash,
    strategyId: resolved.plan.strategyRef,
    version: resolved.program.version,
    canonicalPlan: resolved.plan.canonicalPlan,
    sourceRef: resolved.program.programIri,
    reviewState: 'approved',
    createdAt: Date.now(),
  });
  if (!existingExecution) {
    try {
      runtime.store.createExecution({
        executionId: executionIri,
        planId: artifactHash,
        partitionId: hashParts([contextGraphId]),
        status: 'active',
        graphRevision: executionGraphRevision,
        policyEpoch: 1n,
        rootProcessId: executionIri,
        leaseEpoch: 0n,
      });
    } catch (error) {
      const concurrent = runtime.store.execution(executionIri);
      if (!concurrent) throw error;
      if (concurrent.graphRevision !== executionGraphRevision) {
        throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'invocationId belongs to a different invocation', 409);
      }
    }
  }

  const startedAt = new Date();
  const capability: ExecutionCapabilityDescriptor = {
    executionId: executionIri,
    invocationId,
    contextGraphId,
    callerPrincipal: callerAgentAddress
      ? `did:dkg:agent:${callerAgentAddress}`
      : resolved.public.executingNode,
    programIri,
    sourceHash: createHash('sha256').update(resolved.program.source, 'utf8').digest('hex'),
    planHash: artifactHash,
    outputLayer: executionLayer.toUpperCase() as ExecutionCapabilityDescriptor['outputLayer'],
    tools: resolved.public.requiredTools.map((tool) => ({
      operation: tool.operation!,
      version: tool.semanticVersion!,
      witInterface: tool.witInterface!,
    })),
    policy: {
      iri: resolved.public.selectedPolicy.iri,
      epoch: 1n,
      hash: resolved.policyHashHex,
    },
    budgets: {
      maxOperations: config?.maxOperationsPerExecution ?? 10_000,
      maxToolCalls: resolved.plan.resourceBounds.hostCommands,
      maxModelTokens: resolved.plan.effectUpperBound.includes('model-invocation') ? 512 : 0,
      maxDkgQueries: resolved.plan.effectUpperBound.includes('read') ? resolved.plan.resourceBounds.hostCommands : 0,
    },
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
    revoked: false,
    approvals: [...resolved.plan.approvalRequirements],
  };
  const dispatchTool = createProgramToolDispatcher(runtime, resolved, admittedPlanAuthority(resolved.plan),
    executionIri, invocationId, assertAuthorized, bound);
  const childExecutions: string[] = [];
  const toolDispatcher: ComponentToolDispatcher = async (call) => {
    if (bound && !(call.kind === 'asset-create' && bound.binding.assetCreation)
      && !(call.kind === 'sparql-read' && bound.binding.sparqlRead)
      && (call.kind !== 'query-catalog' || call.queryId !== bound.binding.query?.selector || call.parameters.length !== 0)) {
      throw new SemanticProgramError('PROGRAM_BINDING_QUERY_FORBIDDEN', 'Only the tenant-approved tools and fixed query arguments can be invoked', 403);
    }
    const binding = call.kind === 'investigator'
      ? {
        operation: 'agent/investigate',
        version: '1',
        normalizedInput: { prompt: call.prompt },
      }
      : call.kind === 'safe-llm' ? {
        operation: 'llm/safe',
        version: '1',
        normalizedInput: { prompt: call.prompt },
      } : call.kind === 'query-catalog' ? {
        operation: 'dkg/query',
        version: '1',
        normalizedInput: {
          selector: call.queryId,
          parameters: Object.fromEntries(call.parameters.map(({ name, value }) => [name, value])),
        },
      } : call.kind === 'sparql-read' ? {
        operation: 'dkg/sparql-read', version: '1', normalizedInput: { sparql: call.sparql },
      } : call.kind === 'asset-create' ? {
        operation: 'dkg/asset-create', version: '1', normalizedInput: JSON.parse(call.contentJson) as unknown,
      } : {
        operation: 'remote-execute',
        version: '1',
        normalizedInput: { nodeId: call.nodeId, programIri: call.programIri },
      };
    const tool = resolved.public.requiredTools.find((candidate) =>
      candidate.operation === binding.operation
      && candidate.semanticVersion === binding.version);
    if (!tool) throw new SemanticProgramError('UNSUPPORTED_PROGRAM_TOOL', 'Unsupported WASI tool import', 422);
    const outcome = { output: await dispatchTool(tool.toolIri, binding.normalizedInput, String(call.effectId)) };
    if (call.kind === 'investigator') return { kind: 'investigator', output: outcome.output };
    if (call.kind === 'safe-llm') {
      let safeResult: { output?: unknown; childExecutions?: unknown };
      try {
        safeResult = JSON.parse(outcome.output) as typeof safeResult;
      } catch {
        throw new SemanticProgramError('SAFE_LLM_RESPONSE_INVALID', 'Safe LLM result is invalid', 502);
      }
      if (
        typeof safeResult.output !== 'string'
        || !Array.isArray(safeResult.childExecutions)
        || safeResult.childExecutions.some((iri) => typeof iri !== 'string')
      ) throw new SemanticProgramError('SAFE_LLM_RESPONSE_INVALID', 'Safe LLM result is invalid', 502);
      childExecutions.push(...safeResult.childExecutions);
      return { kind: 'safe-llm', output: safeResult.output };
    }
    if (call.kind === 'sparql-read') return { kind: 'sparql-read', json: outcome.output };
    if (call.kind === 'asset-create') return { kind: 'asset-create', json: outcome.output };
    if (call.kind === 'query-catalog') return { kind: 'query-catalog', json: outcome.output };
    let remote: { executionIri?: unknown; executionUal?: unknown };
    try {
      remote = JSON.parse(outcome.output) as typeof remote;
    } catch {
      throw new SemanticProgramError('REMOTE_INVOCATION_RESPONSE_INVALID', 'Remote Execution receipt is invalid', 502);
    }
    if (
      typeof remote.executionIri !== 'string'
      || (remote.executionUal !== undefined && typeof remote.executionUal !== 'string')
    ) throw new SemanticProgramError('REMOTE_INVOCATION_RESPONSE_INVALID', 'Remote Execution receipt is invalid', 502);
    return {
      kind: 'remote-execute',
      executionIri: remote.executionIri,
      ...(remote.executionUal ? { executionUal: remote.executionUal } : {}),
    };
  };

  const receipt = await runtime.host.startPlan(
    resolved.plan.canonicalPlan,
    0n,
    capability,
    toolDispatcher,
  );
  if (!bytesEqual(receipt.canonicalHash, resolved.plan.canonicalHash)) {
    throw new Error('materialized strategy hash differs from admitted strategy hash');
  }

  let execution;
  let inspection;
  try {
    execution = await runtime.host.applyPlan(receipt.handle);
    inspection = await runtime.host.inspectPlan(receipt.handle);
  } catch (error) {
    // The component preserves the host error code, but not its HTTP error class.
    if (error instanceof Error && 'code' in error && error.code === 'INVOCATION_REQUIRES_RECONCILIATION') {
      throw new SemanticProgramError('INVOCATION_REQUIRES_RECONCILIATION',
        'The effect is unresolved; retry the same invocation ID after checking lifecycle progress', 409);
    }
    throw error;
  } finally {
    await runtime.host.dropPlan(receipt.handle).catch(() => undefined);
  }
  await assertAuthorized();
  const finishedAt = new Date();
  const quads = buildExecutionQuads({
    bound,
    executionIri,
    invocationId,
    programIri,
    operatorIri: resolved.public.executingNode,
    callerIri: callerAgentAddress
      ? `did:dkg:agent:${checksumAgentAddress(callerAgentAddress, 'INVALID_CALLER_WALLET')}`
      : resolved.public.executingNode,
    policy: resolved.public.selectedPolicy,
    programHash: artifactHash,
    tools: resolved.public.requiredTools,
    events: execution.events,
    outputs: execution.outputs,
    agents: inspection.agents,
    childExecutions,
    startedAt,
    finishedAt,
  });
  journal.prepare({ contextGraphId, name: assertionName, agentAddress: resolved.operatorAddress,
    layer: executionLayer, requestIdentity: executionGraphRevision, quads,
    outputs: execution.outputs.map(output => output.value) });
  let persistence: PersistenceEvidence;
  try {
    persistence = await persistExecutionKnowledgeAsset(
      agent,
      contextGraphId,
      assertionName,
      resolved.operatorAddress,
      quads,
      priorHistory,
      executionLayer,
      assertAuthorized,
      journal,
    );
  } catch (error) {
    if (error instanceof SemanticProgramError) throw error;
    throw new SemanticProgramError(
      'EXECUTION_PERSIST_FAILED',
      `Execution completed but its Knowledge Asset was not persisted: ${safeMessage(error)}`,
      502,
    );
  }
  await assertAuthorized();
  runtime.store.setExecutionStatus(executionIri, 'completed');
  return {
    invocationId,
    executionIri,
    executionLayer,
    ...(persistence.ual ? { executionUal: persistence.ual } : {}),
    outputs: execution.outputs.map((output) => output.value),
    persisted: true,
  };
}
