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

/** Evaluate a fetched root `_meta` snapshot against the canonical public proof. */
export function hasAuthoritativePublicMetaDefinition(
  contextGraphId: string,
  quads: readonly Quad[],
): boolean {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const hasRequiredFacts = AUTHORITATIVE_PUBLIC_META_REQUIREMENTS.every((requirement) => quads.some((quad) => (
    quad.graph === metaGraph
      && quad.subject === contextGraphUri
      && quad.predicate === requirement.predicate
      && matchesRequirementObject(quad.object, requirement.object)
  )));
  const hasConflictingPolicy = quads.some((quad) => (
    quad.graph === metaGraph
      && quad.subject === contextGraphUri
      && quad.predicate === PUBLIC_ACCESS_POLICY_REQUIREMENT.predicate
      && !matchesRequirementObject(quad.object, PUBLIC_ACCESS_POLICY_REQUIREMENT.object)
  ));
  return hasRequiredFacts && !hasConflictingPolicy;
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
