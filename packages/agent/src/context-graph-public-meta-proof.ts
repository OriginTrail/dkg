// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';

type PublicMetaObjectRequirement =
  | { kind: 'iri'; value: string }
  | { kind: 'normalized-literal'; value: string };

interface PublicMetaRequirement {
  predicate: string;
  variable: string;
  object: PublicMetaObjectRequirement;
}

/**
 * Canonical facts that prove a root metadata snapshot explicitly declares a
 * public Context Graph. Snapshot evaluation and store-side ASK queries are
 * rendered from the same model so public authority cannot drift between sync
 * admission paths.
 */
const PUBLIC_ACCESS_POLICY_REQUIREMENT: PublicMetaRequirement = {
  predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
  variable: 'accessPolicy',
  object: { kind: 'normalized-literal', value: 'public' },
};

const AUTHORITATIVE_PUBLIC_META_REQUIREMENTS: readonly PublicMetaRequirement[] = [
  {
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    variable: 'contextGraphType',
    object: { kind: 'iri', value: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH },
  },
  PUBLIC_ACCESS_POLICY_REQUIREMENT,
];

/**
 * Materialize the canonical root `_meta` facts required to prove that a
 * Context Graph is publicly readable.
 *
 * Keep writers on the same requirement model as snapshot and store-side
 * validators. Public graph definitions remain in ONTOLOGY for discovery, but
 * these two facts are duplicated into the graph's own `_meta` partition so a
 * late subscriber can authenticate the control snapshot before admitting SWM
 * data.
 */
export function buildAuthoritativePublicMetaQuads(contextGraphId: string): Quad[] {
  const graph = contextGraphMetaGraphUri(contextGraphId);
  const subject = contextGraphDataGraphUri(contextGraphId);
  return AUTHORITATIVE_PUBLIC_META_REQUIREMENTS.map((requirement) => ({
    subject,
    predicate: requirement.predicate,
    object: requirement.object.kind === 'iri'
      ? requirement.object.value
      : `"${requirement.object.value}"`,
    graph,
  }));
}

export interface AuthoritativePublicMetaInspection {
  missing: Quad[];
  conflictingPolicy: boolean;
}

function matchesRequirementObject(
  value: string,
  requirement: PublicMetaObjectRequirement,
): boolean {
  switch (requirement.kind) {
    case 'iri':
      return value === requirement.value;
    case 'normalized-literal':
      return value.startsWith('"')
        && stripLiteral(value).trim().toLowerCase() === requirement.value;
  }
}

/** Classify a fetched root `_meta` snapshot using the canonical public-proof model. */
export function inspectAuthoritativePublicMetaDefinition(
  contextGraphId: string,
  quads: readonly Quad[],
): AuthoritativePublicMetaInspection {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const projection = quads.filter((quad) => (
    quad.graph === metaGraph && quad.subject === contextGraphUri
  ));
  const missing = buildAuthoritativePublicMetaQuads(contextGraphId).filter((canonicalQuad) => {
    const requirement = AUTHORITATIVE_PUBLIC_META_REQUIREMENTS.find(
      (candidate) => candidate.predicate === canonicalQuad.predicate,
    );
    return !requirement || !projection.some((quad) => (
      quad.predicate === requirement.predicate
      && matchesRequirementObject(quad.object, requirement.object)
    ));
  });
  const conflictingPolicy = projection.some((quad) => (
    quad.predicate === PUBLIC_ACCESS_POLICY_REQUIREMENT.predicate
    && !matchesRequirementObject(quad.object, PUBLIC_ACCESS_POLICY_REQUIREMENT.object)
  ));
  return { missing, conflictingPolicy };
}

/** Evaluate a fetched root `_meta` snapshot against the canonical public proof. */
export function hasAuthoritativePublicMetaDefinition(
  contextGraphId: string,
  quads: readonly Quad[],
): boolean {
  const inspection = inspectAuthoritativePublicMetaDefinition(contextGraphId, quads);
  return inspection.missing.length === 0 && !inspection.conflictingPolicy;
}

function renderRequirement(
  contextGraphUri: string,
  requirement: PublicMetaRequirement,
): string {
  const subject = `<${assertSafeIri(contextGraphUri)}>`;
  const predicate = `<${assertSafeIri(requirement.predicate)}>`;
  if (requirement.object.kind === 'iri') {
    return `${subject} ${predicate} <${assertSafeIri(requirement.object.value)}> .`;
  }
  const variable = `?${requirement.variable}`;
  return `${subject} ${predicate} ${variable} .\n` +
    `      FILTER(isLiteral(${variable}) && LCASE(REPLACE(STR(${variable}), "^\\\\s+|\\\\s+$", "")) = ${sparqlString(requirement.object.value)})`;
}

/** Build the store-side ASK query from the canonical public proof model. */
export function buildAuthoritativePublicMetaAskQuery(contextGraphId: string): string {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const requirements = AUTHORITATIVE_PUBLIC_META_REQUIREMENTS
    .map((requirement) => `      ${renderRequirement(contextGraphUri, requirement)}`)
    .join('\n');
  const accessPolicyPredicate = assertSafeIri(PUBLIC_ACCESS_POLICY_REQUIREMENT.predicate);
  const publicPolicy = PUBLIC_ACCESS_POLICY_REQUIREMENT.object;
  if (publicPolicy.kind !== 'normalized-literal') {
    throw new Error('Public access policy proof must use a normalized literal');
  }
  return `ASK WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> {
${requirements}
      FILTER NOT EXISTS {
        <${assertSafeIri(contextGraphUri)}> <${accessPolicyPredicate}> ?conflictingAccessPolicy .
        FILTER(
          !isLiteral(?conflictingAccessPolicy) ||
          LCASE(REPLACE(STR(?conflictingAccessPolicy), "^\\\\s+|\\\\s+$", "")) != ${sparqlString(publicPolicy.value)}
        )
      }
    }
  }`;
}

/**
 * Build an atomic repair that inserts the canonical proof only while no
 * contradictory access policy exists in the target root `_meta` graph.
 */
export function buildAuthoritativePublicMetaRepairUpdate(contextGraphId: string): string {
  const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
  const contextGraphUri = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const requiredFacts = AUTHORITATIVE_PUBLIC_META_REQUIREMENTS
    .map((requirement) => {
      const predicate = `<${assertSafeIri(requirement.predicate)}>`;
      const object = requirement.object.kind === 'iri'
        ? `<${assertSafeIri(requirement.object.value)}>`
        : sparqlString(requirement.object.value);
      return `      <${contextGraphUri}> ${predicate} ${object} .`;
    })
    .join('\n');
  const accessPolicyPredicate = assertSafeIri(PUBLIC_ACCESS_POLICY_REQUIREMENT.predicate);
  const publicPolicy = PUBLIC_ACCESS_POLICY_REQUIREMENT.object;
  if (publicPolicy.kind !== 'normalized-literal') {
    throw new Error('Public access policy proof must use a normalized literal');
  }
  return `INSERT {
    GRAPH <${metaGraph}> {
${requiredFacts}
    }
  }
  WHERE {
    FILTER NOT EXISTS {
      GRAPH <${metaGraph}> {
        <${contextGraphUri}> <${accessPolicyPredicate}> ?conflictingAccessPolicy .
        FILTER(
          !isLiteral(?conflictingAccessPolicy) ||
          LCASE(REPLACE(STR(?conflictingAccessPolicy), "^\\\\s+|\\\\s+$", "")) != ${sparqlString(publicPolicy.value)}
        )
      }
    }
  }`;
}
