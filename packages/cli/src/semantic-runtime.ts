import { createHash } from 'node:crypto';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  sparqlIri,
  validateContextGraphId,
} from '@origintrail-official/dkg-core';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import { ethers } from 'ethers';
import {
  RuntimeAdapterRegistry,
  RuntimeEffectBroker,
  SemanticRuntimeStore,
  WasmStrategyAdmissionClient,
  admittedPlanAuthority,
  encodeCapabilityMetadata,
  startSemanticRuntimeHost,
  type AdmittedPlanSummary,
  type ComponentToolDispatcher,
  type SemanticRuntimeConfig,
  type SemanticRuntimeHost,
  type SemanticRuntimeHostOptions,
  type ExecutionCapabilityDescriptor,
} from '@origintrail-official/dkg-semantic-runtime';

import { createInvestigatorAdapter } from './semantic-runtime-investigator-adapter.js';
import { createDkgQueryAdapter } from './semantic-runtime-query-adapter.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const SR = 'https://origintrail.io/semantic-runtime/v1#';

export interface StoredSemanticProgram {
  contextGraphId: string;
  programIri: string;
  layer: SemanticMemoryLayer;
  authorAgentAddress: string;
  language: string;
  version: string;
  source: string;
  requiredTools: string[];
}

export type SemanticMemoryLayer = 'wm' | 'swm' | 'vm';

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
  programLayer: SemanticMemoryLayer;
  executingNode: string;
  selectedPolicy: { iri: string; version: string; hash: string };
  requiredTools: SemanticToolResolution[];
  previousExecutions: string[];
  executable: boolean;
}

export interface SemanticInvocationResult {
  invocationId: string;
  executionIri: string;
  executionLayer: SemanticMemoryLayer;
  executionUal?: string;
  persisted: true;
}

export interface SemanticProgramForkResult {
  programIri: string;
  programLayer: SemanticMemoryLayer;
  programUal?: string;
  authorAgentAddress: string;
  derivedFrom: string;
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
  inFlight: Map<string, {
    programLayer: SemanticMemoryLayer;
    executionLayer: SemanticMemoryLayer;
    promise: Promise<SemanticInvocationResult>;
  }>;
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
  programLayer: SemanticMemoryLayer,
  callerAgentAddress?: string,
): Promise<StoredSemanticProgram> {
  validateGraphAndProgram(contextGraphId, programIri);
  validateSemanticMemoryLayer(programLayer, 'programLayer');
  const safeProgramIri = sparqlIri(programIri);
  const result = await agent.query(`
    SELECT DISTINCT ?g ?language ?version ?source ?tool WHERE {
      GRAPH ?g {
        ${safeProgramIri} <${RDF_TYPE}> <${SR}Program> ;
          <${SR}language> ?language ;
          <${SR}version> ?version ;
          <${SR}source> ?source .
        OPTIONAL { ${safeProgramIri} <${SR}requiresTool> ?tool }
      }
    }
  `, queryOptions(
    contextGraphId,
    programLayer,
    'semantic-runtime-program-load',
    callerAgentAddress,
  ));
  const rows = resultRows(result).flatMap((row) => {
    const authorAgentAddress = programGraphAuthor(row.g, contextGraphId, programLayer);
    return authorAgentAddress ? [{ row, authorAgentAddress }] : [];
  });
  if (rows.length === 0) {
    throw new SemanticProgramError(
      'PROGRAM_NOT_FOUND',
      `Program not found in ${semanticLayerLabel(programLayer)}`,
      404,
    );
  }
  const definitions = new Map<string, { language: string; version: string; source: string }>();
  const authors = new Set<string>();
  const requiredTools = new Set<string>();
  for (const { row, authorAgentAddress } of rows) {
    const definition = {
      language: literalValue(row.language),
      version: literalValue(row.version),
      source: literalValue(row.source),
    };
    definitions.set(JSON.stringify(definition), definition);
    authors.add(authorAgentAddress);
    if (row.tool !== undefined) requiredTools.add(iriValue(row.tool));
  }
  if (definitions.size !== 1 || authors.size !== 1) {
    throw new SemanticProgramError(
      'PROGRAM_AMBIGUOUS',
      'Program has multiple definitions or authors',
      409,
    );
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
    layer: programLayer,
    authorAgentAddress: [...authors][0],
    ...definition,
    requiredTools: [...requiredTools].sort(),
  };
}

