#!/usr/bin/env node
/**
 * Phase 8 day 1 publisher script.
 *
 * Composes + writes a `dkg:ProjectManifest` for an existing context
 * graph, using the canonical cursor-rule + AGENTS.md from the repo
 * and the hook + config templates from
 * packages/mcp-dkg/src/manifest/templates.ts.
 *
 * Usage:
 *   node scripts/import-manifest.mjs --project=dkg-code-project --network=testnet
 *   node scripts/import-manifest.mjs --project=foo --network=devnet --tools=cursor
 *   node scripts/import-manifest.mjs --project=foo --dry-run
 *
 * Once Phase 8 day 1 is done this becomes obsolete (CreateProjectModal
 * publishes inline). For now it's the curator-side convenience.
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
const NETWORK = args.network ?? 'testnet';
const TOOLS = (args.tools ?? 'cursor,claude-code').split(',').map((s) => s.trim());
const PUBLISHER = args.publisher ?? 'urn:dkg:agent:cursor-branarakic';
const DRY_RUN = args['dry-run'] === 'true';

if (!['testnet', 'mainnet', 'devnet'].includes(NETWORK)) {
  console.error(`[manifest] ERROR: --network must be one of testnet|mainnet|devnet (got "${NETWORK}")`);
  process.exit(1);
}

// Lazy-import the compiled publisher (so this script works after
// `pnpm build` in mcp-dkg). If the dist isn't built yet we fall
// back to a clear error.
let publish, assemble;
try {
  const m = await import(path.resolve(REPO_ROOT, 'packages/mcp-dkg/dist/manifest/publish.js'));
  publish = m.publishManifest;
  assemble = m.assembleStandardTemplates;
} catch (err) {
  console.error(
    `[manifest] ERROR: dist not built. Run \`pnpm --filter @origintrail-official/dkg-mcp build\` first.\n` +
    `  underlying: ${err.message}`,
  );
  process.exit(1);
}

// Compose the standard template set from the repo.
const templates = assemble(REPO_ROOT);
console.log(`[manifest] Template set assembled from ${REPO_ROOT}:`);
for (const [k, v] of Object.entries(templates)) {
  console.log(`  ${k.padEnd(22)} (${v.encodingFormat.padEnd(22)}) ${v.text.length.toLocaleString()} bytes`);
}

const ontologyUri = `urn:dkg:project:${PROJECT_ID}:ontology`;
const composeArgs = {
  contextGraphId: PROJECT_ID,
  network: NETWORK,
  supportedTools: TOOLS,
  publisherAgentUri: PUBLISHER,
  ontologyUri,
  requiresMcpDkgVersion: '>=0.1.0',
  templates,
};

if (DRY_RUN) {
  // Use composeManifestQuads directly (no daemon round-trip).
  const { composeManifestQuads } = await import(
    path.resolve(REPO_ROOT, 'packages/mcp-dkg/dist/manifest/publish.js')
  );
  const { manifestUri, templateUris, quads } = composeManifestQuads(composeArgs);
  console.log(`\n[manifest] DRY RUN — would write ${quads.length} triples`);
  console.log(`  manifest URI: ${manifestUri}`);
  console.log(`  template URIs:`);
  for (const [k, v] of Object.entries(templateUris)) console.log(`    ${k.padEnd(22)} ${v}`);
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });

// Wrap the JS client (scripts/lib/dkg-daemon.mjs) in the shape
// publishManifest expects (DkgClient interface from src/client.ts).
const adaptedClient = {
  async ensureSubGraph(cgId, sgName) {
    return client.ensureSubGraph(cgId, sgName);
  },
  async writeAssertion({ contextGraphId, assertionName, subGraphName, triples }) {
    return client.writeAssertion(
      { contextGraphId, assertionName, subGraphName, triples },
      { label: 'manifest' },
    );
  },
  async promoteAssertion({ contextGraphId, assertionName, subGraphName, entities }) {
    return client.promote({ contextGraphId, assertionName, subGraphName, entities });
  },
};

const result = await publish({ ...composeArgs, client: adaptedClient });
console.log(`\n[manifest] Published ${result.tripleCount} triples to ${PROJECT_ID}/meta/project-manifest:`);
console.log(`  manifest URI: ${result.manifestUri}`);
console.log(`  template URIs:`);
for (const [k, v] of Object.entries(result.templateUris)) console.log(`    ${k.padEnd(22)} ${v}`);
