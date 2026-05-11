import { createHash } from 'node:crypto';
import { DKG_ONTOLOGY, sparqlString } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface PublishCclPolicyInput {
  contextGraphId: string;
  name: string;
  version: string;
  content: string;
  description?: string;
  contextType?: string;
  language?: string;
  format?: string;
}

export interface CclPolicyRecord {
  policyUri: string;
  contextGraphId: string;
  name: string;
  version: string;
  hash: string;
  language: string;
  format: string;
  status: string;
  creator?: string;
  createdAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  description?: string;
  contextType?: string;
  body?: string;
  isActiveDefault: boolean;
  activeContexts: string[];
}

export interface PolicyApprovalBinding {
  bindingUri: string;
  policyUri: string;
  contextGraphId: string;
  name: string;
  contextType?: string;
  status: 'approved' | 'revoked' | 'superseded';
  approvedAt: string;
  approvedBy?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export function hashCclPolicy(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function policyUriFor(contextGraphId: string, hash: string): string {
  return `did:dkg:policy:${encodeSegment(contextGraphId)}:${hash.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

export function policyBindingUriFor(contextGraphId: string, name: string, contextType?: string): string {
  const suffix = contextType ? `${encodeSegment(name)}:${encodeSegment(contextType)}` : `${encodeSegment(name)}:default`;
  return `did:dkg:policy-binding:${encodeSegment(contextGraphId)}:${suffix}:${Date.now()}`;
}

export function buildCclPolicyQuads(input: PublishCclPolicyInput, creator: string, graph: string, createdAt: string): {
  policyUri: string;
  hash: string;
  quads: Quad[];
} {
  const hash = hashCclPolicy(input.content);
  const policyUri = policyUriFor(input.contextGraphId, hash);
  const contextGraphUri = `did:dkg:context-graph:${input.contextGraphId}`;
  const quads: Quad[] = [
    { subject: policyUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CCL_POLICY, graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH, object: contextGraphUri, graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: sparqlString(input.name), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_VERSION, object: sparqlString(input.version), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_LANGUAGE, object: sparqlString(input.language ?? 'ccl/v0.1'), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_FORMAT, object: sparqlString(input.format ?? 'canonical-yaml'), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_HASH, object: sparqlString(hash), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_BODY, object: sparqlString(input.content), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('proposed'), graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creator, graph },
    { subject: policyUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: sparqlString(createdAt), graph },
  ];

  if (input.description) {
    quads.push({
      subject: policyUri,
      predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
      object: sparqlString(input.description),
      graph,
    });
  }

  if (input.contextType) {
    quads.push({
      subject: policyUri,
      predicate: DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE,
      object: sparqlString(input.contextType),
      graph,
    });
  }

  return { policyUri, hash, quads };
}

export function buildPolicyApprovalQuads(opts: {
  contextGraphId: string;
  policyUri: string;
  policyName: string;
  creator: string;
  graph: string;
  approvedAt: string;
  contextType?: string;
}): { bindingUri: string; quads: Quad[] } {
  const bindingUri = policyBindingUriFor(opts.contextGraphId, opts.policyName, opts.contextType);
  const contextGraphUri = `did:dkg:context-graph:${opts.contextGraphId}`;
  const quads: Quad[] = [
    { subject: bindingUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_POLICY_BINDING, graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH, object: contextGraphUri, graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: sparqlString(opts.policyName), graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_ACTIVE_POLICY, object: opts.policyUri, graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS, object: sparqlString('approved'), graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: opts.creator, graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(opts.approvedAt), graph: opts.graph },
    { subject: bindingUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: sparqlString(opts.approvedAt), graph: opts.graph },
  ];

  if (opts.contextType) {
    quads.push({
      subject: bindingUri,
      predicate: DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE,
      object: sparqlString(opts.contextType),
      graph: opts.graph,
    });
  }

  return { bindingUri, quads };
}

export function buildPolicyRevocationQuads(opts: {
  bindingUri: string;
  revoker: string;
  graph: string;
  revokedAt: string;
  contextGraphUri: string;
}): Quad[] {
  return [
    { subject: opts.bindingUri, predicate: DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS, object: sparqlString('revoked'), graph: opts.graph },
    { subject: opts.bindingUri, predicate: DKG_ONTOLOGY.DKG_REVOKED_BY, object: opts.revoker, graph: opts.graph },
    { subject: opts.bindingUri, predicate: DKG_ONTOLOGY.DKG_REVOKED_AT, object: sparqlString(opts.revokedAt), graph: opts.graph },
    { subject: opts.bindingUri, predicate: DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH, object: opts.contextGraphUri, graph: opts.graph },
  ];
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}