export async function assertSemanticContextGraphMember(
  agent: DKGAgent,
  contextGraphId: string,
  callerAgentAddress: string,
): Promise<void> {
  const owner = await agent.getContextGraphOwner(contextGraphId);
  const isOwner = agent.curatorDidMatchesChecksumAgent(owner ?? undefined, callerAgentAddress);
  let canRead = await agent.canReadContextGraph(contextGraphId, {
    callerAgentAddress,
    allowSubscriptionFallback: false,
  });
  if (!isOwner && !canRead) {
    const refreshed = await agent.refreshMetaFromCurator(contextGraphId).catch(() => false);
    if (refreshed) {
      canRead = await agent.canReadContextGraph(contextGraphId, {
        callerAgentAddress,
        allowSubscriptionFallback: false,
      });
    }
  }
  if (!isOwner && !canRead) {
    throw new SemanticProgramError(
      'PROGRAM_CONTEXT_GRAPH_FORBIDDEN',
      `Wallet ${callerAgentAddress} cannot access Context Graph ${contextGraphId}`,
      403,
    );
  }
}

export async function forkStoredSemanticProgram(
  agent: DKGAgent,
  contextGraphId: string,
  sourceProgramIri: string,
  newProgramIri: string,
  sourceLayer: SemanticMemoryLayer,
  targetLayer: SemanticMemoryLayer,
  callerAgentAddress: string,
): Promise<SemanticProgramForkResult> {
  validateGraphAndProgram(contextGraphId, sourceProgramIri);
  validateGraphAndProgram(contextGraphId, newProgramIri);
  validateSemanticMemoryLayer(sourceLayer, 'sourceLayer');
  validateSemanticMemoryLayer(targetLayer, 'targetLayer');
  if (sourceProgramIri === newProgramIri) {
    throw new SemanticProgramError(
      'PROGRAM_FORK_IRI_CONFLICT',
      'The fork must use a new Program IRI',
      409,
    );
  }
  let authorAgentAddress: string;
  try {
    authorAgentAddress = ethers.getAddress(callerAgentAddress);
  } catch {
    throw new SemanticProgramError('INVALID_CALLER_WALLET', 'Caller wallet is invalid', 400);
  }
  // Forking is a normal DKG write. The assertion share/publish pipeline below
  // enforces the Context Graph's actual publish policy; a node-local participant
  // projection is not authoritative for open graphs and may lag the curator.
  const source = await loadStoredSemanticProgram(
    agent,
    contextGraphId,
    sourceProgramIri,
    sourceLayer,
    authorAgentAddress,
  );
  const localAuthor = agent.listLocalAgents().find(({ agentAddress }) =>
    agentAddress.toLowerCase() === authorAgentAddress.toLowerCase());
  if (!localAuthor || !agent.getCustodialAgentPrivateKey(localAuthor.agentAddress)) {
    throw new SemanticProgramError(
      'PROGRAM_FORK_AUTHOR_NOT_CUSTODIAL',
      'The copying wallet must be a custodial agent on this node',
      409,
    );
  }

  const name = `semantic-program-fork-${hashParts([sourceProgramIri, newProgramIri]).slice(0, 24)}`;
  const lane = { agentAddress: authorAgentAddress };
  const existingHistory = await agent.assertion.history(contextGraphId, name, lane);
  if (existingHistory && historyIsAtLayer(existingHistory, targetLayer)) {
    return {
      programIri: newProgramIri,
      programLayer: targetLayer,
      ...(targetLayer === 'vm' ? { programUal: existingHistory.publishedUal } : {}),
      authorAgentAddress,
      derivedFrom: sourceProgramIri,
      persisted: true,
    };
  }
  if (existingHistory) {
    throw new SemanticProgramError(
      'PROGRAM_FORK_LAYER_CONFLICT',
      `The fork already exists in ${historyLayerLabel(existingHistory)}; use the normal DKG promotion controls to move it`,
      409,
    );
  }
  const existing = await agent.query(`
    SELECT DISTINCT ?g WHERE {
      GRAPH ?g { ${sparqlIri(newProgramIri)} ?predicate ?object }
    }
  `, queryOptions(
    contextGraphId,
    targetLayer,
    'semantic-runtime-program-fork-target',
    authorAgentAddress,
  ));
  if (resultRows(existing).length > 0) {
    throw new SemanticProgramError(
      'PROGRAM_FORK_IRI_CONFLICT',
      `Program IRI ${newProgramIri} already exists in ${semanticLayerLabel(targetLayer)}`,
      409,
    );
  }

  const quads = [
    iriQuad(newProgramIri, RDF_TYPE, `${SR}Program`),
    literalQuad(newProgramIri, `${SR}language`, source.language),
    literalQuad(newProgramIri, `${SR}version`, source.version),
    literalQuad(newProgramIri, `${SR}source`, source.source),
    iriQuad(newProgramIri, `${PROV}wasDerivedFrom`, sourceProgramIri),
    ...source.requiredTools.map((toolIri) =>
      iriQuad(newProgramIri, `${SR}requiresTool`, toolIri)),
  ];
  const persistence = await persistProgramKnowledgeAsset(
    agent,
    contextGraphId,
    name,
    authorAgentAddress,
    quads,
    existingHistory,
    targetLayer,
  );
  return {
    programIri: newProgramIri,
    programLayer: targetLayer,
    ...(persistence.ual ? { programUal: persistence.ual } : {}),
    authorAgentAddress,
    derivedFrom: sourceProgramIri,
    persisted: true,
  };
}

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
): Promise<SemanticInvocationResult> {
  validateSemanticMemoryLayer(programLayer, 'programLayer');
  validateSemanticMemoryLayer(executionLayer, 'executionLayer');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId)) {
    throw new SemanticProgramError('INVALID_INVOCATION_ID', 'invocationId must be a UUID', 400);
  }
  const key = `${contextGraphId}\0${invocationId}`;
  const existing = runtime.inFlight.get(key);
  if (existing) {
    if (existing.programLayer !== programLayer || existing.executionLayer !== executionLayer) {
      throw new SemanticProgramError(
        'INVOCATION_LAYER_CONFLICT',
        'invocationId is already running with different Program or Execution layers',
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
  );
  runtime.inFlight.set(key, { programLayer, executionLayer, promise: invocation });
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
  programLayer: SemanticMemoryLayer,
  config: SemanticRuntimeConfig | undefined,
  llmConfig?: LlmConfig,
  callerAgentAddress?: string,
): Promise<InternalResolution> {
  const program = await loadStoredSemanticProgram(
    agent,
    contextGraphId,
    programIri,
    programLayer,
    callerAgentAddress,
  );
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
  const operatorAddress = program.authorAgentAddress;
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
  `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-policy-load', callerAgentAddress));
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
  `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-tool-offers', callerAgentAddress));
  const offerRows = resultRows(offerResult).filter((row) =>
    isOperatorVmGraph(row.g, contextGraphId, operatorAddress));

  const registry = new RuntimeAdapterRegistry();
  registry.register(createInvestigatorAdapter(llmConfig));
  registry.register(createDkgQueryAdapter(agent, contextGraphId, callerAgentAddress));
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

async function invokeResolved(
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
): Promise<SemanticInvocationResult> {
  const resolved = await resolveInternal(
    agent,
    contextGraphId,
    programIri,
    programLayer,
    config,
    llmConfig,
    callerAgentAddress,
  );
  const localAuthor = agent.listLocalAgents().find(({ agentAddress }) =>
    agentAddress.toLowerCase() === resolved.operatorAddress.toLowerCase());
  if (!localAuthor || !agent.getCustodialAgentPrivateKey(localAuthor.agentAddress)) {
    throw new SemanticProgramError(
      'PROGRAM_AUTHOR_NOT_LOCAL',
      'This node does not host the Program author wallet as a custodial agent',
      409,
    );
  }
  resolved.operatorAddress = localAuthor.agentAddress;
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
    contextGraphId,
    programIri,
    programLayer,
    executionLayer,
  ]);
  if (existingExecution?.status === 'completed') {
    if (existingExecution.graphRevision !== executionGraphRevision) {
      throw new SemanticProgramError(
        'INVOCATION_LAYER_CONFLICT',
        'invocationId was already completed with different Program or Execution layers',
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
      persisted: true,
    };
  }
  if (existingExecution && existingExecution.graphRevision !== executionGraphRevision) {
    throw new SemanticProgramError(
      'INVOCATION_LAYER_CONFLICT',
      'invocationId already belongs to different Program or Execution layers',
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
      if (!runtime.store.execution(executionIri)) throw error;
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
      maxDkgQueries: resolved.plan.effectUpperBound.includes('read') ? 1 : 0,
    },
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
    revoked: false,
    approvals: [...resolved.plan.approvalRequirements],
  };
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
    const capabilityVerbs = [...new Set(resolved.public.requiredTools.flatMap((tool) => {
      if (!tool.operation || !tool.semanticVersion) return [];
      const descriptor = resolved.registry.describe(tool.operation, tool.semanticVersion);
      return descriptor ? [descriptor.verb] : [];
    }))];
    const readOnly = resolved.plan.effectUpperBound.every((effectClass) => effectClass === 'read');
    runtime.store.putCapability({
      capabilityId,
      executionId: executionIri,
      metadataCbor: encodeCapabilityMetadata({
        subject: resolved.public.executingNode,
        audience: 'dkg-semantic-runtime',
        executionId: executionIri,
        verbs: capabilityVerbs,
        resources: resolved.program.requiredTools,
        delegationDepth: 0,
        oneShot: !readOnly,
        budgetMicros: 0n,
      }),
      hostBindingKey: resolved.public.requiredTools[0]?.adapterHash ?? 'no-adapter',
      policyEpoch: 1n,
      notBefore: now - 1_000,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      oneShot: !readOnly,
      consumedAt: null,
      revokedAt: null,
    });
  }

  const toolDispatcher: ComponentToolDispatcher = async (call) => {
    const binding = call.kind === 'investigator'
      ? {
        operation: 'agent/investigate',
        version: '1',
        normalizedInput: { prompt: call.prompt },
      }
      : {
        operation: 'dkg/query',
        version: '1',
        normalizedInput: {
          selector: call.queryId,
          parameters: Object.fromEntries(call.parameters.map(({ name, value }) => [name, value])),
        },
      };
    const tool = resolved.public.requiredTools.find((candidate) =>
      candidate.operation === binding.operation
      && candidate.semanticVersion === binding.version);
    const descriptor = resolved.registry.describe(binding.operation, binding.version);
    if (!tool || !descriptor) {
      throw new SemanticProgramError('UNSUPPORTED_PROGRAM_TOOL', 'Unsupported WASI tool import', 422);
    }
    const effectId = `urn:sr:effect:${invocationId}:${call.effectId}`;
    const proposal = {
      effectId,
      executionId: executionIri,
      processId: `wasi:${call.kind}`,
      stepId: `wasi-tool-${call.effectId}`,
      attemptId: 'attempt-1',
      principal: resolved.public.executingNode,
      adapterId: binding.operation,
      adapterVersion: binding.version,
      verb: descriptor.verb,
      resource: tool.toolIri,
      normalizedInput: binding.normalizedInput,
      capabilityId,
      idempotencyKey: `${executionIri}:${call.effectId}`,
      budgetReservation: 0n,
      now: Date.now(),
    };
    let outcome;
    if (descriptor.effectClass === 'read') {
      try {
        outcome = await broker.dispatchRead(proposal);
      } catch (error) {
        runtime.store.setExecutionStatus(executionIri, 'failed');
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
      }
    }
    if (outcome?.state !== 'succeeded' || typeof outcome.output !== 'string') {
      if (outcome?.state === 'dispatching' || outcome?.state === 'unknown' || outcome?.state === 'reconciling') {
        throw new SemanticProgramError(
          'INVOCATION_REQUIRES_RECONCILIATION',
          'The tool call may have reached its target; it will not be dispatched again automatically',
          409,
        );
      }
      runtime.store.setExecutionStatus(executionIri, 'failed');
      throw new SemanticProgramError('TOOL_REQUEST_FAILED', 'WASI tool request failed', 502);
    }
    return call.kind === 'investigator'
      ? { kind: 'investigator', output: outcome.output }
      : { kind: 'query-catalog', json: outcome.output };
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
  } finally {
    await runtime.host.dropPlan(receipt.handle).catch(() => undefined);
  }
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
  return {
    invocationId,
    executionIri,
    executionLayer,
    ...(persistence.ual ? { executionUal: persistence.ual } : {}),
    persisted: true,
  };
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
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>,
  targetLayer: SemanticMemoryLayer,
): Promise<PersistenceEvidence> {
  return persistKnowledgeAsset(agent, contextGraphId, name, operatorAddress, quads, initialHistory, targetLayer, {
    layerConflict: 'EXECUTION_LAYER_CONFLICT',
    shareFailed: 'EXECUTION_SHARE_FAILED',
    publishFailed: 'EXECUTION_PUBLISH_FAILED',
    subject: 'Execution Knowledge Asset',
  });
}

