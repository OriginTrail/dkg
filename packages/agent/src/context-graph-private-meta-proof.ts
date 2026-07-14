// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  isSafeIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';

type PrivateMetaObjectRequirement =
  | { kind: 'iri'; value: string }
  | { kind: 'normalized-literal'; value: string }
  | { kind: 'iri-prefix'; prefix: string };

interface PrivateMetaRequirement {
  predicate: string;
  variable: string;
  object: PrivateMetaObjectRequirement;
}

/**
 * The single authoritative definition of the facts that prove a private
 * context graph's root metadata is complete enough to trust. Both the
 * in-memory snapshot validator and the store ASK query are rendered from this
 * model so the two security boundaries cannot drift independently.
 */
const AUTHORITATIVE_PRIVATE_META_REQUIREMENTS: readonly PrivateMetaRequirement[] = [
  {
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    variable: 'contextGraphType',
    object: { kind: 'iri', value: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    variable: 'accessPolicy',
    object: { kind: 'normalized-literal', value: 'private' },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_CREATOR,
    variable: 'creator',
    object: { kind: 'iri-prefix', prefix: AGENT_DID_PREFIX },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_CURATOR,
    variable: 'curator',
    object: { kind: 'iri-prefix', prefix: AGENT_DID_PREFIX },
  },
];

function matchesRequirementObject(value: string, requirement: PrivateMetaObjectRequirement): boolean {
  switch (requirement.kind) {
    case 'iri':
      return value === requirement.value;
    case 'normalized-literal':
      return value.startsWith('"')
        && stripLiteral(value).trim().toLowerCase() === requirement.value;
    case 'iri-prefix':
      return value.startsWith(requirement.prefix)
        && value.length > requirement.prefix.length
        && isSafeIri(value);
  }
}

/** Evaluate a fetched root `_meta` snapshot against the canonical proof. */
export function hasAuthoritativePrivateMetaDefinition(
  contextGraphId: string,
  quads: readonly Quad[],
): boolean {
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  return AUTHORITATIVE_PRIVATE_META_REQUIREMENTS.every((requirement) => quads.some((quad) => (
    quad.subject === contextGraphUri
      && quad.predicate === requirement.predicate
      && matchesRequirementObject(quad.object, requirement.object)
  )));
}

function renderRequirement(
  contextGraphUri: string,
  requirement: PrivateMetaRequirement,
): string {
  const subject = `<${assertSafeIri(contextGraphUri)}>`;
  const predicate = `<${assertSafeIri(requirement.predicate)}>`;
  switch (requirement.object.kind) {
    case 'iri':
      return `${subject} ${predicate} <${assertSafeIri(requirement.object.value)}> .`;
    case 'normalized-literal': {
      const variable = `?${requirement.variable}`;
      return `${subject} ${predicate} ${variable} .\n` +
        `      FILTER(isLiteral(${variable}) && LCASE(REPLACE(STR(${variable}), "^\\\\s+|\\\\s+$", "")) = ${sparqlString(requirement.object.value)})`;
    }
    case 'iri-prefix': {
      const variable = `?${requirement.variable}`;
      const prefix = sparqlString(requirement.object.prefix);
      return `${subject} ${predicate} ${variable} .\n` +
        `      FILTER(\n` +
        `        isIRI(${variable}) &&\n` +
        `        STRSTARTS(STR(${variable}), ${prefix}) &&\n` +
        `        STRLEN(STR(${variable})) > ${requirement.object.prefix.length}\n` +
        '      )';
    }
  }
}

/** Build the store-side ASK query from the same canonical proof model. */
export function buildAuthoritativePrivateMetaAskQuery(contextGraphId: string): string {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const requirements = AUTHORITATIVE_PRIVATE_META_REQUIREMENTS
    .map((requirement) => `      ${renderRequirement(contextGraphUri, requirement)}`)
    .join('\n');
  return `ASK WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> {
${requirements}
    }
  }`;
}
