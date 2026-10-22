import { buildExecutionOutputQuads, decodeExecutionOutputRows, ExecutionOutputCodecError, type ExecutionOutputRow } from './semantic-runtime-execution-output.js';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { BoundProgramInvocation, PersistenceEvidence, SemanticMemoryLayer, SemanticProgramError, SemanticToolResolution } from './semantic-runtime-types.js';
import { PROV, RDF_TYPE, SR, XSD_DATE_TIME, historyIsAtLayer, historyLayerLabel, iriQuad, iriValue, literalQuad, literalValue, programGraphAuthor, queryOptions, resultRows, toHex, typedLiteralQuad } from './semantic-runtime-values.js';

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
): Promise<PersistenceEvidence> {
  return persistKnowledgeAsset(agent, contextGraphId, name, operatorAddress, quads, initialHistory, targetLayer, {
    layerConflict: 'EXECUTION_LAYER_CONFLICT',
    shareFailed: 'EXECUTION_SHARE_FAILED',
    publishFailed: 'EXECUTION_PUBLISH_FAILED',
    subject: 'Execution Knowledge Asset',
  });
}

export async function persistProgramKnowledgeAsset(
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

export async function persistKnowledgeAsset(
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