async function persistProgramKnowledgeAsset(
  agent: DKGAgent,
  contextGraphId: string,
  name: string,
  authorAgentAddress: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>,
  targetLayer: SemanticMemoryLayer,
): Promise<PersistenceEvidence> {
  return persistKnowledgeAsset(agent, contextGraphId, name, authorAgentAddress, quads, initialHistory, targetLayer, {
    layerConflict: 'PROGRAM_FORK_LAYER_CONFLICT',
    shareFailed: 'PROGRAM_FORK_SHARE_FAILED',
    publishFailed: 'PROGRAM_FORK_PUBLISH_FAILED',
    subject: 'Forked Program',
  });
}

interface PersistenceEvidence {
  layer: SemanticMemoryLayer;
  ual?: string;
}

async function persistKnowledgeAsset(
  agent: DKGAgent,
  contextGraphId: string,
  name: string,
  agentAddress: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>,
  targetLayer: SemanticMemoryLayer,
  errors: {
    layerConflict: string;
    shareFailed: string;
    publishFailed: string;
    subject: string;
  },
): Promise<PersistenceEvidence> {
  const lane = { agentAddress };
  let history = initialHistory;
  if (history && historyIsAtLayer(history, targetLayer)) {
    return {
      layer: targetLayer,
      ...(targetLayer === 'vm' && history.publishedUal ? { ual: history.publishedUal } : {}),
    };
  }
  if (history?.memoryLayer) {
    throw new SemanticProgramError(
      errors.layerConflict,
      `${errors.subject} already exists in ${historyLayerLabel(history)}`,
      409,
    );
  }
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
  if (!history?.wmCurrentAssertion) {
    throw new SemanticProgramError(
      errors.layerConflict,
      `${errors.subject} was not finalized in Working Memory`,
      502,
    );
  }
  if (targetLayer === 'wm') return { layer: targetLayer };
  if (!history?.swmCurrentAssertion) {
    const share = await agent.assertion.promote(contextGraphId, name, lane);
    if (!share.publishReady) {
      throw new SemanticProgramError(
        errors.shareFailed,
        `${errors.subject} was not made publish-ready in Shared Working Memory`,
        502,
      );
    }
  }
  if (targetLayer === 'swm') return { layer: targetLayer };
  const publication = await agent.publishFromFinalizedAssertion(contextGraphId, name, lane);
  if (publication.status !== 'confirmed' || publication.contextGraphError || !publication.ual) {
    throw new SemanticProgramError(
      errors.publishFailed,
      publication.contextGraphError
        ?? `${errors.subject} publish did not confirm (${publication.status})`,
      502,
    );
  }
  return { layer: targetLayer, ual: publication.ual };
}

