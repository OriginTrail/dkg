import { createHash } from 'node:crypto';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  MemoryLayer,
  parseContextGraphLayerUri,
  sparqlIri,
  validateContextGraphId,
} from '@origintrail-official/dkg-core';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import {
  RuntimeAdapterRegistry,
  RuntimeEffectBroker,
  SemanticRuntimeStore,
  WasmStrategyAdmissionClient,
  admittedPlanAuthority,
  encodeCapabilityMetadata,
  startSemanticRuntimeHost,
  type AdmittedPlanSummary,
  type SemanticRuntimeConfig,
  type SemanticRuntimeHost,
  type SemanticRuntimeHostOptions,
} from '@origintrail-official/dkg-semantic-runtime';

import { createInvestigatorAdapter } from './semantic-runtime-investigator-adapter.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const SR = 'https://origintrail.io/semantic-runtime/v1#';

export interface StoredSemanticProgram {
  contextGraphId: string;
  programIri: string;
  language: string;
  version: string;
  source: string;
  requiredTools: string[];
}

export interface SemanticToolResolution {
  toolIri: string;
  operation: string | null;
  semanticVersion: string | null;
  witInterface: string | null;
  requested: true;
  offered: boolean;
  policyAllowed: boolean;
  locallyInstalled: boolean;
  locallyEnabled: boolean;
  adapterVersion: string | null;
  adapterHash: string | null;
  effective: boolean;
  unavailableReason: string | null;
}

export interface SemanticProgramResolution {
  contextGraphId: string;
  programIri: string;
  executingNode: string;
  selectedPolicy: { iri: string; version: string; hash: string };
  requiredTools: SemanticToolResolution[];
  previousExecutions: string[];
  executable: boolean;
}

export interface SemanticInvocationResult {
  invocationId: string;
  executionIri: string;
  executionUal: string;
  persisted: true;
}

export class SemanticProgramError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface ConfiguredSemanticRuntimeService {
  host: SemanticRuntimeHost;
  store: SemanticRuntimeStore;
  inFlight: Map<string, Promise<SemanticInvocationResult>>;
  stop(): Promise<void>;
}

export interface ConfiguredSemanticRuntimeDeps {
  log: (message: string) => void;
  dataDirectory?: string;
  start?: (options: SemanticRuntimeHostOptions) => Promise<SemanticRuntimeHost>;
  openStore?: () => SemanticRuntimeStore;
}

export async function startConfiguredSemanticRuntime(
  config: SemanticRuntimeConfig | undefined,
  deps: ConfiguredSemanticRuntimeDeps,
): Promise<ConfiguredSemanticRuntimeService | null> {
  if (config?.enabled !== true) return null;
  validateSemanticRuntimeConfig(config);
  const host = await (deps.start ?? startSemanticRuntimeHost)({ config, log: deps.log });
  let store: SemanticRuntimeStore;
  try {
    store = deps.openStore?.()
      ?? (deps.dataDirectory
        ? SemanticRuntimeStore.openInDataDirectory(deps.dataDirectory)
        : new SemanticRuntimeStore(':memory:'));
  } catch (error) {
    await host.stop().catch(() => undefined);
    throw error;
  }
  deps.log(
    `Semantic runtime ready (watchdog=${config.watchdogMs ?? 100}ms, `
      + 'Wasm execution + durable effect journal enabled)',
  );
  return {
    host,
    store,
    inFlight: new Map(),
    async stop() {
      try {
        await host.stop();
      } finally {
        store.close();
      }
    },
  };
}

