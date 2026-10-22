import { programToolDefinition } from './semantic-runtime-tool-catalog.js';
import { createLocalLlmProgramAdapter, type LocalLlmProgramProvider } from './semantic-runtime-local-llm-adapter.js';
import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import { ComponentWorkerClient, defaultExecutionCapability, RuntimeAdapterRegistry, SemanticRuntimeStore, WasmStrategyAdmissionClient, type SemanticRuntimeConfig, type SemanticProgramBinding } from '@origintrail-official/dkg-semantic-runtime';
import { createAssetCreationAdapter } from './semantic-runtime-asset-adapter.js';
import { createInvestigatorAdapter } from './semantic-runtime-investigator-adapter.js';
import { createSparqlReadAdapter } from './semantic-runtime-sparql-adapter.js';
import { createDkgQueryAdapter, findSavedQuery } from './semantic-runtime-query-adapter.js';
import { readContextGraphQueryCatalogBindings } from './daemon/query-catalog-service.js';
import { programBindingDigest, validateProgramBindings } from './semantic-runtime-program-bindings.js';
import { assertSemanticQueryDefinition } from './semantic-runtime-query-pins.js';
import { createRemoteExecuteAdapter } from './semantic-runtime-remote-execute-adapter.js';
import { createSafeLlmAdapter, type SafeLlmProgram } from './semantic-runtime-safe-llm-adapter.js';
import { BoundProgramInvocation, ConfiguredSemanticRuntimeService, InternalResolution, SemanticMemoryLayer, SemanticProgramChildInvoker, SemanticProgramError, SemanticProgramResolution, SemanticToolResolution, StoredSemanticProgram } from './semantic-runtime-types.js';
import { resolveTypeScriptTools, validateTypeScriptProgram } from './semantic-runtime-typescript-execution.js';
import { RDF_TYPE, SR, checksumAgentAddress, hashParts, iriValue, isOperatorVmGraph, literalValue, queryOptions, resultRows, sameSet, sourceHashOf } from './semantic-runtime-values.js';
import { loadStoredSemanticProgram } from './semantic-runtime-program-source.js';
import { validateProgramPin } from './semantic-runtime-invocation-policy.js';

