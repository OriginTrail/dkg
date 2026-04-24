#!/usr/bin/env node
/**
 * Import the project ontology into a context graph's `meta` sub-graph.
 *
 * Reads two artifacts from a starter directory (default:
 * packages/mcp-dkg/templates/ontologies/coding-project/):
 *
 *   - ontology.ttl    — formal Turtle/OWL document, source of truth
 *   - agent-guide.md  — instructional translation for the LLM agent
 *
 * Stores them as literals on a single `prov:Entity` node in the
 * `meta/project-ontology` assertion, then auto-promotes to SWM so all
 * subscribed nodes (and their agents) can fetch via `dkg_get_ontology`.
 *
 * Why store as literals (and not as parsed RDF triples expanded into
 * the graph)? v1 simplicity: agents fetch via dkg_get_ontology, get
 * back two strings, parse them in the agent's own context. The
 * ontology is metadata about the graph, not query-target data. v2 may
 * additionally parse the .ttl into the graph for SPARQLability.
 *
 * Usage:
 *   node scripts/import-ontology.mjs                       # writes to dkg-code-project from coding-project starter
 *   node scripts/import-ontology.mjs --starter=book-research --project=my-book
 *   node scripts/import-ontology.mjs --dir=/abs/path/to/custom-ontology
 *   node scripts/import-ontology.mjs --dry-run
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SUBGRAPH = args.subgraph ?? 'meta';
const ASSERTION_NAME = args.assertion ?? 'project-ontology';
const STARTER = args.starter ?? 'coding-project';
const DRY_RUN = args['dry-run'] === 'true';

const ONTOLOGY_DIR = args.dir
  ? path.resolve(args.dir)
  : path.resolve(REPO_ROOT, 'packages/mcp-dkg/templates/ontologies', STARTER);

const TTL_PATH = path.join(ONTOLOGY_DIR, 'ontology.ttl');
const GUIDE_PATH = path.join(ONTOLOGY_DIR, 'agent-guide.md');

if (!fs.existsSync(TTL_PATH)) {
  console.error(`[ontology] ERROR: ${TTL_PATH} does not exist. Pick a different --starter or --dir.`);
  process.exit(1);
}
if (!fs.existsSync(GUIDE_PATH)) {
  console.error(`[ontology] ERROR: ${GUIDE_PATH} does not exist. Every starter must ship both ontology.ttl + agent-guide.md.`);
  process.exit(1);
}

const ttl = fs.readFileSync(TTL_PATH, 'utf-8');
const guide = fs.readFileSync(GUIDE_PATH, 'utf-8');

// Ontology entity URI is stable per project so re-imports replace
// rather than duplicate. Guide is a sub-document via dcterms:references.
const ontologyUri = `urn:dkg:project:${PROJECT_ID}:ontology`;
const guideUri = `urn:dkg:project:${PROJECT_ID}:ontology:agent-guide`;
const nowIso = new Date().toISOString();

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  owl: 'http://www.w3.org/2002/07/owl#',
};

const escLit = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

const lit = (v, dt) => (dt ? `"${escLit(v)}"^^<${dt}>` : `"${escLit(v)}"`);

const triples = [
  // Ontology entity
  { subject: ontologyUri, predicate: NS.rdf + 'type', object: `<${NS.owl}Ontology>` },
  { subject: ontologyUri, predicate: NS.rdf + 'type', object: `<${NS.prov}Entity>` },
  { subject: ontologyUri, predicate: NS.rdfs + 'label', object: lit(`Project ontology — ${PROJECT_ID}`) },
  { subject: ontologyUri, predicate: NS.schema + 'name', object: lit(`Project ontology — ${PROJECT_ID}`) },
  { subject: ontologyUri, predicate: NS.dcterms + 'title', object: lit(`Project ontology — ${PROJECT_ID}`) },
  { subject: ontologyUri, predicate: NS.dcterms + 'description', object: lit(`The active ontology for context graph ${PROJECT_ID}, derived from the '${STARTER}' starter.`) },
  { subject: ontologyUri, predicate: NS.dcterms + 'created', object: lit(nowIso, NS.xsd + 'dateTime') },
  { subject: ontologyUri, predicate: NS.dcterms + 'modified', object: lit(nowIso, NS.xsd + 'dateTime') },
  { subject: ontologyUri, predicate: NS.dcterms + 'source', object: lit(STARTER) },
  { subject: ontologyUri, predicate: NS.schema + 'encodingFormat', object: lit('text/turtle') },
  { subject: ontologyUri, predicate: NS.schema + 'text', object: lit(ttl) },
  { subject: ontologyUri, predicate: NS.dcterms + 'references', object: `<${guideUri}>` },

  // Agent guide as a sub-document
  { subject: guideUri, predicate: NS.rdf + 'type', object: `<${NS.schema}DigitalDocument>` },
  { subject: guideUri, predicate: NS.rdfs + 'label', object: lit(`Agent guide — ${PROJECT_ID} ontology`) },
  { subject: guideUri, predicate: NS.schema + 'name', object: lit(`Agent guide — ${PROJECT_ID} ontology`) },
  { subject: guideUri, predicate: NS.dcterms + 'title', object: lit(`Agent guide — ${PROJECT_ID} ontology`) },
  { subject: guideUri, predicate: NS.dcterms + 'created', object: lit(nowIso, NS.xsd + 'dateTime') },
  { subject: guideUri, predicate: NS.dcterms + 'modified', object: lit(nowIso, NS.xsd + 'dateTime') },
  { subject: guideUri, predicate: NS.schema + 'encodingFormat', object: lit('text/markdown') },
  { subject: guideUri, predicate: NS.schema + 'text', object: lit(guide) },
  { subject: guideUri, predicate: NS.schema + 'about', object: `<${ontologyUri}>` },
];

console.log(
  `[ontology] Produced ${triples.length} triples from ${STARTER} starter:\n` +
  `  ontology.ttl   = ${ttl.length.toLocaleString()} bytes\n` +
  `  agent-guide.md = ${guide.length.toLocaleString()} bytes\n` +
  `  ontology URI   = ${ontologyUri}\n` +
  `  guide URI      = ${guideUri}`,
);

if (DRY_RUN) {
  console.log('[ontology] --dry-run set; not importing.');
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });
const { cgId } = await client.ensureProject({
  id: PROJECT_ID,
  name: 'DKG Code memory',
  description: 'Shared context graph for the dkg-v9 monorepo itself.',
});
await client.ensureSubGraph(cgId, SUBGRAPH);
await client.writeAssertion(
  {
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples,
  },
  { label: 'ontology' },
);
try {
  await client.promote({
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    entities: [ontologyUri, guideUri],
  });
  console.log('[ontology] Promoted to SWM.');
} catch (err) {
  console.warn(`[ontology] Promote skipped: ${err.message}`);
}
console.log(
  `[ontology] Done. Wrote ${triples.length} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`,
);