export async function loadStoredSemanticProgram(
  agent: DKGAgent,
  contextGraphId: string,
  programIri: string,
  callerAgentAddress?: string,
): Promise<StoredSemanticProgram> {
  validateGraphAndProgram(contextGraphId, programIri);
  const safeProgramIri = sparqlIri(programIri);
  const result = await agent.query(`
    SELECT DISTINCT ?language ?version ?source ?tool WHERE {
      GRAPH ?g {
        ${safeProgramIri} <${RDF_TYPE}> <${SR}Program> ;
          <${SR}language> ?language ;
          <${SR}version> ?version ;
          <${SR}source> ?source .
        OPTIONAL { ${safeProgramIri} <${SR}requiresTool> ?tool }
      }
    }
  `, queryOptions(contextGraphId, 'semantic-runtime-program-load', callerAgentAddress));
  const rows = resultRows(result);
  if (rows.length === 0) {
    throw new SemanticProgramError('PROGRAM_NOT_FOUND', 'Program not found in verifiable memory', 404);
  }
  const definitions = new Map<string, { language: string; version: string; source: string }>();
  const requiredTools = new Set<string>();
  for (const row of rows) {
    const definition = {
      language: literalValue(row.language),
      version: literalValue(row.version),
      source: literalValue(row.source),
    };
    definitions.set(JSON.stringify(definition), definition);
    if (row.tool !== undefined) requiredTools.add(iriValue(row.tool));
  }
  if (definitions.size !== 1) {
    throw new SemanticProgramError('PROGRAM_AMBIGUOUS', 'Program has multiple definitions', 409);
  }
  const [definition] = definitions.values();
  if (definition.language !== 'sexpr-v1') {
    throw new SemanticProgramError(
      'UNSUPPORTED_PROGRAM_LANGUAGE',
      `Unsupported program language: ${definition.language}`,
      409,
    );
  }
  return {
    contextGraphId,
    programIri,
    ...definition,
    requiredTools: [...requiredTools].sort(),
  };
}

export async function resolveStoredSemanticProgram(
  agent: DKGAgent,
  contextGraphId: string,
  programIri: string,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<SemanticProgramResolution> {
  return (await resolveInternal(
    agent,
    contextGraphId,
    programIri,
    config,
    llmConfig,
    callerAgentAddress,
  )).public;
}

export async function invokeStoredSemanticProgram(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  programIri: string,
  invocationId: string,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<SemanticInvocationResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId)) {
    throw new SemanticProgramError('INVALID_INVOCATION_ID', 'invocationId must be a UUID', 400);
  }
  const key = `${contextGraphId}\0${invocationId}`;
  const existing = runtime.inFlight.get(key);
  if (existing) return existing;
  const invocation = invokeResolved(
    agent,
    runtime,
    contextGraphId,
    programIri,
    invocationId.toLowerCase(),
    config,
    llmConfig,
    callerAgentAddress,
  );
  runtime.inFlight.set(key, invocation);
  try {
    return await invocation;
  } finally {
    runtime.inFlight.delete(key);
  }
}

interface InternalResolution {
  public: SemanticProgramResolution;
  program: StoredSemanticProgram;
  plan: AdmittedPlanSummary;
  registry: RuntimeAdapterRegistry;
  operatorAddress: string;
  policyHashHex: string;
}

