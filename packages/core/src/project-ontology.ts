import { buildProjectOntologyTriples as buildProjectOntologyTriplesRuntime } from './project-ontology-runtime.js';

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

/**
 * Compose the `meta/project-ontology` assertion used by both the browser
 * installer and the standalone ontology import script. Object terms follow
 * the daemon `/wm/write` JSON contract: literals are quoted RDF literals and
 * resource objects are raw absolute IRIs, not `<iri>` N-Triples tokens.
 */
export const buildProjectOntologyTriples:
  (args: BuildProjectOntologyTriplesArgs) => BuildProjectOntologyTriplesResult =
  buildProjectOntologyTriplesRuntime;
