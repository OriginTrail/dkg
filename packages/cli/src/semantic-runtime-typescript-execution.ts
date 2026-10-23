import { ExecutionReceiptJournal } from '@origintrail-official/dkg-semantic-runtime';
import { recoverTerminalExecutionReceipt } from './semantic-runtime-terminal-receipt.js';
import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import { ProgramTraceRecorder, readProgramTrace, hashCanonicalPlan, type SemanticRuntimeConfig, type SemanticProgramBinding } from '@origintrail-official/dkg-semantic-runtime';
import { canonicalProgramInputs } from './semantic-runtime-bound-invocation.js';
import { programBindingDigest } from './semantic-runtime-program-bindings.js';
import { ConfiguredSemanticRuntimeService, SemanticInvocationResult, SemanticProgramError, StoredSemanticProgram, TypeScriptComposition } from './semantic-runtime-types.js';
import { SR, hashParts, historyIsAtLayer, literalQuad, safeMessage, sameSet, sourceHashOf } from './semantic-runtime-values.js';
import { assertBoundQueryDefinition, resolveProgramTools } from './semantic-runtime-resolution.js';
import { loadStoredSemanticProgram } from './semantic-runtime-program-source.js';
import { buildExecutionQuads, loadExecutionOutputs, persistExecutionKnowledgeAsset } from './semantic-runtime-execution-persistence.js';
import { createProgramToolDispatcher, invokeBoundSemanticProgram } from './semantic-runtime-invocation.js';

export function parseRequestedPermissions(json: string): Record<string, unknown> {
  try {
    if (Buffer.byteLength(json) > 65536) throw new Error();
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    canonicalizeJson(value, { maxBytes: 65536, maxDepth: 20 });
    return value;
  } catch { throw new SemanticProgramError('INVALID_PROGRAM_PERMISSIONS', 'Requested tool permissions must be a JSON object of at most 64 KiB', 422); }
}

/** Compare the stored request to owner-approved scope, excluding server-computed pins. */
export function assertRequestedToolPermissions(program: StoredSemanticProgram, binding: SemanticProgramBinding): void {
  const requested = program.requestedPermissions;
  const scope = {
    graphId: binding.contextGraphId, executionLayer: binding.executionLayer ?? 'wm',
    ...(binding.query ? { query: { selector: binding.query.selector, outputSchema: binding.query.outputSchema } } : {}),
    ...(binding.sparqlRead ? { sparqlRead: (({ outputSchemaSha256: _outputSchemaSha256, ...grant }) => grant)(binding.sparqlRead) } : {}),
    ...(binding.assetCreation ? { assetCreation: binding.assetCreation } : {}),
    ...(binding.localLlm ? { localLlm: { toolIri: binding.localLlm.toolIri } } : {}),
  };
  const tools = new Set(program.requiredTools);
  const expectedCount = Number(!!binding.query) + Number(!!binding.sparqlRead) + Number(!!binding.assetCreation) + Number(!!binding.localLlm);
  if (!sameSet(tools, new Set(binding.typescript?.requiredTools ?? []))
    || tools.size !== expectedCount
    || binding.sparqlRead && !tools.has(binding.sparqlRead.toolIri)
    || binding.assetCreation && !tools.has(binding.assetCreation.toolIri)
    || binding.localLlm && !tools.has(binding.localLlm.toolIri)
    || (expectedCount > 0 && !requested)) {
    throw new SemanticProgramError('PROGRAM_BINDING_TOOL_FORBIDDEN', 'Declared tools must match the approved tool grants', 403);
  }
  if (requested) {
    const normalized = { executionLayer: 'wm', ...requested,
      graphId: typeof requested.graphId === 'string' ? requested.graphId.replace(/^did:dkg:context-graph:/, '') : null };
    if (canonicalizeJson(normalized as CanonicalJsonValue) !== canonicalizeJson(scope as CanonicalJsonValue)) {
      throw new SemanticProgramError('PROGRAM_PERMISSION_MISMATCH', 'Approval differs from the Program requested tool scope', 403);
    }
  }
}