export function validateSemanticRuntimeConfig(config: SemanticRuntimeConfig): void {
  validatePositiveInteger(config.watchdogMs, 'semanticRuntime.watchdogMs', 60_000);
  validatePositiveInteger(config.startupTimeoutMs, 'semanticRuntime.startupTimeoutMs', 120_000);
  validatePositiveInteger(config.maxEvents, 'semanticRuntime.maxEvents', 100_000);
  validatePositiveInteger(
    config.maxActiveExecutions,
    'semanticRuntime.maxActiveExecutions',
    1_024,
  );
  validatePositiveInteger(
    config.maxOperationsPerExecution,
    'semanticRuntime.maxOperationsPerExecution',
    10_000_000,
  );
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
  return programGraphAuthor(value, contextGraphId, 'vm')?.toLowerCase() === operatorAddress.toLowerCase();
}

function programGraphAuthor(
  value: unknown,
  contextGraphId: string,
  layer: SemanticMemoryLayer,
): string | null {
  try {
    const directory = {
      wm: '_working_memory',
      swm: '_shared_memory',
      vm: '_verifiable_memory',
    }[layer];
    const prefix = `did:dkg:context-graph:${contextGraphId}/${directory}/`;
    const graphIri = iriValue(value);
    if (!graphIri.startsWith(prefix)) return null;
    const suffix = graphIri.slice(prefix.length);
    const separator = suffix.indexOf('/');
    if (separator <= 0 || suffix.indexOf('/', separator + 1) !== -1) return null;
    const agentAddress = suffix.slice(0, separator);
    const kaNumber = suffix.slice(separator + 1);
    return ethers.isAddress(agentAddress) && /^\d+$/.test(kaNumber)
      ? ethers.getAddress(agentAddress)
      : null;
  } catch {
    return null;
  }
}

