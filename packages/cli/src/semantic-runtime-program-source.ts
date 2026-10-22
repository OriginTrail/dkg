import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { SemanticMemoryLayer, SemanticProgramError, SemanticProgramForkResult, StoredSemanticProgram } from './semantic-runtime-types.js';
import { PROV, RDFS, RDF_TYPE, SR, hashParts, historyIsAtLayer, historyLayerLabel, iriQuad, iriValue, literalQuad, literalValue, programGraphAuthor, queryOptions, resultRows, semanticLayerLabel, validateGraphAndProgram, validateSemanticMemoryLayer } from './semantic-runtime-values.js';
import { parseRequestedPermissions } from './semantic-runtime-typescript-execution.js';
import { persistProgramKnowledgeAsset } from './semantic-runtime-execution-persistence.js';

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
