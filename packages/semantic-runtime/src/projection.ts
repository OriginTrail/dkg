import { createHash } from 'node:crypto';

import type { EffectRecord, ExecutionRecord } from './persistence.js';

export const SEMANTIC_RUNTIME_ONTOLOGY = 'https://origintrail.io/semantic-runtime/v1#';
export const PROV_ONTOLOGY = 'http://www.w3.org/ns/prov#';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_UNSIGNED_LONG = 'http://www.w3.org/2001/XMLSchema#unsignedLong';

export interface SemanticProjectionQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface SemanticProjectionSink {
  insert(quads: SemanticProjectionQuad[]): Promise<void>;
}

export interface ExecutionProjectionSummary {
  execution: ExecutionRecord;
  strategyId: string;
  strategyVersion: string;
  traceHash: string;
  affectedResourceRefs: string[];
  evidenceRefs: string[];
}

export class DkgSemanticRuntimeProjector {
  constructor(
    private readonly sink: SemanticProjectionSink,
    private readonly graph: string,
  ) {
    assertIri(graph, 'projection graph');
  }

  async projectExecutionSummary(summary: ExecutionProjectionSummary): Promise<void> {
    assertIri(summary.execution.executionId, 'execution id');
    assertHash(summary.execution.planId, 'plan id');
    assertHash(summary.execution.graphRevision, 'graph revision');
    assertHash(summary.traceHash, 'trace hash');
    const strategy = `urn:sr:strategy:${encodeURIComponent(summary.strategyId)}:${encodeURIComponent(summary.strategyVersion)}`;
    const quads: SemanticProjectionQuad[] = [
      quad(summary.execution.executionId, RDF_TYPE, `${SEMANTIC_RUNTIME_ONTOLOGY}ExecutionSummary`, this.graph),
      quad(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}usesStrategy`, strategy, this.graph),
      literal(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}strategyHash`, `sha256:${summary.execution.planId}`, this.graph),
      literal(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}graphRevision`, `sha256:${summary.execution.graphRevision}`, this.graph),
      typedLiteral(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}policyEpoch`, summary.execution.policyEpoch.toString(), XSD_UNSIGNED_LONG, this.graph),
      quad(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}status`, `${SEMANTIC_RUNTIME_ONTOLOGY}${statusName(summary.execution.status)}`, this.graph),
      literal(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}traceHash`, `sha256:${summary.traceHash}`, this.graph),
    ];
    for (const resource of uniqueIris(summary.affectedResourceRefs)) {
      quads.push(quad(summary.execution.executionId, `${SEMANTIC_RUNTIME_ONTOLOGY}affectedResource`, resource, this.graph));
    }
    for (const evidence of uniqueIris(summary.evidenceRefs)) {
      quads.push(quad(summary.execution.executionId, `${PROV_ONTOLOGY}used`, evidence, this.graph));
    }
    await this.sink.insert(quads);
  }

  async projectEffectSummary(effect: EffectRecord, evidenceRefs: string[]): Promise<void> {
    const effectIri = effect.effectId.startsWith('urn:')
      ? effect.effectId
      : `urn:sr:effect:${createHash('sha256').update(effect.effectId).digest('hex')}`;
    assertIri(effectIri, 'effect id');
    assertIri(effect.executionId, 'execution id');
    assertIri(effect.processId, 'process id');
    const quads: SemanticProjectionQuad[] = [
      quad(effectIri, RDF_TYPE, `${SEMANTIC_RUNTIME_ONTOLOGY}Effect`, this.graph),
      quad(effectIri, `${PROV_ONTOLOGY}wasGeneratedBy`, effect.executionId, this.graph),
      quad(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}proposedBy`, effect.processId, this.graph),
      quad(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}effectState`, `${SEMANTIC_RUNTIME_ONTOLOGY}${stateName(effect.state)}`, this.graph),
      literal(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}adapter`, `${effect.adapterId}@${effect.adapterVersion}`, this.graph),
      literal(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}idempotencyClass`, effect.idempotencyClass, this.graph),
      literal(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}requestDigest`, `sha256:${Buffer.from(effect.requestDigest).toString('hex')}`, this.graph),
      quad(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}capability`, capabilityIri(effect.capabilityId), this.graph),
      quad(effectIri, `${SEMANTIC_RUNTIME_ONTOLOGY}authorization`, authorizationIri(effect.policyDecisionId), this.graph),
    ];
    for (const evidence of uniqueIris(evidenceRefs)) {
      quads.push(quad(effectIri, `${PROV_ONTOLOGY}used`, evidence, this.graph));
    }
    await this.sink.insert(quads);
  }
}

function quad(subject: string, predicate: string, object: string, graph: string): SemanticProjectionQuad {
  assertIri(subject, 'quad subject');
  assertIri(predicate, 'quad predicate');
  assertIri(object, 'quad object');
  return { subject, predicate, object, graph };
}

function literal(subject: string, predicate: string, value: string, graph: string): SemanticProjectionQuad {
  return { subject, predicate, object: JSON.stringify(value), graph };
}

function typedLiteral(
  subject: string,
  predicate: string,
  value: string,
  datatype: string,
  graph: string,
): SemanticProjectionQuad {
  assertIri(datatype, 'literal datatype');
  return { subject, predicate, object: `${JSON.stringify(value)}^^<${datatype}>`, graph };
}

function uniqueIris(values: string[]): string[] {
  return [...new Set(values)].sort().map((value) => {
    assertIri(value, 'projection reference');
    return value;
  });
}

function assertIri(value: string, name: string): void {
  if (!/^(?:https?:\/\/|urn:)[^\s<>"{}|\\^`]+$/.test(value)) {
    throw new Error(`${name} is not a safe absolute IRI`);
  }
}

function assertHash(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256 hex`);
}

function statusName(status: ExecutionRecord['status']): string {
  return `${status[0]?.toUpperCase()}${status.slice(1)}`;
}

function stateName(state: EffectRecord['state']): string {
  return state.split('_').map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join('');
}

function capabilityIri(capabilityId: string): string {
  return `urn:sr:capability:${createHash('sha256').update(capabilityId).digest('hex')}`;
}

function authorizationIri(decisionId: string): string {
  return `urn:sr:authorization:${createHash('sha256').update(decisionId).digest('hex')}`;
}