export async function resolveStoredSemanticProgram(
  agent: DKGAgent,
  contextGraphId: string,
  programIri: string,
  programLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<SemanticProgramResolution> {
  return (await resolveInternal(
    agent,
    contextGraphId,
    programIri,
    programLayer,
    config,
    llmConfig,
    callerAgentAddress,
  )).public;
}

export async function assertBoundQueryDefinition(agent: DKGAgent, binding: SemanticProgramBinding): Promise<void> {
  if (binding.query) {
    const rows = await readContextGraphQueryCatalogBindings(agent, binding.contextGraphId, {
      callerAgentAddress: binding.executorAgentAddress, source: 'semantic-runtime-query-catalog',
    });
    const item = findSavedQuery(decodeQueryCatalogBindings(rows, { contextGraphId: binding.contextGraphId }), binding.query.selector);
    if (!item) throw new SemanticProgramError('PROGRAM_QUERY_UNAVAILABLE', 'The approved query is unavailable', 409);
    try { assertSemanticQueryDefinition([binding.query], binding.query.selector, item); }
    catch { throw new SemanticProgramError('PROGRAM_QUERY_CHANGED', 'The query differs from the tenant approval', 409); }
  }
}

/** Resolve an approval candidate without invoking it or granting runtime authority. */
export async function validateBoundSemanticProgram(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  config: SemanticRuntimeConfig,
  binding: SemanticProgramBinding,
  assertManagerAuthorized: () => Promise<void>,
): Promise<SemanticProgramResolution> {
  validateProgramBindings([binding]);
  const executor = agent.listLocalAgents().find((entry) => entry.agentAddress.toLowerCase() === binding.executorAgentAddress.toLowerCase());
  if (!executor || !agent.getCustodialAgentPrivateKey(executor.agentAddress)) {
    throw new SemanticProgramError('TARGET_EXECUTOR_NOT_LOCAL', 'The executor must be a local custodial agent', 409);
  }
  const check = async () => {
    await assertManagerAuthorized();
    for (const graph of new Set([binding.contextGraphId, binding.program.contextGraphId])) {
      if (!await agent.canReadContextGraph(graph, { callerAgentAddress: executor.agentAddress, allowSubscriptionFallback: false })) {
        throw new SemanticProgramError('PROGRAM_EXECUTOR_ACCESS_DENIED', 'Executor cannot read the approved graph', 403);
      }
    }
  };
  await check();
  if (binding.sparqlRead?.layer === 'swm' && !await agent.canUseSharedMemoryForContextGraph(binding.contextGraphId, { callerAgentAddress: executor.agentAddress })) {
    throw new SemanticProgramError('PROGRAM_GRAPH_AUTHORITY_UNAVAILABLE', 'The data graph is unavailable for shared-memory reads', 503);
  }
  if (binding.assetCreation) {
    const access = await agent.probeContextGraphWritePreflight(binding.contextGraphId, { callerAgentAddress: executor.agentAddress });
    if (!access.storeAvailable || !access.exists || !access.callerAuthorized) {
      throw new SemanticProgramError('PROGRAM_EXECUTOR_WRITE_DENIED', 'Executor cannot create assets in the data graph', 403);
    }
  }
  if (binding.typescript) {
    const program = await validateTypeScriptProgram(agent, runtime, binding, check);
    return (await resolveTypeScriptTools(agent, runtime, binding, program, config, check)).public;
  }
  const resolved = await resolveInternal(agent, binding.contextGraphId, binding.program.programIri, binding.program.programLayer,
    config, undefined, executor.agentAddress, executor.agentAddress, binding.executionLayer ?? 'wm', undefined, check,
    { binding, digest: programBindingDigest(binding), assertAuthorized: check }, runtime.store);
  if (!resolved.public.executable) throw new SemanticProgramError('REQUIRED_TOOL_UNAVAILABLE', 'The declared tools do not match the approved installed adapters', 409);
  // Exercise the actual typed component boundary with validation-only stubs.
  // No adapter dispatch, data query, asset creation or execution journal write
  // occurs here. This also rejects unsupported topology and malformed literals.
  const worker = new ComponentWorkerClient({ startupTimeoutMs: config.startupTimeoutMs, requestTimeoutMs: 5000 }, async (call) => {
    await check();
    if (call.kind === 'query-catalog' && binding.query && call.queryId === binding.query.selector && call.parameters.length === 0) {
      createDkgQueryAdapter(agent, binding.contextGraphId, executor.agentAddress, [binding.query], check).validateInput({ selector: call.queryId });
    } else if (call.kind === 'sparql-read' && binding.sparqlRead) {
      createSparqlReadAdapter(agent, binding.contextGraphId, executor.agentAddress, binding.sparqlRead, check).validateInput({ sparql: call.sparql });
    } else if (call.kind === 'asset-create' && binding.assetCreation) {
      createAssetCreationAdapter(agent, binding.contextGraphId, binding.executionLayer ?? 'wm', executor.agentAddress, runtime.store, check)
        .validateInput(JSON.parse(call.contentJson));
    } else throw new Error('PROGRAM_BINDING_TOOL_ARGUMENT_FORBIDDEN');
    return { kind: call.kind, json: 'null' };
  });
  try {
    await worker.start();
    const capability = defaultExecutionCapability(Buffer.from(resolved.plan.canonicalHash).toString('hex'));
    capability.contextGraphId = binding.contextGraphId;
    capability.programIri = binding.program.programIri;
    capability.sourceHash = binding.program.sourceHash;
    capability.tools = resolved.public.requiredTools.map((tool) => ({ operation: tool.operation!, version: tool.semanticVersion!, witInterface: tool.witInterface! }));
    capability.budgets.maxDkgQueries = resolved.plan.resourceBounds.hostCommands;
    capability.budgets.maxToolCalls = resolved.plan.resourceBounds.hostCommands;
    await worker.call('start', { plan: resolved.plan.canonicalPlan, capability, logicalTime: 0n });
    await worker.call('advance');
  } catch (error) {
    throw new SemanticProgramError('PROGRAM_ACTIVATION_REJECTED', error instanceof Error ? error.message : 'Program preflight failed', 422);
  } finally { await worker.stop(); }
  await check();
  return resolved.public;
}

export async function resolveProgramTools(
  agent: DKGAgent, contextGraphId: string, program: StoredSemanticProgram,
  config: SemanticRuntimeConfig | undefined, llmConfig: LlmConfig | undefined,
  callerAgentAddress: string | undefined, executingAgentAddress: string | undefined,
  executionLayer: SemanticMemoryLayer, childInvoker: SemanticProgramChildInvoker | undefined,
  assertAuthorized: (() => Promise<void>) | undefined, bound: BoundProgramInvocation | undefined,
  assetStore: SemanticRuntimeStore | undefined,
  localLlmProvider?: LocalLlmProgramProvider,
) {
  const programIri = program.programIri, programLayer = program.layer;
  const readPrincipal = bound?.binding.executorAgentAddress ?? callerAgentAddress;
  const originalCaller = callerAgentAddress ?? program.authorAgentAddress;
  const operatorAddress = executingAgentAddress
    ? checksumAgentAddress(executingAgentAddress, 'INVALID_EXECUTING_WALLET')
    : program.authorAgentAddress;
  const operatorIri = `did:dkg:agent:${operatorAddress}`;
  type ToolDefinition = { operation: string; version: string; wit: string };
  const toolDefinitions = new Map<string, Map<string, ToolDefinition>>();
  let policyIri: string;
  let policyVersion: string;
  let policyHashHex: string;
  let allowedTools: Set<string>;
  if (bound) {
    policyIri = `urn:dkg:program-binding:${bound.digest}`;
    policyVersion = '1';
    allowedTools = new Set(program.requiredTools);
    const descriptors: string[] = [];
    for (const toolIri of program.requiredTools) {
      const definition = programToolDefinition(toolIri === bound.binding.assetCreation?.toolIri
        ? 'assetCreation' : toolIri === bound.binding.sparqlRead?.toolIri ? 'sparqlRead'
          : toolIri === bound.binding.localLlm?.toolIri ? 'localLlm' : 'query');
      toolDefinitions.set(toolIri, new Map([[JSON.stringify(definition), definition]]));
      descriptors.push(toolIri, definition.operation, definition.version, definition.wit);
    }
    policyHashHex = hashParts([policyIri, operatorIri, policyVersion, ...descriptors]);
  } else {
    policyIri = config?.operatorPolicyIri ?? '';
    if (!policyIri) {
      throw new SemanticProgramError('OPERATOR_POLICY_NOT_CONFIGURED', 'No operator execution policy is configured', 409);
    }
    let safePolicyIri: string;
    let safeOperatorIri: string;
    try {
      safePolicyIri = sparqlIri(policyIri);
      safeOperatorIri = sparqlIri(operatorIri);
    } catch {
      throw new SemanticProgramError('INVALID_OPERATOR_POLICY', 'Configured operator policy IRI is invalid', 409);
    }

    const policyResult = await agent.query(`
      SELECT DISTINCT ?g ?policyVersion ?tool WHERE {
        GRAPH ?g {
          ${safeOperatorIri} <${SR}usesExecutionPolicy> ${safePolicyIri} .
          ${safePolicyIri} <${RDF_TYPE}> <${SR}ExecutionPolicy> ;
            <${SR}version> ?policyVersion ;
            <${SR}allowsTool> ?tool .
        }
      }
    `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-policy-load', readPrincipal));
    const policyRows = resultRows(policyResult).filter((row) =>
      isOperatorVmGraph(row.g, contextGraphId, operatorAddress));
    const policyGraphs = new Set(policyRows.map((row) => iriValue(row.g)));
    const policyVersions = new Set(policyRows.map((row) => literalValue(row.policyVersion)));
    if (policyRows.length === 0 || policyGraphs.size !== 1 || policyVersions.size !== 1) {
      throw new SemanticProgramError(
        'OPERATOR_POLICY_UNTRUSTED',
        'Operator policy is missing, ambiguous, or not authored by this node operator',
        409,
      );
    }
    [policyVersion] = policyVersions;
    allowedTools = new Set(policyRows.map((row) => iriValue(row.tool)));
    policyHashHex = hashParts([
      policyIri,
      operatorIri,
      policyVersion,
      ...[...allowedTools].sort(),
    ]);

    const offerResult = await agent.query(`
      SELECT DISTINCT ?g ?tool ?operation ?toolVersion ?witInterface WHERE {
        GRAPH ?g {
          ${safeOperatorIri} <${SR}offersTool> ?tool .
          ?tool <${RDF_TYPE}> <${SR}Tool> ;
            <${SR}operation> ?operation ;
            <${SR}version> ?toolVersion ;
            <${SR}witInterface> ?witInterface .
        }
      }
    `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-tool-offers', readPrincipal));
    const offerRows = resultRows(offerResult).filter((row) =>
      isOperatorVmGraph(row.g, contextGraphId, operatorAddress));

    for (const row of offerRows) {
      const toolIri = iriValue(row.tool);
      const definitions = toolDefinitions.get(toolIri) ?? new Map<string, ToolDefinition>();
      const definition = {
        operation: literalValue(row.operation),
        version: literalValue(row.toolVersion),
        wit: literalValue(row.witInterface),
      };
      definitions.set(JSON.stringify(definition), definition);
      toolDefinitions.set(toolIri, definitions);
    }
  }

  const childPrograms = await Promise.all((bound ? [] : program.permittedPrograms).map(async (childIri) => {
    if (childIri === programIri) {
      throw new SemanticProgramError('PROGRAM_SELF_PERMISSION', 'A Program cannot permit itself', 409);
    }
    return loadStoredSemanticProgram(
      agent,
      contextGraphId,
      childIri,
      programLayer,
      callerAgentAddress,
    );
  }));
  if (!bound && config?.programPolicy) {
    for (const child of childPrograms) {
      validateProgramPin(config, child);
      if (!agent.listLocalAgents().some(({ agentAddress }) => agentAddress.toLowerCase() === child.authorAgentAddress.toLowerCase())
        || !agent.getCustodialAgentPrivateKey(child.authorAgentAddress)) {
        throw new SemanticProgramError('PROGRAM_CHILD_NOT_LOCAL', 'Pinned child Programs must execute on this node', 403);
      }
    }
  }
  const safePrograms = childPrograms.map((child): SafeLlmProgram => {
    const sourceHash = createHash('sha256').update(child.source, 'utf8').digest('hex');
    const capabilityId = hashParts([programIri, child.programIri, sourceHash]);
    return {
      capabilityId,
      programIri: child.programIri,
      sourceHash,
      name: `program_${capabilityId.slice(0, 16)}`,
      description: ([child.label, child.description].filter(Boolean).join(': ')
        || 'Execute the permitted DKG Program and return its persisted output.').slice(0, 512),
    };
  });
  const registry = new RuntimeAdapterRegistry();
  if (!bound && !config?.programPolicy) {
    registry.register(createInvestigatorAdapter(llmConfig));
    registry.register(createRemoteExecuteAdapter(agent, contextGraphId, operatorAddress, programLayer, executionLayer));
  }
  const programPin = config?.programPolicy?.programs.find((pin) => pin.programIri === programIri);
  registry.register(createDkgQueryAdapter(agent, contextGraphId, bound ? readPrincipal : config?.programPolicy ? originalCaller : callerAgentAddress,
    bound ? bound.binding.query ? [bound.binding.query] : [] : config?.programPolicy ? programPin?.queries ?? [] : undefined, bound?.assertAuthorized));
  if (bound?.binding.sparqlRead) {
    registry.register(createSparqlReadAdapter(agent, contextGraphId, operatorAddress, bound.binding.sparqlRead, bound.assertAuthorized));
  }
  if (bound?.binding.assetCreation) {
    registry.register(createAssetCreationAdapter(agent, contextGraphId, executionLayer, operatorAddress, assetStore, bound.assertAuthorized));
  }
  if (bound?.binding.localLlm) {
    registry.register(createLocalLlmProgramAdapter(contextGraphId, operatorAddress,
      bound.binding.localLlm, bound.assertAuthorized, localLlmProvider));
  }
  if (!bound && (!config?.programPolicy || config.programPolicy.disclosure)) {
    registry.register(createSafeLlmAdapter(
      llmConfig,
      safePrograms,
      childInvoker ? (childProgramIri, invocationId) => childInvoker({
        contextGraphId, programIri: childProgramIri, invocationId, programLayer, executionLayer,
        callerAgentAddress: config?.programPolicy ? originalCaller : operatorAddress,
      }) : undefined,
      config?.programPolicy?.disclosure ? {
        policy: config.programPolicy.disclosure,
        assertAuthorized: assertAuthorized ?? (async () => { throw new Error('PROGRAM_INVOCATION_REQUIRED'); }),
      } : undefined,
    ));
  }
  const tools = program.requiredTools.map((toolIri): SemanticToolResolution => {
    const definitions = toolDefinitions.get(toolIri) ?? new Map<string, ToolDefinition>();
    const definition = definitions.size === 1 ? [...definitions.values()][0] : null;
    const adapter = definition ? registry.describe(definition.operation, definition.version) : null;
    const offered = definitions.size > 0;
    const policyAllowed = allowedTools.has(toolIri);
    const locallyInstalled = adapter !== null && adapter.witInterface === definition?.wit;
    const locallyEnabled = locallyInstalled && adapter.enabled;
    let unavailableReason: string | null = null;
    if (!offered) unavailableReason = 'NOT_OFFERED_BY_OPERATOR';
    else if (definitions.size !== 1) unavailableReason = 'TOOL_DESCRIPTOR_AMBIGUOUS';
    else if (!policyAllowed) unavailableReason = 'DENIED_BY_OPERATOR_POLICY';
    else if (!locallyInstalled) unavailableReason = 'ADAPTER_NOT_INSTALLED';
    else if (!locallyEnabled) unavailableReason = 'ADAPTER_DISABLED';
    return {
      toolIri,
      operation: definition?.operation ?? null,
      semanticVersion: definition?.version ?? null,
      witInterface: definition?.wit ?? null,
      requested: true,
      offered,
      policyAllowed,
      locallyInstalled,
      locallyEnabled,
      adapterVersion: adapter?.implementationVersion ?? null,
      adapterHash: adapter?.implementationHash ? `sha256:${adapter.implementationHash}` : null,
      effective: unavailableReason === null,
      unavailableReason,
    };
  });
  return { tools, registry, operatorAddress, operatorIri, policyIri, policyVersion, policyHashHex };
}

export async function resolveInternal(
  agent: DKGAgent,
  contextGraphId: string,
  programIri: string,
  programLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
  executingAgentAddress?: string,
  executionLayer: SemanticMemoryLayer = 'vm',
  childInvoker?: SemanticProgramChildInvoker,
  assertAuthorized?: () => Promise<void>,
  bound?: BoundProgramInvocation,
  assetStore?: SemanticRuntimeStore,
): Promise<InternalResolution> {
  await bound?.assertAuthorized();
  const readPrincipal = bound?.binding.executorAgentAddress ?? callerAgentAddress;
  // Only an already-authorized bound caller gets this readiness diagnostic.
  // Otherwise the query API's empty-on-denial behavior would look like a
  // missing Program. This preflight never substitutes for query-time checks.
  if (bound && programLayer === 'swm'
    && !await agent.canUseSharedMemoryForContextGraph(bound.binding.program.contextGraphId, {
      callerAgentAddress: readPrincipal,
    })) {
    throw new SemanticProgramError(
      'PROGRAM_GRAPH_AUTHORITY_UNAVAILABLE',
      'The approved Program graph is not ready for Shared Working Memory reads by the tenant executor',
      503,
    );
  }
  const program = await loadStoredSemanticProgram(
    agent,
    bound?.binding.program.contextGraphId ?? contextGraphId,
    programIri,
    programLayer,
    readPrincipal,
  );
  if (program.language === 'typescript-v1') {
    throw new SemanticProgramError('PROGRAM_BINDING_REQUIRED', 'TypeScript Programs require a TypeScript operation approval', 403);
  }
  if (bound && (sourceHashOf(program) !== bound.binding.program.sourceHash
    || program.authorAgentAddress.toLowerCase() !== bound.binding.program.authorAgentAddress.toLowerCase()
    || program.permittedPrograms.length !== 0)) {
    throw new SemanticProgramError('PROGRAM_BINDING_MISMATCH', 'Program identity differs from the tenant approval', 403);
  }
  const originalCaller = callerAgentAddress ?? program.authorAgentAddress;
  if (!bound && config?.programPolicy) {
    validateProgramPin(config, program);
    if (!await agent.canReadContextGraph(contextGraphId, { callerAgentAddress: originalCaller })) {
      throw new SemanticProgramError('PROGRAM_CALLER_ACCESS_DENIED', 'Caller cannot read the Context Graph', 403);
    }
  }
  const compilation = await new WasmStrategyAdmissionClient({ startupTimeoutMs: config?.startupTimeoutMs })
    .compileAndAdmit(program.source);
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new SemanticProgramError(
      'PROGRAM_REJECTED',
      diagnostic
        ? `${diagnostic.code} at ${diagnostic.primary.start.line}:${diagnostic.primary.start.column}: ${diagnostic.message}`
        : 'Program admission failed',
      422,
    );
  }
  if (bound && (compilation.plan.adapterVersions.size !== program.requiredTools.length
    || [...compilation.plan.adapterVersions].some(([operation, version]) => version !== 1
      || !(operation === 'dkg/query' && bound.binding.query || operation === 'dkg/asset-create' && bound.binding.assetCreation
        || operation === 'dkg/sparql-read' && bound.binding.sparqlRead))
    || compilation.plan.effectUpperBound.some((effect) => !['read', 'asset-creation'].includes(effect)))) {
    throw new SemanticProgramError('PROGRAM_BINDING_TOOL_FORBIDDEN', 'Program uses tools outside the tenant binding', 403);
  }
  const { tools, registry, operatorAddress, operatorIri, policyIri, policyVersion, policyHashHex } = await resolveProgramTools(
    agent, contextGraphId, program, config, llmConfig, callerAgentAddress, executingAgentAddress,
    executionLayer, childInvoker, assertAuthorized, bound, assetStore);
  const declaredAdapters = new Set(
    tools.flatMap((tool) => tool.operation && tool.semanticVersion
      ? [`${tool.operation}@${tool.semanticVersion}`]
      : []),
  );
  const admittedAdapters = new Set(
    [...compilation.plan.adapterVersions].map(([operation, version]) => `${operation}@${version}`),
  );
  if (!sameSet(declaredAdapters, admittedAdapters)) {
    for (const tool of tools) {
      tool.effective = false;
      tool.unavailableReason = 'PROGRAM_TOOL_DECLARATION_MISMATCH';
    }
  }

  const previousResult = bound ? { bindings: [] } : await agent.query(`
    SELECT DISTINCT ?execution WHERE {
      GRAPH ?g {
        ?execution <${RDF_TYPE}> <${SR}Execution> ;
          <${SR}usedProgram> ${sparqlIri(programIri)} .
      }
    }
  `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-previous-executions', callerAgentAddress));
  const previousExecutions = resultRows(previousResult)
    .map((row) => iriValue(row.execution))
    .sort();
  return {
    public: {
      contextGraphId,
      programIri,
      programLayer,
      executingNode: operatorIri,
      selectedPolicy: {
        iri: policyIri,
        version: policyVersion,
        hash: `sha256:${policyHashHex}`,
      },
      requiredTools: tools,
      previousExecutions,
      executable: tools.every((tool) => tool.effective),
    },
    program,
    plan: compilation.plan,
    registry,
    operatorAddress,
    policyHashHex,
  };
}