async function resolveInternal(
  agent: DKGAgent,
  contextGraphId: string,
  programIri: string,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<InternalResolution> {
  const program = await loadStoredSemanticProgram(agent, contextGraphId, programIri, callerAgentAddress);
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
  const operatorAddress = agent.getDefaultAgentAddress();
  if (!operatorAddress) {
    throw new SemanticProgramError('OPERATOR_IDENTITY_UNAVAILABLE', 'Node has no default operator agent', 409);
  }
  const operatorIri = `did:dkg:agent:${operatorAddress}`;
  const policyIri = config?.operatorPolicyIri;
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
  `, queryOptions(contextGraphId, 'semantic-runtime-policy-load', callerAgentAddress));
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
  const [policyVersion] = policyVersions;
  const allowedTools = new Set(policyRows.map((row) => iriValue(row.tool)));
  const policyHashHex = hashParts([
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
  `, queryOptions(contextGraphId, 'semantic-runtime-tool-offers', callerAgentAddress));
  const offerRows = resultRows(offerResult).filter((row) =>
    isOperatorVmGraph(row.g, contextGraphId, operatorAddress));

  const registry = new RuntimeAdapterRegistry();
  registry.register(createInvestigatorAdapter(llmConfig));
  const tools = program.requiredTools.map((toolIri): SemanticToolResolution => {
    const rows = offerRows.filter((row) => iriValue(row.tool) === toolIri);
    const definitions = new Map<string, { operation: string; version: string; wit: string }>();
    for (const row of rows) {
      const definition = {
        operation: literalValue(row.operation),
        version: literalValue(row.toolVersion),
        wit: literalValue(row.witInterface),
      };
      definitions.set(JSON.stringify(definition), definition);
    }
    const definition = definitions.size === 1 ? [...definitions.values()][0] : null;
    const adapter = definition ? registry.describe(definition.operation, definition.version) : null;
    const offered = rows.length > 0;
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

  const previousResult = await agent.query(`
    SELECT DISTINCT ?execution WHERE {
      GRAPH ?g {
        ?execution <${RDF_TYPE}> <${SR}Execution> ;
          <${SR}usedProgram> ${sparqlIri(programIri)} .
      }
    }
  `, queryOptions(contextGraphId, 'semantic-runtime-previous-executions', callerAgentAddress));
  const previousExecutions = resultRows(previousResult)
    .map((row) => iriValue(row.execution))
    .sort();
  return {
    public: {
      contextGraphId,
      programIri,
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

async function invokeResolved(
  agent: DKGAgent,
  runtime: ConfiguredSemanticRuntimeService,
  contextGraphId: string,
  programIri: string,
  invocationId: string,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<SemanticInvocationResult> {
  const resolved = await resolveInternal(
    agent,
    contextGraphId,
    programIri,
    config,
    llmConfig,
    callerAgentAddress,
  );
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
  if (existingExecution?.status === 'completed') {
    if (!priorHistory?.vmCurrentAssertion || !priorHistory.publishedUal) {
      throw new SemanticProgramError(
        'EXECUTION_PERSISTENCE_INCONSISTENT',
        'Invocation journal says completed but its Execution KA is not in Verifiable Memory',
        500,
      );
    }
    return {
      invocationId,
      executionIri,
      executionUal: priorHistory.publishedUal,
      persisted: true,
    };
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
        graphRevision: resolved.policyHashHex,
        policyEpoch: 1n,
        rootProcessId: executionIri,
        leaseEpoch: 0n,
      });
    } catch (error) {
      if (!runtime.store.execution(executionIri)) throw error;
    }
  }

  const startedAt = new Date();
  const receipt = await runtime.host.startPlan(resolved.plan.canonicalPlan, 0n);
  if (!bytesEqual(receipt.canonicalHash, resolved.plan.canonicalHash)) {
    throw new Error('materialized strategy hash differs from admitted strategy hash');
  }
  const policyFactsDigest = Uint8Array.from(Buffer.from(resolved.policyHashHex, 'hex'));
  const broker = new RuntimeEffectBroker(
    runtime.store,
    {
      evaluate: async () => ({
        decision: 'allow',
        policyId: resolved.public.selectedPolicy.iri,
        policyEpoch: 1n,
        factsDigest: policyFactsDigest,
        reasonCode: 'OPERATOR_POLICY_ALLOW',
      }),
    },
    resolved.registry,
    admittedPlanAuthority(resolved.plan),
  );
  const capabilityId = `urn:sr:capability:${invocationId}`;
  if (!runtime.store.capability(capabilityId)) {
    const now = Date.now();
    runtime.store.putCapability({
      capabilityId,
      executionId: executionIri,
      metadataCbor: encodeCapabilityMetadata({
        subject: resolved.public.executingNode,
        audience: 'dkg-semantic-runtime',
        executionId: executionIri,
        verbs: ['investigate'],
        resources: resolved.program.requiredTools,
        delegationDepth: 0,
        oneShot: true,
        budgetMicros: 0n,
      }),
      hostBindingKey: resolved.public.requiredTools[0]?.adapterHash ?? 'no-adapter',
      policyEpoch: 1n,
      notBefore: now - 1_000,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      oneShot: true,
      consumedAt: null,
      revokedAt: null,
    });
  }

  let execution = await runtime.host.applyPlan(receipt.handle);
  while (execution.kind === 'effect-requested') {
    const effect = execution;
    const tool = resolved.public.requiredTools.find((candidate) =>
      candidate.operation === effect.operation
      && candidate.semanticVersion === String(effect.version));
    if (!tool) {
      throw new SemanticProgramError('UNSUPPORTED_PROGRAM_EFFECT', 'Unsupported program effect', 422);
    }
    const effectId = `urn:sr:effect:${invocationId}:${effect.effectId}`;
    await broker.prepareEffect({
      effectId,
      executionId: executionIri,
      processId: toHex(effect.processId),
      stepId: `wasm-effect-${effect.effectId}`,
      attemptId: 'attempt-1',
      principal: resolved.public.executingNode,
      adapterId: effect.operation,
      adapterVersion: String(effect.version),
      verb: 'investigate',
      resource: tool.toolIri,
      normalizedInput: { prompt: textArgument(effect.arguments[0]) },
      capabilityId,
      idempotencyKey: `${executionIri}:${effect.effectId}`,
      budgetReservation: 0n,
      now: Date.now(),
    });
    let outcome = broker.readOutcome(effectId);
    if (outcome?.state === 'prepared') {
      await broker.dispatchPrepared(effectId, Date.now());
      outcome = broker.readOutcome(effectId);
    }
    if (outcome?.state !== 'succeeded' || typeof outcome.output !== 'string') {
      if (outcome?.state === 'dispatching' || outcome?.state === 'unknown' || outcome?.state === 'reconciling') {
        throw new SemanticProgramError(
          'INVOCATION_REQUIRES_RECONCILIATION',
          'The LLM call may have reached Codex; it will not be dispatched again automatically',
          409,
        );
      }
      runtime.store.setExecutionStatus(executionIri, 'failed');
      throw new SemanticProgramError('LLM_REQUEST_FAILED', 'LLM request failed', 502);
    }
    execution = await runtime.host.applyPlan(receipt.handle, {
      effectId: effect.effectId,
      ok: true,
      value: outcome.output,
    });
  }
  const inspection = await runtime.host.inspectPlan(receipt.handle);
  const finishedAt = new Date();
  const quads = buildExecutionQuads({
    executionIri,
    invocationId,
    programIri,
    operatorIri: resolved.public.executingNode,
    policy: resolved.public.selectedPolicy,
    programHash: artifactHash,
    tools: resolved.public.requiredTools,
    events: execution.events,
    outputs: execution.outputs,
    agents: inspection.agents,
    startedAt,
    finishedAt,
  });
  let executionUal: string;
  try {
    executionUal = await persistExecutionKnowledgeAsset(
      agent,
      contextGraphId,
      assertionName,
      resolved.operatorAddress,
      quads,
    );
  } catch (error) {
    if (error instanceof SemanticProgramError) throw error;
    throw new SemanticProgramError(
      'EXECUTION_PERSIST_FAILED',
      `Execution completed but its Knowledge Asset was not persisted: ${safeMessage(error)}`,
      502,
    );
  }
  runtime.store.setExecutionStatus(executionIri, 'completed');
  return { invocationId, executionIri, executionUal, persisted: true };
}

function buildExecutionQuads(input: {
  executionIri: string;
  invocationId: string;
  programIri: string;
  operatorIri: string;
  policy: { iri: string; version: string; hash: string };
  programHash: string;
  tools: SemanticToolResolution[];
  events: Array<{ role: string; processId: Uint8Array; value: string }>;
  outputs: Array<{ role: string; processId: Uint8Array; value: string }>;
  agents: Array<{ role: string; processId: Uint8Array; status: string }>;
  startedAt: Date;
  finishedAt: Date;
}) {
  const quads: Array<{ subject: string; predicate: string; object: string }> = [
    iriQuad(input.executionIri, RDF_TYPE, `${SR}Execution`),
    literalQuad(input.executionIri, `${SR}invocationId`, input.invocationId),
    iriQuad(input.executionIri, `${SR}usedProgram`, input.programIri),
    iriQuad(input.executionIri, `${SR}executedBy`, input.operatorIri),
    iriQuad(input.executionIri, `${SR}appliedPolicy`, input.policy.iri),
    literalQuad(input.executionIri, `${SR}version`, input.policy.version),
    literalQuad(input.executionIri, `${SR}policyHash`, input.policy.hash),
    literalQuad(input.executionIri, `${SR}programHash`, `sha256:${input.programHash}`),
    iriQuad(input.executionIri, `${SR}status`, `${SR}Succeeded`),
    typedLiteralQuad(input.executionIri, `${PROV}startedAtTime`, input.startedAt.toISOString(), XSD_DATE_TIME),
    typedLiteralQuad(input.executionIri, `${PROV}endedAtTime`, input.finishedAt.toISOString(), XSD_DATE_TIME),
  ];
  for (const tool of input.tools) {
    quads.push(iriQuad(input.executionIri, `${SR}usedTool`, tool.toolIri));
    if (tool.adapterVersion) quads.push(literalQuad(input.executionIri, `${SR}adapterVersion`, tool.adapterVersion));
    if (tool.adapterHash) quads.push(literalQuad(input.executionIri, `${SR}adapterHash`, tool.adapterHash));
  }
  for (const event of input.events) {
    quads.push(literalQuad(input.executionIri, `${SR}event`, JSON.stringify({
      role: event.role,
      processId: toHex(event.processId),
      value: event.value,
    })));
  }
  for (const agent of input.agents) {
    quads.push(literalQuad(input.executionIri, `${SR}agentStatus`, JSON.stringify({
      role: agent.role,
      processId: toHex(agent.processId),
      status: agent.status,
    })));
  }
  for (const output of input.outputs) {
    const exactBytes = Buffer.from(output.value, 'utf8');
    quads.push(literalQuad(input.executionIri, `${SR}output`, output.value));
    quads.push(literalQuad(
      input.executionIri,
      `${SR}outputHash`,
      `sha256:${createHash('sha256').update(exactBytes).digest('hex')}`,
    ));
  }
  return quads;
}

async function persistExecutionKnowledgeAsset(
  agent: DKGAgent,
  contextGraphId: string,
  name: string,
  operatorAddress: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
): Promise<string> {
  const lane = { agentAddress: operatorAddress };
  let history = await agent.assertion.history(contextGraphId, name, lane);
  if (history?.vmCurrentAssertion && history.publishedUal) return history.publishedUal;
  if (!history) {
    await agent.assertion.create(contextGraphId, name, lane);
    await agent.assertion.write(contextGraphId, name, quads, lane);
    await agent.assertion.finalize(contextGraphId, name, lane);
    history = await agent.assertion.history(contextGraphId, name, lane);
  } else if (!history.wmCurrentAssertion) {
    await agent.assertion.write(contextGraphId, name, quads, lane);
    await agent.assertion.finalize(contextGraphId, name, lane);
    history = await agent.assertion.history(contextGraphId, name, lane);
  }
  if (!history?.swmCurrentAssertion) {
    const share = await agent.assertion.promote(contextGraphId, name, lane);
    if (!share.publishReady) {
      throw new SemanticProgramError(
        'EXECUTION_SHARE_FAILED',
        'Execution Knowledge Asset was not made publish-ready in Shared Working Memory',
        502,
      );
    }
  }
  const publication = await agent.publishFromFinalizedAssertion(contextGraphId, name, lane);
  if (publication.status !== 'confirmed' || publication.contextGraphError || !publication.ual) {
    throw new SemanticProgramError(
      'EXECUTION_PUBLISH_FAILED',
      publication.contextGraphError
        ?? `Execution Knowledge Asset publish did not confirm (${publication.status})`,
      502,
    );
  }
  return publication.ual;
}

export function validateSemanticRuntimeConfig(config: SemanticRuntimeConfig): void {
  validatePositiveInteger(config.watchdogMs, 'semanticRuntime.watchdogMs', 60_000);
  validatePositiveInteger(config.startupTimeoutMs, 'semanticRuntime.startupTimeoutMs', 120_000);
  validatePositiveInteger(config.maxEvents, 'semanticRuntime.maxEvents', 100_000);
  if (config.partitionId !== undefined && !/^[0-9a-fA-F]{64}$/.test(config.partitionId)) {
    throw new Error('semanticRuntime.partitionId must be 64 hexadecimal characters');
  }
  if (config.operatorPolicyIri !== undefined) {
    try {
      sparqlIri(config.operatorPolicyIri);
    } catch {
      throw new Error('semanticRuntime.operatorPolicyIri must be an absolute IRI');
    }
  }
  if (config.maxAccumulator !== undefined) {
    let value: bigint;
    try {
      value = BigInt(config.maxAccumulator);
    } catch {
      throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
    }
    if (value <= 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
    }
  }
}

function validateGraphAndProgram(contextGraphId: string, programIri: string): void {
  const graphValidation = validateContextGraphId(contextGraphId);
  if (!graphValidation.valid) {
    throw new SemanticProgramError(
      'INVALID_CONTEXT_GRAPH',
      `Invalid contextGraphId: ${graphValidation.reason}`,
      400,
    );
  }
  try {
    sparqlIri(programIri);
  } catch {
    throw new SemanticProgramError('INVALID_PROGRAM_IRI', 'programIri must be an absolute IRI', 400);
  }
}

function isOperatorVmGraph(value: unknown, contextGraphId: string, operatorAddress: string): boolean {
  try {
    const identity = parseContextGraphLayerUri(iriValue(value));
    return identity?.contextGraphId === contextGraphId
      && identity.layer === MemoryLayer.VerifiableMemory
      && identity.agentAddress.toLowerCase() === operatorAddress.toLowerCase();
  } catch {
    return false;
  }
}

function queryOptions(contextGraphId: string, source: string, callerAgentAddress?: string) {
  return {
    contextGraphId,
    view: 'verifiable-memory' as const,
    source,
    ...(callerAgentAddress ? { callerAgentAddress } : {}),
  };
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== 'object' || result === null || !('bindings' in result)) return [];
  const rows = (result as { bindings?: unknown }).bindings;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

function textArgument(value: string | undefined): string {
  if (value?.startsWith('t:') || value?.startsWith('s:')) return value.slice(2);
  throw new SemanticProgramError('INVALID_LLM_ARGUMENT', 'LLM prompt must be text', 422);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function hashParts(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function iriValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  if (typeof value !== 'string') throw new Error('Expected RDF IRI binding');
  const match = value.match(/^<([^>]+)>$/);
  return match?.[1] ?? value;
}

function literalValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  if (typeof value !== 'string') {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program fields must be RDF literals', 422);
  }
  const match = value.match(/^"((?:\\.|[^"\\])*)"(?:@[A-Za-z0-9-]+|\^\^<[^>]+>)?$/s);
  if (!match) {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program fields must be RDF literals', 422);
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program contains an invalid RDF literal', 422);
  }
}

function iriQuad(subject: string, predicate: string, object: string) {
  return { subject, predicate, object };
}

function literalQuad(subject: string, predicate: string, value: string) {
  return { subject, predicate, object: JSON.stringify(value) };
}

function typedLiteralQuad(subject: string, predicate: string, value: string, datatype: string) {
  return { subject, predicate, object: `${JSON.stringify(value)}^^<${datatype}>` };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositiveInteger(value: number | undefined, name: string, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
}
