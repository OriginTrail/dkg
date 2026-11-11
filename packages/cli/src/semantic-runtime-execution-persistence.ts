import { buildExecutionOutputQuads, decodeExecutionOutputRows, ExecutionOutputCodecError, type ExecutionOutputRow } from './semantic-runtime-execution-output.js';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ExecutionReceiptJournal } from '@origintrail-official/dkg-semantic-runtime';
import { persistKnowledgeAsset } from './semantic-runtime-receipt-lifecycle.js';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { BoundProgramInvocation, PersistenceEvidence, SemanticMemoryLayer, SemanticProgramError, SemanticToolResolution } from './semantic-runtime-types.js';
import { PROV, RDF_TYPE, SR, XSD_DATE_TIME, iriQuad, iriValue, literalQuad, literalValue, programGraphAuthor, queryOptions, resultRows, toHex, typedLiteralQuad } from './semantic-runtime-values.js';

export async function loadExecutionOutputs(
  agent: DKGAgent,
  contextGraphId: string,
  executionIri: string,
  executionLayer: SemanticMemoryLayer,
  operatorAddress: string,
): Promise<string[]> {
  const result = await agent.query(`
    SELECT ?g ?output ?orderedOutputs ?outputHash ?orderedOutputsEncoding ?orderedOutputsByteLength ?orderedOutputsSha256 ?orderedOutputsChunkCount ?orderedOutputsChunk WHERE {
      GRAPH ?g {
        { ${sparqlIri(executionIri)} <${SR}orderedOutputs> ?orderedOutputs }
        UNION { ${sparqlIri(executionIri)} <${SR}output> ?output }
        UNION { ${sparqlIri(executionIri)} <${SR}outputHash> ?outputHash }
        UNION { ${sparqlIri(executionIri)} <${SR}orderedOutputsEncoding> ?orderedOutputsEncoding }
        UNION { ${sparqlIri(executionIri)} <${SR}orderedOutputsByteLength> ?orderedOutputsByteLength }
        UNION { ${sparqlIri(executionIri)} <${SR}orderedOutputsSha256> ?orderedOutputsSha256 }
        UNION { ${sparqlIri(executionIri)} <${SR}orderedOutputsChunkCount> ?orderedOutputsChunkCount }
        UNION { ${sparqlIri(executionIri)} <${SR}orderedOutputsChunk> ?orderedOutputsChunk }
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
  try {
    return decodeExecutionOutputRows(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, key === 'g' ? iriValue(value) : literalValue(value)])) as unknown as ExecutionOutputRow));
  } catch (error) {
    if (error instanceof ExecutionOutputCodecError) throw new SemanticProgramError(error.code, 'Execution output receipt is invalid or incomplete', 409);
    throw error;
  }
}

export function buildExecutionQuads(input: {
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
  quads.push(...buildExecutionOutputQuads(input.executionIri, input.outputs.map(output => output.value)));
  return quads;
}

export async function persistExecutionKnowledgeAsset(
  agent: DKGAgent,
  contextGraphId: string,
  name: string,
  operatorAddress: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>,
  targetLayer: SemanticMemoryLayer,
  assertAuthorized: () => Promise<void>,
  journal?: ExecutionReceiptJournal,
): Promise<PersistenceEvidence> {
  return persistKnowledgeAsset(agent, contextGraphId, name, operatorAddress, quads, initialHistory, targetLayer, {
    layerConflict: 'EXECUTION_LAYER_CONFLICT',
    shareFailed: 'EXECUTION_SHARE_FAILED',
    publishFailed: 'EXECUTION_PUBLISH_FAILED',
    subject: 'Execution Knowledge Asset',
  }, assertAuthorized, journal);
}

export async function persistProgramKnowledgeAsset(
  agent: DKGAgent,
  contextGraphId: string,
  name: string,
  authorAgentAddress: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
  initialHistory: Awaited<ReturnType<DKGAgent['assertion']['history']>>,
  targetLayer: SemanticMemoryLayer,
  assertAuthorized: () => Promise<void>,
  journal?: ExecutionReceiptJournal,
): Promise<PersistenceEvidence> {
  return persistKnowledgeAsset(agent, contextGraphId, name, authorAgentAddress, quads, initialHistory, targetLayer, {
    layerConflict: 'PROGRAM_FORK_LAYER_CONFLICT',
    shareFailed: 'PROGRAM_FORK_SHARE_FAILED',
    publishFailed: 'PROGRAM_FORK_PUBLISH_FAILED',
    subject: 'Forked Program',
  }, assertAuthorized, journal);
}