export async function resolveTypeScriptTools(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
  binding: SemanticProgramBinding, program: StoredSemanticProgram, config: SemanticRuntimeConfig, check: () => Promise<void>) {
  const digest = programBindingDigest(binding);
  const resolved = await resolveProgramTools({ agent, contextGraphId: binding.contextGraphId, program, config,
    callerAgentAddress: binding.executorAgentAddress, executingAgentAddress: binding.executorAgentAddress,
    executionLayer: binding.executionLayer ?? 'wm', assertAuthorized: check,
    bound: { binding, digest, assertAuthorized: check }, assetStore: runtime.store, localLlmProvider: runtime.localLlmProvider });
  if (resolved.tools.some(tool => !tool.effective)) throw new SemanticProgramError('REQUIRED_TOOL_UNAVAILABLE', 'A requested adapter is unavailable', 409);
  return { registry: resolved.registry, policyHashHex: resolved.policyHashHex,
    public: { contextGraphId: binding.contextGraphId, programIri: program.programIri, programLayer: program.layer,
      executingNode: resolved.operatorIri,
      selectedPolicy: { iri: resolved.policyIri, version: resolved.policyVersion, hash: `sha256:${resolved.policyHashHex}` },
      requiredTools: resolved.tools, previousExecutions: [], executable: true } };
}

export async function validateTypeScriptProgram(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
  binding: SemanticProgramBinding, check: () => Promise<void>): Promise<StoredSemanticProgram> {
  await check();
  const program = await loadStoredSemanticProgram(agent, binding.program.contextGraphId, binding.program.programIri,
    binding.program.programLayer, binding.executorAgentAddress);
  if (program.language !== 'typescript-v1' || sourceHashOf(program) !== binding.program.sourceHash
    || program.authorAgentAddress.toLowerCase() !== binding.program.authorAgentAddress.toLowerCase()
    || !sameSet(new Set(program.permittedPrograms), new Set(binding.typescript!.children.map(child => child.programIri)))) {
    throw new SemanticProgramError('PROGRAM_BINDING_MISMATCH', 'TypeScript source, author or declared child Programs differ from approval', 403);
  }
  assertRequestedToolPermissions(program, binding);
  if (!runtime.typescript) throw new SemanticProgramError('TYPESCRIPT_RUNTIME_UNAVAILABLE', 'TypeScript execution is unavailable', 409);
  try { await runtime.typescript.compile(program.source); }
  catch (error) { throw new SemanticProgramError('PROGRAM_COMPILATION_FAILED', safeMessage(error), 422); }
  await check();
  return program;
}

