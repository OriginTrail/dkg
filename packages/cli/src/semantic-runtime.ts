import { programToolDefinition } from './semantic-runtime-tool-catalog.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  canonicalizeJson,
  type CanonicalJsonValue,
  sparqlIri,
  validateContextGraphId,
} from '@origintrail-official/dkg-core';
import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import type { LlmConfig } from '@origintrail-official/dkg-node-ui';
import { ethers } from 'ethers';
import {
  ComponentWorkerClient,
  TypeScriptProgramHost,
  defaultExecutionCapability,
  RuntimeAdapterRegistry,
  RuntimeEffectBroker,
  SemanticRuntimeStore,
  RUNTIME_DATABASE_FILENAME,
  WasmStrategyAdmissionClient,
  admittedPlanAuthority,
  hashCanonicalPlan,
  encodeCapabilityMetadata,
  startSemanticRuntimeHost,
  type AdmittedPlanSummary,
  type ComponentToolDispatcher,
  type SemanticRuntimeConfig,
  type SemanticProgramBinding,
  type SemanticRuntimeHost,
  type SemanticRuntimeHostOptions,
  type ExecutionCapabilityDescriptor,
} from '@origintrail-official/dkg-semantic-runtime';

import { SemanticProgramConfiguration } from './semantic-runtime-configuration.js';
import { canonicalProgramInputs } from './semantic-runtime-bound-invocation.js';
import { createAssetCreationAdapter } from './semantic-runtime-asset-adapter.js';
import { createInvestigatorAdapter } from './semantic-runtime-investigator-adapter.js';
import { assertSparqlReadOutput, createSparqlReadAdapter } from './semantic-runtime-sparql-adapter.js';
import { createDkgQueryAdapter, findSavedQuery } from './semantic-runtime-query-adapter.js';
import { readContextGraphQueryCatalogBindings } from './daemon/query-catalog-service.js';
import { programBindingDigest, validateProgramBindings, validateProgramConfiguration } from './semantic-runtime-program-bindings.js';
import { assertSemanticQueryDefinition, assertSemanticQueryOutput } from './semantic-runtime-query-pins.js';
import { validateSemanticProgramPolicy } from './semantic-runtime-program-policy.js';
import { createRemoteExecuteAdapter } from './semantic-runtime-remote-execute-adapter.js';
import {
  createSafeLlmAdapter,
  type SafeLlmProgram,
} from './semantic-runtime-safe-llm-adapter.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV = 'http://www.w3.org/ns/prov#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
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
  requestedPermissions?: Record<string, unknown>;
  permittedPrograms: string[];
  label?: string;
  description?: string;
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
  outputs?: string[];
  persisted: true;
}

export type SemanticProgramChildInvoker = (input: {
  contextGraphId: string;
  programIri: string;
  invocationId: string;
  programLayer: SemanticMemoryLayer;
  executionLayer: SemanticMemoryLayer;
  callerAgentAddress: string;
}) => Promise<SemanticInvocationResult>;

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
  configuration: SemanticProgramConfiguration;
  typescript?: TypeScriptProgramHost;
  inFlight: Map<string, {
    requestIdentity: string;
    promise: Promise<SemanticInvocationResult>;
  }>;
  stop(): Promise<void>;
}

export interface ConfiguredSemanticRuntimeDeps {
  log: (message: string) => void;
  dataDirectory?: string;
  start?: (options: SemanticRuntimeHostOptions) => Promise<SemanticRuntimeHost>;
  openStore?: () => SemanticRuntimeStore;
  /** Only a management request already authenticated as owner/operator may opt in. */
  activate?: boolean;
}

