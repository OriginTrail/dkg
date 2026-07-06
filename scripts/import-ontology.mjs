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
 * subscribed nodes (and their agents) can read it back via `dkg_query`
 * against the `meta` sub-graph.
 *
 * Why store as literals (and not as parsed RDF triples expanded into
 * the graph)? v1 simplicity: agents fetch the two literals, parse them
 * in the agent's own context. The ontology is metadata about the graph,
 * not query-target data. v2 may additionally parse the .ttl into the
 * graph for SPARQLability.
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
import { buildProjectOntologyTriples } from '@origintrail-official/dkg-core';
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
const { ontologyUri, guideUri, quads: triples } = buildProjectOntologyTriples({
  contextGraphId: PROJECT_ID,
  starterSlug: STARTER,
  ttl,
  guide,
});

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