export async function invokeTypeScriptProgram(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
  binding: SemanticProgramBinding, digest: string, invocationId: string, config: SemanticRuntimeConfig,
  caller: string, inputs: unknown[], authorized: () => Promise<void>, parent?: TypeScriptComposition): Promise<SemanticInvocationResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId))
    throw new SemanticProgramError('INVALID_INVOCATION_ID', 'invocationId must be a UUID', 400);
  invocationId = invocationId.toLowerCase();
  const grant = binding.typescript!, graph = binding.contextGraphId;
  // An invocation grant may expose only an aggregate. It must not reveal private intermediate rows.
  const mayReadTrace = caller.toLowerCase() === binding.executorAgentAddress.toLowerCase();
  const operationKey = `${graph}\0${binding.operationIri}`;
  if (parent && (parent.ancestors.length >= 8 || parent.ancestors.includes(operationKey)))
    throw new SemanticProgramError('PROGRAM_COMPOSITION_LIMIT', 'Program composition is cyclic or exceeds eight levels', 403);
  let inputJson: string;
  try { inputJson = canonicalProgramInputs(inputs); }
  catch { throw new SemanticProgramError('INVALID_PROGRAM_INPUTS', 'inputs must be a JSON array of at most 64 KiB and depth 20', 400); }
  const budget: TypeScriptComposition['budget'] = parent?.budget ?? { calls: 0, maximum: grant.maxCalls, deadline: Date.now() + grant.timeoutMs, cancelled: false };
  const check = async () => {
    if (budget.uncertainEffect) throw budget.uncertainEffect;
    if (budget.cancelled || Date.now() > budget.deadline) throw new SemanticProgramError('PROGRAM_EXECUTION_CANCELLED', 'Execution is cancelled or expired', 409);
    await authorized();
    await assertBoundQueryDefinition(agent, binding);
    const visited = new Set<string>();
    const checkChildren = (selected: SemanticProgramBinding, ancestors: string[]) => {
      for (const pin of selected.typescript?.children ?? []) {
        const key = `${pin.contextGraphId}\0${pin.operationIri}`;
        if (ancestors.includes(key) || ancestors.length >= 8) throw new SemanticProgramError('PROGRAM_COMPOSITION_LIMIT', 'Program grants are cyclic or too deep', 403);
        const child = config.programBindings?.find(item => item.contextGraphId === pin.contextGraphId && item.operationIri === pin.operationIri);
        if (!child?.enabled || programBindingDigest(child) !== pin.bindingDigest
          || !child.allowedCallerAgentAddresses.some(address => address.toLowerCase() === caller.toLowerCase()))
          throw new SemanticProgramError('PROGRAM_CHILD_FORBIDDEN', 'A child grant changed or does not authorize the original caller', 403);
        if (!visited.has(key)) { visited.add(key); checkChildren(child, [...ancestors, key]); }
      }
    };
    checkChildren(binding, [operationKey]);
  };
  const identity = hashParts(['typescript-v1', digest, caller.toLowerCase(), inputJson, ...(parent?.ancestors ?? [])]);
  const key = `${graph}\0${invocationId}`;
  const existing = runtime.inFlight.get(key);
  if (existing) {
    if (existing.requestIdentity !== identity) throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'Invocation already has different inputs or authority', 409);
    await check();
    return existing.promise;
  }
  const work = async (): Promise<SemanticInvocationResult> => {
    await check();
    const program = await validateTypeScriptProgram(agent, runtime, binding, check);
    const executor = agent.listLocalAgents().find(item => item.agentAddress.toLowerCase() === binding.executorAgentAddress.toLowerCase());
    if (!executor || !agent.getCustodialAgentPrivateKey(executor.agentAddress)) throw new SemanticProgramError('TARGET_EXECUTOR_NOT_LOCAL', 'Executor is unavailable', 409);
    const executionIri = `urn:sr:execution:${invocationId}`, name = `semantic-execution-${invocationId}`;
    const layer = binding.executionLayer ?? 'wm';
    const previous = runtime.store.execution(executionIri);
    const history = await agent.assertion.history(graph, name, { agentAddress: executor.agentAddress });
    const journal = new ExecutionReceiptJournal(runtime.store, executionIri);
    if (previous && journal.terminal && ['active', 'completed'].includes(previous.status)) {
      const result = await recoverTerminalExecutionReceipt(agent, runtime.store, journal, {
        contextGraphId: graph, name, agentAddress: executor.agentAddress, layer, requestIdentity: identity,
      }, invocationId, check);
      return { ...result, ...(mayReadTrace ? { trace: readProgramTrace(runtime.store, executionIri) } : {}) };
    }
    if (previous) {
      if (previous.graphRevision !== identity) throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'Invocation already has different inputs or authority', 409);
      if (previous.status !== 'completed') {
        // JavaScript continuations are not durable. Never replay partially run
        // workflows and accidentally repeat an external effect after a crash.
        if (previous.status === 'active') runtime.store.setExecutionStatus(executionIri, 'failed');
        throw new SemanticProgramError('INVOCATION_NOT_RETRYABLE', 'Interrupted TypeScript execution has no terminal receipt; reconcile its effects before starting new work', 409,
          mayReadTrace ? readProgramTrace(runtime.store, executionIri) : undefined);
      }
      if (!history || !historyIsAtLayer(history, layer)) throw new SemanticProgramError('EXECUTION_PERSISTENCE_INCONSISTENT', 'Completed receipt is missing', 500);
      const outputs = await loadExecutionOutputs(agent, graph, executionIri, layer, executor.agentAddress);
      await check();
      return { invocationId, executionIri, executionLayer: layer, ...(layer === 'vm' ? { executionUal: history.publishedUal } : {}), outputs, persisted: true,
        ...(mayReadTrace ? { trace: readProgramTrace(runtime.store, executionIri) } : {}) };
    }
    const resolved = await resolveTypeScriptTools(agent, runtime, binding, program, config, check);
    const artifact = await runtime.typescript!.compile(program.source);
    const manifest = new TextEncoder().encode(artifact.manifest), planId = hashCanonicalPlan(manifest);
    runtime.store.registerStrategyArtifact({ artifactHash: planId, strategyId: program.programIri, version: program.version,
      canonicalPlan: manifest, sourceRef: program.programIri, reviewState: 'approved', createdAt: Date.now() });
    runtime.store.createExecution({ executionId: executionIri, planId, partitionId: hashParts([graph]),
      status: 'active', graphRevision: identity, policyEpoch: 1n, rootProcessId: executionIri, leaseEpoch: 0n });
    const authority = {
      adapterVersions: new Map(resolved.public.requiredTools.map(tool => [tool.operation!, tool.semanticVersion!])),
      allowedEffectClasses: new Set(resolved.public.requiredTools.map(tool => resolved.registry.describe(tool.operation!, tool.semanticVersion!)!.effectClass)),
    };
    const dispatchTool = createProgramToolDispatcher(runtime, resolved, authority, executionIri, invocationId, check,
      { binding, digest, assertAuthorized: check });
    const childExecutions: string[] = [], startedAt = new Date();
    const trace = new ProgramTraceRecorder(runtime.store, executionIri);
    try {
      const output = await runtime.typescript!.execute(artifact, inputJson,
        { ...grant, timeoutMs: Math.max(1, Math.min(grant.timeoutMs, budget.deadline - Date.now())) }, async effect => trace.call(String(effect.id), effect.kind, effect.kind === 'tool' ? effect.tool : effect.program, async call => {
          await check();
          if (++budget.calls > budget.maximum) throw new SemanticProgramError('PROGRAM_CALL_BUDGET_EXCEEDED', 'Program tree exceeds its call budget', 403);
          if (effect.kind === 'tool') {
            let output: string;
            try { output = await dispatchTool(effect.tool, effect.input, String(effect.id)); }
            catch (error) {
              if (error instanceof SemanticProgramError && error.code === 'INVOCATION_REQUIRES_RECONCILIATION') budget.uncertainEffect = error;
              throw error;
            }
            // Adapter output envelopes are preserved, with JSON decoded for TypeScript.
            try { return JSON.parse(output); } catch { return output; }
          }
          const pin = grant.children.find(child => child.programIri === effect.program);
          if (!pin) throw new SemanticProgramError('PROGRAM_CHILD_FORBIDDEN', 'Child Program is not approved', 403);
          // Deterministic effect-specific IDs link persisted child executions to
          // this parent. Only the host chooses them and the original caller.
          const hex = hashParts([invocationId, String(effect.id)]);
          const childId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
          const result = await invokeBoundSemanticProgram(agent, runtime, pin.contextGraphId, pin.operationIri, childId,
            config, caller, effect.args, { ancestors: [...(parent?.ancestors ?? []), operationKey], budget, assertParent: check });
          await check();
          call.executionIri = result.executionIri;
          childExecutions.push(result.executionIri);
          const values = (result.outputs ?? []).map(value => { try { return JSON.parse(value); } catch { return value; } });
          return values.length === 1 ? values[0] : values;
        }));
      await check();
      const quads = buildExecutionQuads({ bound: { binding, digest, assertAuthorized: check }, executionIri, invocationId,
        programIri: program.programIri, operatorIri: `did:dkg:agent:${executor.agentAddress}`, callerIri: `did:dkg:agent:${caller}`,
        policy: { iri: `urn:dkg:program-binding:${digest}`, version: '1', hash: digest }, programHash: artifact.hash,
        tools: resolved.public.requiredTools, events: [], agents: [], outputs: [{ role: 'result', processId: new Uint8Array(), value: output }],
        childExecutions, startedAt, finishedAt: new Date() });
      quads.push(literalQuad(executionIri, `${SR}inputHash`, createHash('sha256').update(inputJson).digest('hex')));
      journal.prepare({ contextGraphId: graph, name, agentAddress: executor.agentAddress, layer,
        requestIdentity: identity, quads, outputs: [output] });
      trace.finish();
      const persistence = await persistExecutionKnowledgeAsset(agent, graph, name, executor.agentAddress, quads, history, layer, check, journal);
      await check();
      runtime.store.setExecutionStatus(executionIri, 'completed');
      return { ...(mayReadTrace ? { trace: trace.trace } : {}), invocationId, executionIri, executionLayer: layer, ...(persistence.ual ? { executionUal: persistence.ual } : {}), outputs: [output], persisted: true };
    } catch (error) {
      trace.finish(error);
      if (!journal.terminal) runtime.store.setExecutionStatus(executionIri, 'failed');
      const failure = error instanceof SemanticProgramError ? error : budget.uncertainEffect
        ?? new SemanticProgramError('TYPESCRIPT_EXECUTION_FAILED', safeMessage(error), 422);
      // A revoked grant must not leak earlier successful reads through diagnostics.
      failure.trace = undefined;
      try { await authorized(); if (mayReadTrace) failure.trace = trace.trace; }
      catch { failure.trace = undefined; }
      throw failure;
    }
  };
  const promise = work();
  runtime.inFlight.set(key, { requestIdentity: identity, promise });
  try { return await promise; }
  finally { runtime.inFlight.delete(key); if (!parent) budget.cancelled = true; }
}