export async function startConfiguredSemanticRuntime(
  config: SemanticRuntimeConfig | undefined,
  deps: ConfiguredSemanticRuntimeDeps,
): Promise<ConfiguredSemanticRuntimeService | null> {
  if (!config || config.enabled === false) return null;
  const previouslyEnabled = config.enabled;
  const fileBindings = config.programBindings;
  const fileRoutes = config.programRoutes;
  if (config.enabled !== true && !deps.activate
    && !(deps.dataDirectory && existsSync(join(deps.dataDirectory, RUNTIME_DATABASE_FILENAME)))) return null;
  // Validate service settings now; the configuration manager validates authority
  // after durable overrides/tombstones have been merged with file defaults.
  validateSemanticRuntimeSettings(config);
  const store = deps.openStore?.()
    ?? (deps.dataDirectory ? SemanticRuntimeStore.openInDataDirectory(deps.dataDirectory) : new SemanticRuntimeStore(':memory:'));
  let host: SemanticRuntimeHost;
  let configuration: SemanticProgramConfiguration;
  try {
    if (config.enabled !== true && !deps.activate && store.programConfigurationRecords().length === 0) { store.close(); return null; }
    configuration = new SemanticProgramConfiguration(store, config);
    config.enabled = true;
    host = await (deps.start ?? startSemanticRuntimeHost)({ config, log: deps.log });
  } catch (error) {
    config.enabled = previouslyEnabled;
    config.programBindings = fileBindings;
    config.programRoutes = fileRoutes;
    store.close();
    throw error;
  }
  deps.log(
    `Semantic runtime ready (watchdog=${config.watchdogMs ?? 100}ms, `
      + 'Wasm execution + durable effect journal enabled)',
  );
  const typescript = new TypeScriptProgramHost();
  const inFlight: ConfiguredSemanticRuntimeService['inFlight'] = new Map();
  return {
    host,
    store,
    configuration,
    typescript,
    inFlight,
    async stop() {
      try {
        await typescript.stop();
        await host.stop();
        await Promise.allSettled([...inFlight.values()].map(invocation => invocation.promise));
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
    SELECT DISTINCT ?g ?language ?version ?source ?tool ?permittedProgram ?label ?description ?requestedPermissions WHERE {
      GRAPH ?g {
        ${safeProgramIri} <${RDF_TYPE}> <${SR}Program> ;
          <${SR}language> ?language ;
          <${SR}version> ?version ;
          <${SR}source> ?source .
        OPTIONAL { ${safeProgramIri} <${SR}requestedToolPermissions> ?requestedPermissions }
        OPTIONAL { ${safeProgramIri} <${SR}requiresTool> ?tool }
        OPTIONAL { ${safeProgramIri} <${SR}permitsProgram> ?permittedProgram }
        OPTIONAL { ${safeProgramIri} <${RDFS}label> ?label }
        OPTIONAL { ${safeProgramIri} <${RDFS}comment> ?description }
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
  const permittedPrograms = new Set<string>();
  const permissions = new Set<string>();
  const labels = new Set<string>();
  const descriptions = new Set<string>();
  for (const { row, authorAgentAddress } of rows) {
    const definition = {
      language: literalValue(row.language),
      version: literalValue(row.version),
      source: literalValue(row.source),
    };
    definitions.set(JSON.stringify(definition), definition);
    authors.add(authorAgentAddress);
    if (row.requestedPermissions !== undefined) permissions.add(literalValue(row.requestedPermissions));
    if (row.tool !== undefined) requiredTools.add(iriValue(row.tool));
    if (row.permittedProgram !== undefined) permittedPrograms.add(iriValue(row.permittedProgram));
    if (row.label !== undefined) labels.add(literalValue(row.label));
    if (row.description !== undefined) descriptions.add(literalValue(row.description));
  }
  if (definitions.size !== 1 || authors.size !== 1 || labels.size > 1 || descriptions.size > 1 || permissions.size > 1) {
    throw new SemanticProgramError(
      'PROGRAM_AMBIGUOUS',
      'Program has multiple definitions or authors',
      409,
    );
  }
  const [definition] = definitions.values();
  if (!['sexpr-v1', 'typescript-v1'].includes(definition.language)) {
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
    ...(permissions.size ? { requestedPermissions: parseRequestedPermissions([...permissions][0]) } : {}),
    permittedPrograms: [...permittedPrograms].sort(),
    ...([...labels][0] ? { label: [...labels][0] } : {}),
    ...([...descriptions][0] ? { description: [...descriptions][0] } : {}),
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
    ...(source.requestedPermissions ? [literalQuad(newProgramIri, `${SR}requestedToolPermissions`, JSON.stringify(source.requestedPermissions))] : []),
    ...source.requiredTools.map((toolIri) =>
      iriQuad(newProgramIri, `${SR}requiresTool`, toolIri)),
    ...source.permittedPrograms.map((permittedProgram) =>
      iriQuad(newProgramIri, `${SR}permitsProgram`, permittedProgram)),
    ...(source.label ? [literalQuad(newProgramIri, `${RDFS}label`, source.label)] : []),
    ...(source.description
      ? [literalQuad(newProgramIri, `${RDFS}comment`, source.description)]
      : []),
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

/** Host-created context; never decoded from an HTTP or inbox payload. */
interface BoundProgramInvocation {
  binding: SemanticProgramBinding;
  digest: string;
  assertAuthorized(): Promise<void>;
}

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
  validateProgramBindings(config.programBindings ?? []);
  const selected = config.programBindings?.find((item) =>
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

async function assertBoundQueryDefinition(agent: DKGAgent, binding: SemanticProgramBinding): Promise<void> {
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

interface TypeScriptComposition {
  ancestors: string[];
  budget: { calls: number; maximum: number; deadline: number; cancelled: boolean; uncertainEffect?: SemanticProgramError };
  assertParent(): Promise<void>;
}

function parseRequestedPermissions(json: string): Record<string, unknown> {
  try {
    if (Buffer.byteLength(json) > 65536) throw new Error();
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    canonicalizeJson(value, { maxBytes: 65536, maxDepth: 20 });
    return value;
  } catch { throw new SemanticProgramError('INVALID_PROGRAM_PERMISSIONS', 'Requested tool permissions must be a JSON object of at most 64 KiB', 422); }
}

/** Compare the stored request to owner-approved scope, excluding server-computed pins. */
function assertRequestedToolPermissions(program: StoredSemanticProgram, binding: SemanticProgramBinding): void {
  const requested = program.requestedPermissions;
  const scope = {
    graphId: binding.contextGraphId, executionLayer: binding.executionLayer ?? 'wm',
    ...(binding.query ? { query: { selector: binding.query.selector, outputSchema: binding.query.outputSchema } } : {}),
    ...(binding.sparqlRead ? { sparqlRead: (({ outputSchemaSha256: _, ...grant }) => grant)(binding.sparqlRead) } : {}),
    ...(binding.assetCreation ? { assetCreation: binding.assetCreation } : {}),
  };
  const tools = new Set(program.requiredTools);
  const expectedCount = Number(!!binding.query) + Number(!!binding.sparqlRead) + Number(!!binding.assetCreation);
  if (!sameSet(tools, new Set(binding.typescript?.requiredTools ?? []))
    || tools.size !== expectedCount
    || binding.sparqlRead && !tools.has(binding.sparqlRead.toolIri)
    || binding.assetCreation && !tools.has(binding.assetCreation.toolIri)
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

async function resolveTypeScriptTools(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
  binding: SemanticProgramBinding, program: StoredSemanticProgram, config: SemanticRuntimeConfig, check: () => Promise<void>) {
  const digest = programBindingDigest(binding);
  const resolved = await resolveProgramTools(agent, binding.contextGraphId, program, config, undefined,
    binding.executorAgentAddress, binding.executorAgentAddress, binding.executionLayer ?? 'wm', undefined, check,
    { binding, digest, assertAuthorized: check }, runtime.store);
  if (resolved.tools.some(tool => !tool.effective)) throw new SemanticProgramError('REQUIRED_TOOL_UNAVAILABLE', 'A requested adapter is unavailable', 409);
  return { registry: resolved.registry, policyHashHex: resolved.policyHashHex,
    public: { contextGraphId: binding.contextGraphId, programIri: program.programIri, programLayer: program.layer,
      executingNode: resolved.operatorIri,
      selectedPolicy: { iri: resolved.policyIri, version: resolved.policyVersion, hash: `sha256:${resolved.policyHashHex}` },
      requiredTools: resolved.tools, previousExecutions: [], executable: true } };
}

async function validateTypeScriptProgram(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
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

async function invokeTypeScriptProgram(agent: DKGAgent, runtime: ConfiguredSemanticRuntimeService,
  binding: SemanticProgramBinding, digest: string, invocationId: string, config: SemanticRuntimeConfig,
  caller: string, inputs: unknown[], authorized: () => Promise<void>, parent?: TypeScriptComposition): Promise<SemanticInvocationResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId))
    throw new SemanticProgramError('INVALID_INVOCATION_ID', 'invocationId must be a UUID', 400);
  invocationId = invocationId.toLowerCase();
  const grant = binding.typescript!, graph = binding.contextGraphId;
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
    if (previous) {
      if (previous.graphRevision !== identity) throw new SemanticProgramError('INVOCATION_LAYER_CONFLICT', 'Invocation already has different inputs or authority', 409);
      if (previous.status !== 'completed') {
        // JavaScript continuations are not durable. Never replay partially run
        // workflows and accidentally repeat an external effect after a crash.
        if (previous.status === 'active') runtime.store.setExecutionStatus(executionIri, 'failed');
        throw new SemanticProgramError('INVOCATION_NOT_RETRYABLE', 'Interrupted or failed TypeScript execution requires a new invocation ID', 409);
      }
      if (!history || !historyIsAtLayer(history, layer)) throw new SemanticProgramError('EXECUTION_PERSISTENCE_INCONSISTENT', 'Completed receipt is missing', 500);
      const outputs = await loadExecutionOutputs(agent, graph, executionIri, layer, executor.agentAddress);
      await check();
      return { invocationId, executionIri, executionLayer: layer, ...(layer === 'vm' ? { executionUal: history.publishedUal } : {}), outputs, persisted: true };
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
    try {
      const output = await runtime.typescript!.execute(artifact, inputJson,
        { ...grant, timeoutMs: Math.max(1, Math.min(grant.timeoutMs, budget.deadline - Date.now())) }, async effect => {
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
          childExecutions.push(result.executionIri);
          const values = (result.outputs ?? []).map(value => { try { return JSON.parse(value); } catch { return value; } });
          return values.length === 1 ? values[0] : values;
        });
      await check();
      const quads = buildExecutionQuads({ bound: { binding, digest, assertAuthorized: check }, executionIri, invocationId,
        programIri: program.programIri, operatorIri: `did:dkg:agent:${executor.agentAddress}`, callerIri: `did:dkg:agent:${caller}`,
        policy: { iri: `urn:dkg:program-binding:${digest}`, version: '1', hash: digest }, programHash: artifact.hash,
        tools: resolved.public.requiredTools, events: [], agents: [], outputs: [{ role: 'result', processId: new Uint8Array(), value: output }],
        childExecutions, startedAt, finishedAt: new Date() });
      quads.push(literalQuad(executionIri, `${SR}inputHash`, createHash('sha256').update(inputJson).digest('hex')));
      const persistence = await persistExecutionKnowledgeAsset(agent, graph, name, executor.agentAddress, quads, history, layer);
      await check();
      runtime.store.setExecutionStatus(executionIri, 'completed');
      return { invocationId, executionIri, executionLayer: layer, ...(persistence.ual ? { executionUal: persistence.ual } : {}), outputs: [output], persisted: true };
    } catch (error) {
      runtime.store.setExecutionStatus(executionIri, 'failed');
      if (error instanceof SemanticProgramError) throw error;
      if (budget.uncertainEffect) throw budget.uncertainEffect;
      throw new SemanticProgramError('TYPESCRIPT_EXECUTION_FAILED', safeMessage(error), 422);
    }
  };
  const promise = work();
  runtime.inFlight.set(key, { requestIdentity: identity, promise });
  try { return await promise; }
  finally { runtime.inFlight.delete(key); if (!parent) budget.cancelled = true; }
}

interface LocalInvocationScope {
  ancestors: string[];
  assertAncestors?: () => Promise<void>;
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

interface InternalResolution {
  public: SemanticProgramResolution;
  program: StoredSemanticProgram;
  plan: AdmittedPlanSummary;
  registry: RuntimeAdapterRegistry;
  operatorAddress: string;
  policyHashHex: string;
}

async function resolveProgramTools(
  agent: DKGAgent, contextGraphId: string, program: StoredSemanticProgram,
  config: SemanticRuntimeConfig | undefined, llmConfig: LlmConfig | undefined,
  callerAgentAddress: string | undefined, executingAgentAddress: string | undefined,
  executionLayer: SemanticMemoryLayer, childInvoker: SemanticProgramChildInvoker | undefined,
  assertAuthorized: (() => Promise<void>) | undefined, bound: BoundProgramInvocation | undefined,
  assetStore: SemanticRuntimeStore | undefined,
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
        ? 'assetCreation' : toolIri === bound.binding.sparqlRead?.toolIri ? 'sparqlRead' : 'query');
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

async function resolveInternal(
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

/** Both language front ends use this broker, capability and durable write journal. */
function createProgramToolDispatcher(
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
        oneShot: !readOnly && !authority.adapterVersions.has('dkg/asset-create'),
        budgetMicros: 0n,
      }),
      hostBindingKey: resolved.public.requiredTools[0]?.adapterHash ?? 'no-adapter',
      policyEpoch: 1n,
      notBefore: now - 1_000,
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      oneShot: !readOnly && !authority.adapterVersions.has('dkg/asset-create'),
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
  const resolved = await resolveInternal(
    agent,
    contextGraphId,
    programIri,
    programLayer,
    config,
    llmConfig,
    callerAgentAddress,
    executingAgentAddress,
    executionLayer,
    config?.programPolicy ? pinnedChildInvoker : childInvoker,
    assertAuthorized,
    bound,
    runtime.store,
  );
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
  await bound?.assertAuthorized();
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
    outputs: execution.outputs.map((output) => output.value),
    persisted: true,
  };
}

async function loadExecutionOutputs(
  agent: DKGAgent,
  contextGraphId: string,
  executionIri: string,
  executionLayer: SemanticMemoryLayer,
  operatorAddress: string,
): Promise<string[]> {
  const result = await agent.query(`
    SELECT ?g ?output ?orderedOutputs WHERE {
      GRAPH ?g {
        { ${sparqlIri(executionIri)} <${SR}orderedOutputs> ?orderedOutputs }
        UNION { ${sparqlIri(executionIri)} <${SR}output> ?output }
      }
    }
  `, queryOptions(
    contextGraphId,
    executionLayer,
    'semantic-runtime-execution-output-load',
    operatorAddress,
  ));
  const rows = resultRows(result)
    .filter((row) => programGraphAuthor(row.g, contextGraphId, executionLayer)
      ?.toLowerCase() === operatorAddress.toLowerCase());
  const ordered = new Set(rows.filter((row) => row.orderedOutputs !== undefined)
    .map((row) => literalValue(row.orderedOutputs)));
  const legacy = new Set(rows.filter((row) => row.output !== undefined).map((row) => literalValue(row.output)));
  if (ordered.size > 1) {
    throw new SemanticProgramError('EXECUTION_OUTPUT_ORDER_INVALID', 'Execution has conflicting ordered output records', 409);
  }
  if (ordered.size === 1) {
    let outputs: unknown;
    try { outputs = JSON.parse([...ordered][0]); } catch { /* Validate below without exposing stored content. */ }
    if (!Array.isArray(outputs) || outputs.some((output) => typeof output !== 'string')) {
      throw new SemanticProgramError('EXECUTION_OUTPUT_ORDER_INVALID', 'Execution ordered outputs are malformed', 409);
    }
    const values = new Set(outputs as string[]);
    if (values.size !== legacy.size || [...values].some((output) => !legacy.has(output))) {
      throw new SemanticProgramError('EXECUTION_OUTPUT_ORDER_INVALID', 'Execution ordered outputs disagree with stored outputs', 409);
    }
    return outputs as string[];
  }
  // RDF values have no sequence and collapse duplicates. Old single-output
  // records remain usable; multiple distinct values cannot prove index-based
  // release authority and must never be reordered heuristically.
  if (legacy.size > 1) {
    throw new SemanticProgramError('EXECUTION_OUTPUT_ORDER_UNAVAILABLE', 'Legacy Execution outputs have no recoverable order', 409);
  }
  return [...legacy];
}

function buildExecutionQuads(input: {
  bound?: BoundProgramInvocation;
  executionIri: string;
  invocationId: string;
  programIri: string;
  operatorIri: string;
  callerIri: string;
  policy: { iri: string; version: string; hash: string };
  programHash: string;
  tools: SemanticToolResolution[];
  events: Array<{ role: string; processId: Uint8Array; value: string }>;
  outputs: Array<{ role: string; processId: Uint8Array; value: string }>;
  agents: Array<{ role: string; processId: Uint8Array; status: string }>;
  childExecutions: string[];
  startedAt: Date;
  finishedAt: Date;
}) {
  const quads: Array<{ subject: string; predicate: string; object: string }> = [
    iriQuad(input.executionIri, RDF_TYPE, `${SR}Execution`),
    literalQuad(input.executionIri, `${SR}invocationId`, input.invocationId),
    iriQuad(input.executionIri, `${SR}usedProgram`, input.programIri),
    iriQuad(input.executionIri, `${SR}executedBy`, input.operatorIri),
    iriQuad(input.executionIri, `${SR}invokedBy`, input.callerIri),
    iriQuad(input.executionIri, `${SR}appliedPolicy`, input.policy.iri),
    literalQuad(input.executionIri, `${SR}version`, input.policy.version),
    literalQuad(input.executionIri, `${SR}policyHash`, input.policy.hash),
    literalQuad(input.executionIri, `${SR}programHash`, `sha256:${input.programHash}`),
    iriQuad(input.executionIri, `${SR}status`, `${SR}Succeeded`),
    typedLiteralQuad(input.executionIri, `${PROV}startedAtTime`, input.startedAt.toISOString(), XSD_DATE_TIME),
    typedLiteralQuad(input.executionIri, `${PROV}endedAtTime`, input.finishedAt.toISOString(), XSD_DATE_TIME),
  ];
  if (input.bound) {
    quads.push(iriQuad(input.executionIri, `${SR}operation`, input.bound.binding.operationIri));
    quads.push(literalQuad(input.executionIri, `${SR}programContextGraphId`, input.bound.binding.program.contextGraphId));
    quads.push(literalQuad(input.executionIri, `${SR}dataContextGraphId`, input.bound.binding.contextGraphId));
    quads.push(literalQuad(input.executionIri, `${SR}bindingHash`, input.bound.digest));
    quads.push(literalQuad(input.executionIri, `${SR}sourceHash`, input.bound.binding.program.sourceHash));
  }
  for (const tool of input.tools) {
    quads.push(iriQuad(input.executionIri, `${SR}usedTool`, tool.toolIri));
    if (tool.adapterVersion) quads.push(literalQuad(input.executionIri, `${SR}adapterVersion`, tool.adapterVersion));
    if (tool.adapterHash) quads.push(literalQuad(input.executionIri, `${SR}adapterHash`, tool.adapterHash));
  }
  for (const childExecution of input.childExecutions) {
    quads.push(iriQuad(input.executionIri, `${PROV}wasInformedBy`, childExecution));
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
  // RDF values alone do not preserve positions or duplicate outputs.
  quads.push(literalQuad(input.executionIri, `${SR}orderedOutputs`, JSON.stringify(input.outputs.map((output) => output.value))));
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

function sourceHashOf(program: StoredSemanticProgram): string {
  return createHash('sha256').update(program.source, 'utf8').digest('hex');
}

function programPolicyHash(config: SemanticRuntimeConfig | undefined): string {
  return config?.programPolicy ? hashParts([canonicalizeJson(config.programPolicy as unknown as CanonicalJsonValue)]) : '';
}

function validateProgramPin(config: SemanticRuntimeConfig, program: StoredSemanticProgram, expectedSourceHash?: string): void {
  const policy = config.programPolicy!;
  validateSemanticProgramPolicy(policy);
  const pin = policy.programs.find(({ programIri }) => programIri === program.programIri);
  const actualHash = sourceHashOf(program);
  if (!policy.contextGraphIds.includes(program.contextGraphId) || !pin || pin.sourceHash !== actualHash
    || (expectedSourceHash !== undefined && expectedSourceHash !== actualHash)) {
    throw new SemanticProgramError('PROGRAM_NOT_PINNED', 'Program source or graph does not match the operator binding', 403);
  }
}

async function assertProgramInvocationAuthorized(input: {
  agent: DKGAgent;
  runtime: ConfiguredSemanticRuntimeService;
  executionId: string;
  config: SemanticRuntimeConfig;
  contextGraphId: string;
  program: StoredSemanticProgram;
  originalCaller: string;
  operatorAddress: string;
  policyIri: string;
  policyHashHex: string;
}): Promise<void> {
  const { agent, runtime, executionId, config, contextGraphId, program, originalCaller, operatorAddress } = input;
  const assertActiveCapability = () => {
    const execution = runtime.store.execution(executionId);
    const capabilityId = executionId.replace('urn:sr:execution:', 'urn:sr:capability:');
    const capability = runtime.store.capability(capabilityId);
    const now = Date.now();
    if (!execution || execution.status !== 'active' || !capability
      || capability.executionId !== executionId || capability.revokedAt !== null
      || capability.policyEpoch !== execution.policyEpoch
      || now < capability.notBefore || now >= capability.expiresAt) {
      throw new SemanticProgramError('PROGRAM_AUTHORITY_REVOKED', 'Program invocation authority is no longer active', 403);
    }
  };
  assertActiveCapability();
  if (!await agent.canReadContextGraph(contextGraphId, { callerAgentAddress: originalCaller })) {
    throw new SemanticProgramError('PROGRAM_CALLER_ACCESS_DENIED', 'Original caller can no longer read the Context Graph', 403);
  }
  const currentProgram = await loadStoredSemanticProgram(
    agent, contextGraphId, program.programIri, program.layer, originalCaller,
  );
  validateProgramPin(config, currentProgram, sourceHashOf(program));
  if (currentProgram.authorAgentAddress !== program.authorAgentAddress
    || currentProgram.version !== program.version
    || JSON.stringify(currentProgram.requiredTools) !== JSON.stringify(program.requiredTools)
    || JSON.stringify(currentProgram.permittedPrograms) !== JSON.stringify(program.permittedPrograms)) {
    throw new SemanticProgramError('PROGRAM_DECLARATIONS_CHANGED', 'Program declarations changed during Program execution', 403);
  }
  const result = await agent.query(`
    SELECT DISTINCT ?g ?policyVersion ?tool WHERE {
      GRAPH ?g {
        ${sparqlIri(`did:dkg:agent:${operatorAddress}`)} <${SR}usesExecutionPolicy> ${sparqlIri(input.policyIri)} .
        ${sparqlIri(input.policyIri)} <${RDF_TYPE}> <${SR}ExecutionPolicy> ;
          <${SR}version> ?policyVersion ;
          <${SR}allowsTool> ?tool .
      }
    }
  `, queryOptions(contextGraphId, 'vm', 'semantic-runtime-policy-recheck', originalCaller));
  const rows = resultRows(result).filter((row) => isOperatorVmGraph(row.g, contextGraphId, operatorAddress));
  const versions = new Set(rows.map((row) => literalValue(row.policyVersion)));
  const graphs = new Set(rows.map((row) => iriValue(row.g)));
  const tools = [...new Set(rows.map((row) => iriValue(row.tool)))].sort();
  const hash = hashParts([input.policyIri, `did:dkg:agent:${operatorAddress}`, [...versions][0] ?? '', ...tools]);
  if (rows.length === 0 || versions.size !== 1 || graphs.size !== 1 || hash !== input.policyHashHex) {
    throw new SemanticProgramError('PROGRAM_POLICY_CHANGED', 'Operator policy changed during Program execution', 403);
  }
  assertActiveCapability();
}

export function validateSemanticRuntimeConfig(config: SemanticRuntimeConfig): void {
  validateProgramConfiguration(config.programBindings ?? [], config.programRoutes ?? []);
  validateSemanticRuntimeSettings(config);
}

function validateSemanticRuntimeSettings(config: SemanticRuntimeConfig): void {
  if (config.programPolicy !== undefined) validateSemanticProgramPolicy(config.programPolicy);
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

function checksumAgentAddress(value: string, code: string): string {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new SemanticProgramError(code, 'Executing wallet is invalid', 400);
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
