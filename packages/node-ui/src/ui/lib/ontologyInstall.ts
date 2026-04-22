/**
 * Install one of the bundled starter ontologies (or a custom one) into a
 * newly-created context graph's `meta` sub-graph as the `project-ontology`
 * assertion. Mirrors `scripts/import-ontology.mjs` but runs entirely in
 * the browser via the canonical /api/assertion/<name>/write + /promote
 * endpoints — no new daemon code needed.
 *
 * Each starter ships as a pair of static text files:
 *   - ontology.ttl    — formal Turtle/OWL document (source of truth)
 *   - agent-guide.md  — operational instructions for the agent
 *
 * Both are loaded at build time via Vite's import.meta.glob so the
 * UI bundle has them inline; no runtime fetch needed.
 */
import { authHeaders } from '../api.js';

// Local POST helper. The api.ts module's `post` is private; re-using
// `authHeaders` lets us send authenticated JSON to the daemon without
// widening the api.ts surface.
async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// Vite glob imports — relative path reaches up into the mcp-dkg package.
// All .ttl and .md files under templates/ontologies/<name>/ get bundled.
const TTL_FILES = import.meta.glob<string>(
  '../../../../mcp-dkg/templates/ontologies/*/ontology.ttl',
  { query: '?raw', import: 'default', eager: true },
);
const GUIDE_FILES = import.meta.glob<string>(
  '../../../../mcp-dkg/templates/ontologies/*/agent-guide.md',
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Map of available starter slugs to their (ttl, agentGuide) text payloads.
 * Slug = the directory name under templates/ontologies/.
 */
function buildStarterMap(): Record<string, { ttl: string; guide: string }> {
  const map: Record<string, { ttl: string; guide: string }> = {};
  for (const [path, ttl] of Object.entries(TTL_FILES)) {
    const m = path.match(/ontologies\/([^/]+)\/ontology\.ttl$/);
    if (!m) continue;
    const slug = m[1];
    map[slug] = { ttl, guide: '' };
  }
  for (const [path, guide] of Object.entries(GUIDE_FILES)) {
    const m = path.match(/ontologies\/([^/]+)\/agent-guide\.md$/);
    if (!m) continue;
    const slug = m[1];
    if (map[slug]) map[slug].guide = guide;
  }
  return map;
}

const STARTERS = buildStarterMap();

export interface StarterOption {
  slug: string;
  displayName: string;
  description: string;
}

/** Human-readable metadata for the starter picker. Order matters — first
 *  entry is the default for the 'agent' picker mode. */
export const STARTER_OPTIONS: StarterOption[] = [
  { slug: 'coding-project', displayName: 'Coding project',
    description: 'Software projects: decisions, tasks, code, GitHub. The v1 reference ontology.' },
  { slug: 'book-research', displayName: 'Book / paper research',
    description: 'Long-form non-fiction: hypotheses, arguments, citations, quotes. Built on BIBO + SPAR.' },
  { slug: 'pkm', displayName: 'Personal knowledge management',
    description: 'Notes, highlights, insights — daily-driver PKM workflow. Composes with SKOS.' },
  { slug: 'scientific-research', displayName: 'Scientific research',
    description: 'Empirical research: hypotheses → experiments → results → reproducibility. Built on PROV-O + DCAT + FaBiO.' },
  { slug: 'narrative-writing', displayName: 'Narrative writing',
    description: 'Fiction or narrative non-fiction: characters, scenes, plot points, themes.' },
];

/** Available starter slugs (for filtering UI / validation). */
export function listStarters(): StarterOption[] {
  return STARTER_OPTIONS.filter((opt) => STARTERS[opt.slug]);
}

/** Get the (ttl, agentGuide) for a starter. */
export function getStarter(slug: string): { ttl: string; guide: string } | null {
  return STARTERS[slug] ?? null;
}

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  owl: 'http://www.w3.org/2002/07/owl#',
};