function queryOptions(
  contextGraphId: string,
  layer: SemanticMemoryLayer,
  source: string,
  callerAgentAddress?: string,
) {
  const view = {
    wm: 'working-memory',
    swm: 'shared-working-memory',
    vm: 'verifiable-memory',
  } as const;
  return {
    contextGraphId,
    view: view[layer],
    source,
    ...(layer === 'wm' && callerAgentAddress ? { agentAddress: callerAgentAddress } : {}),
    ...(callerAgentAddress ? { callerAgentAddress } : {}),
  };
}

export function isSemanticMemoryLayer(value: unknown): value is SemanticMemoryLayer {
  return value === 'wm' || value === 'swm' || value === 'vm';
}

function validateSemanticMemoryLayer(value: unknown, field: string): asserts value is SemanticMemoryLayer {
  if (!isSemanticMemoryLayer(value)) {
    throw new SemanticProgramError(
      'INVALID_MEMORY_LAYER',
      `${field} must be one of wm, swm, or vm`,
      400,
    );
  }
}

function semanticLayerLabel(layer: SemanticMemoryLayer): string {
  if (layer === 'wm') return 'Working Memory';
  if (layer === 'swm') return 'Shared Working Memory';
  return 'Verifiable Memory';
}

function historyLayerLabel(
  history: NonNullable<Awaited<ReturnType<DKGAgent['assertion']['history']>>>,
): string {
  if (history.memoryLayer === 'WM') return 'Working Memory';
  if (history.memoryLayer === 'SWM') return 'Shared Working Memory';
  if (history.memoryLayer === 'VM') return 'Verifiable Memory';
  return 'an unfinished lifecycle state';
}

function historyIsAtLayer(
  history: NonNullable<Awaited<ReturnType<DKGAgent['assertion']['history']>>>,
  layer: SemanticMemoryLayer,
): boolean {
  return history.memoryLayer === ({ wm: 'WM', swm: 'SWM', vm: 'VM' } as const)[layer]
    && (layer !== 'vm' || Boolean(history.publishedUal));
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== 'object' || result === null || !('bindings' in result)) return [];
  const rows = (result as { bindings?: unknown }).bindings;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
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
