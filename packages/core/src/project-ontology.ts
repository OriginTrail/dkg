import { escapeSparqlLiteral, isSafeIri } from './sparql-safe.js';

export interface ProjectOntologyQuad {
  subject: string;
  predicate: string;
  object: string;
}

export interface BuildProjectOntologyTriplesArgs {
  contextGraphId: string;
  starterSlug: string;
  ttl: string;
  guide: string;
  nowIso?: string;
}

export interface BuildProjectOntologyTriplesResult {
  ontologyUri: string;
  guideUri: string;
  quads: ProjectOntologyQuad[];
}

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  owl: 'http://www.w3.org/2002/07/owl#',
} as const;

function wmWriteIriObject(value: string): string {
  if (!isSafeIri(value)) {
    throw new Error(`Invalid /wm/write IRI object: ${value}`);
  }
  return value;
}

function literal(value: string): string {
  return `"${escapeSparqlLiteral(value)}"`;
}

function typedLiteral(value: string, datatypeIri: string): string {
  return `"${escapeSparqlLiteral(value)}"^^<${wmWriteIriObject(datatypeIri)}>`;
}

/**
 * Compose the `meta/project-ontology` assertion used by both the browser
 * installer and the standalone ontology import script. Object terms follow
 * the daemon `/wm/write` JSON contract: literals are quoted RDF literals and
 * resource objects are raw absolute IRIs, not `<iri>` N-Triples tokens.
 */
export function buildProjectOntologyTriples({
  contextGraphId,
  starterSlug,
  ttl,
  guide,
  nowIso = new Date().toISOString(),
}: BuildProjectOntologyTriplesArgs): BuildProjectOntologyTriplesResult {
  if (!contextGraphId) throw new Error('contextGraphId is required');
  if (!starterSlug) throw new Error('starterSlug is required');

  const ontologyUri = wmWriteIriObject(`urn:dkg:project:${contextGraphId}:ontology`);
  const guideUri = wmWriteIriObject(`${ontologyUri}:agent-guide`);

  const quads = [
    { subject: ontologyUri, predicate: NS.rdf + 'type', object: wmWriteIriObject(NS.owl + 'Ontology') },
    { subject: ontologyUri, predicate: NS.rdf + 'type', object: wmWriteIriObject(NS.prov + 'Entity') },
    { subject: ontologyUri, predicate: NS.rdfs + 'label', object: literal(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.schema + 'name', object: literal(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'title', object: literal(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'description', object: literal(`The active ontology for context graph ${contextGraphId}, derived from the '${starterSlug}' starter.`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'created', object: typedLiteral(nowIso, NS.xsd + 'dateTime') },
    { subject: ontologyUri, predicate: NS.dcterms + 'modified', object: typedLiteral(nowIso, NS.xsd + 'dateTime') },
    { subject: ontologyUri, predicate: NS.dcterms + 'source', object: literal(starterSlug) },
    { subject: ontologyUri, predicate: NS.schema + 'encodingFormat', object: literal('text/turtle') },
    { subject: ontologyUri, predicate: NS.schema + 'text', object: literal(ttl) },
    { subject: ontologyUri, predicate: NS.dcterms + 'references', object: wmWriteIriObject(guideUri) },

    { subject: guideUri, predicate: NS.rdf + 'type', object: wmWriteIriObject(NS.schema + 'DigitalDocument') },
    { subject: guideUri, predicate: NS.rdfs + 'label', object: literal(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.schema + 'name', object: literal(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.dcterms + 'title', object: literal(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.dcterms + 'created', object: typedLiteral(nowIso, NS.xsd + 'dateTime') },
    { subject: guideUri, predicate: NS.dcterms + 'modified', object: typedLiteral(nowIso, NS.xsd + 'dateTime') },
    { subject: guideUri, predicate: NS.schema + 'encodingFormat', object: literal('text/markdown') },
    { subject: guideUri, predicate: NS.schema + 'text', object: literal(guide) },
    { subject: guideUri, predicate: NS.schema + 'about', object: wmWriteIriObject(ontologyUri) },
  ];

  return { ontologyUri, guideUri, quads };
}