/** Build the same triple set that scripts/import-ontology.mjs writes. */
function buildOntologyTriples(
  contextGraphId: string,
  starterSlug: string,
  ttl: string,
  guide: string,
): { ontologyUri: string; guideUri: string; quads: Array<{ subject: string; predicate: string; object: string }> } {
  const ontologyUri = `urn:dkg:project:${contextGraphId}:ontology`;
  const guideUri = `${ontologyUri}:agent-guide`;
  const nowIso = new Date().toISOString();

  const escLit = (s: string) =>
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  const lit = (v: string, dt?: string) =>
    dt ? `"${escLit(v)}"^^<${dt}>` : `"${escLit(v)}"`;

  const quads = [
    { subject: ontologyUri, predicate: NS.rdf + 'type', object: `<${NS.owl}Ontology>` },
    { subject: ontologyUri, predicate: NS.rdf + 'type', object: `<${NS.prov}Entity>` },
    { subject: ontologyUri, predicate: NS.rdfs + 'label', object: lit(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.schema + 'name', object: lit(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'title', object: lit(`Project ontology — ${contextGraphId}`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'description', object: lit(`The active ontology for context graph ${contextGraphId}, derived from the '${starterSlug}' starter.`) },
    { subject: ontologyUri, predicate: NS.dcterms + 'created', object: lit(nowIso, NS.xsd + 'dateTime') },
    { subject: ontologyUri, predicate: NS.dcterms + 'modified', object: lit(nowIso, NS.xsd + 'dateTime') },
    { subject: ontologyUri, predicate: NS.dcterms + 'source', object: lit(starterSlug) },
    { subject: ontologyUri, predicate: NS.schema + 'encodingFormat', object: lit('text/turtle') },
    { subject: ontologyUri, predicate: NS.schema + 'text', object: lit(ttl) },
    { subject: ontologyUri, predicate: NS.dcterms + 'references', object: `<${guideUri}>` },

    { subject: guideUri, predicate: NS.rdf + 'type', object: `<${NS.schema}DigitalDocument>` },
    { subject: guideUri, predicate: NS.rdfs + 'label', object: lit(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.schema + 'name', object: lit(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.dcterms + 'title', object: lit(`Agent guide — ${contextGraphId} ontology`) },
    { subject: guideUri, predicate: NS.dcterms + 'created', object: lit(nowIso, NS.xsd + 'dateTime') },
    { subject: guideUri, predicate: NS.dcterms + 'modified', object: lit(nowIso, NS.xsd + 'dateTime') },
    { subject: guideUri, predicate: NS.schema + 'encodingFormat', object: lit('text/markdown') },
    { subject: guideUri, predicate: NS.schema + 'text', object: lit(guide) },
    { subject: guideUri, predicate: NS.schema + 'about', object: `<${ontologyUri}>` },
  ];
  return { ontologyUri, guideUri, quads };
}

/**
 * Install a starter ontology into the given context graph. Idempotent —
 * re-running with the same starter replaces the assertion.
 *
 * IMPORTANT: `/api/assertion/:name/write` is **append-only**, not
 * destructive-replace, despite how the old docstring read. Re-running
 * `installOntology` without the `discard` call below would accumulate
 * stale `schema:text`, `dcterms:created`, etc. on the same `project-ontology`
 * assertion (e.g. a switch from `coding-project` to `book-research` would
 * leave both starters' text co-resident). We therefore discard the
 * existing assertion before writing the new quads, the same way
 * `packages/mcp-dkg/src/manifest/publish.ts` does for `project-manifest`.
 * A 404 on first install is expected and swallowed.
 */
export async function installOntology(
  contextGraphId: string,
  starterSlug: string,
): Promise<{ ontologyUri: string; guideUri: string; tripleCount: number }> {
  const starter = getStarter(starterSlug);
  if (!starter) throw new Error(`Unknown ontology starter '${starterSlug}'. Available: ${Object.keys(STARTERS).join(', ')}`);
  if (!starter.ttl || !starter.guide) {
    throw new Error(`Starter '${starterSlug}' is missing ontology.ttl or agent-guide.md.`);
  }

  await post<{ created?: boolean }>('/api/sub-graph/create', {
    contextGraphId,
    subGraphName: 'meta',
  }).catch((err) => {
    if (!String(err?.message ?? err).includes('already exists')) throw err;
  });

  const { ontologyUri, guideUri, quads } = buildOntologyTriples(
    contextGraphId,
    starterSlug,
    starter.ttl,
    starter.guide,
  );

  await post('/api/assertion/project-ontology/discard', {
    contextGraphId,
    subGraphName: 'meta',
  }).catch((err) => {
    const msg = String(err?.message ?? err);
    if (!/404|not found/i.test(msg)) throw err;
  });

  await post('/api/assertion/project-ontology/write', {
    contextGraphId,
    subGraphName: 'meta',
    quads,
  });

  // Auto-promote so other subscribed nodes (and their agents) see it.
  try {
    await post('/api/assertion/project-ontology/promote', {
      contextGraphId,
      subGraphName: 'meta',
      entities: [ontologyUri, guideUri],
    });
  } catch {
    // Promote failure is non-fatal — agent on this node can still use it.
  }

  return { ontologyUri, guideUri, tripleCount: quads.length };
}
