/**
 * Manifest fetcher.
 *
 * Pulls the `dkg:ProjectManifest` for a context graph + dereferences
 * its template entities, returning the validated `ProjectManifest`
 * shape for the installer / reviewer to act on.
 *
 * Two queries:
 *   1. Fetch the manifest entity's properties (network, supportedTools,
 *      requiresMcpDkgVersion, publishedBy, createdAt, ontology ref,
 *      and the template URIs it references).
 *   2. For each template URI, fetch its `schema:text` body +
 *      `schema:encodingFormat`.
 *
 * Both queries hit /api/query directly (no SPARQL prefix injection
 * needed — we use full IRIs to avoid daemon prefix-handling drift).
 */
import {
  ManifestP,
  ManifestType,
  ProjectManifestSchema,
  manifestUri,
  type ProjectManifest,
  type TemplateEntity,
} from './schema.js';
import type { DkgClient, SparqlBinding } from '../client.js';
import { bindingValue } from '../client.js';

/** Strip RDF angle-bracket / typed-literal / lang-tag wrappers + JS-decode escapes. */
function unwrap(raw: string): string {
  if (!raw) return '';
  let v = raw;
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
  // typed literal "xxx"^^<datatype>
  let m = v.match(/^"([\s\S]*)"\^\^<.+>$/);
  if (m) v = m[1];
  // lang-tagged literal "xxx"@en
  else {
    m = v.match(/^"([\s\S]*)"@[a-zA-Z0-9-]+$/);
    if (m) v = m[1];
  }
  // bare quoted literal
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  // Reverse the escape sequences our writer applies (escapeSparqlLiteral).
  return v
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Read a SPARQL binding cell, normalising whatever shape the daemon returns. */
function cell(b: SparqlBinding | undefined, key: string): string {
  if (!b) return '';
  return unwrap(bindingValue(b[key]));
}

export interface FetchManifestOptions {
  client: DkgClient;
  contextGraphId: string;
}

/**
 * Pull the manifest for a project. Throws if no manifest is published
 * for this CG (operator should ask the curator to publish one), or if
 * the manifest fails Zod validation (manifest schema drift / corruption).
 */
export async function fetchManifest(
  opts: FetchManifestOptions,
): Promise<ProjectManifest> {
  const mUri = manifestUri(opts.contextGraphId);

  // ── 1. Manifest entity properties ──
  const headSparql = `SELECT ?p ?o WHERE { GRAPH ?g { <${mUri}> ?p ?o } }`;
  const headResult = await opts.client.query({
    sparql: headSparql,
    contextGraphId: opts.contextGraphId,
    subGraphName: 'meta',
    includeSharedMemory: true,
  });

  const props = new Map<string, string[]>();
  for (const b of headResult.bindings ?? []) {
    const p = cell(b as any, 'p');
    const o = cell(b as any, 'o');
    if (!p) continue;
    if (!props.has(p)) props.set(p, []);
    props.get(p)!.push(o);
  }
  if (!props.size) {
    throw new Error(
      `No manifest published for context graph '${opts.contextGraphId}'. ` +
      `Ask the curator to run \`scripts/import-manifest.mjs --project=${opts.contextGraphId}\` ` +
      `(or use the create-project flow which publishes one automatically).`,
    );
  }

  // ── 2. Resolve template URIs from the manifest's template predicates ──
  const templateRefs: Record<string, string | undefined> = {
    cursorRule:          props.get(ManifestP.cursorRule)?.[0],
    cursorHooksTemplate: props.get(ManifestP.cursorHooksTemplate)?.[0],
    claudeHooksTemplate: props.get(ManifestP.claudeHooksTemplate)?.[0],
    configTemplate:      props.get(ManifestP.configTemplate)?.[0],
    agentsMd:            props.get(ManifestP.agentsMd)?.[0],
    cursorMcpJson:       props.get('http://dkg.io/ontology/onboarding/cursorMcpTemplate')?.[0],
  };

  // ── 3. Fetch each template entity in parallel ──
  const templates: Record<string, TemplateEntity | undefined> = {};
  await Promise.all(
    Object.entries(templateRefs).map(async ([key, uri]) => {
      if (!uri) return;
      const tSparql = `SELECT ?p ?o WHERE { GRAPH ?g { <${uri}> ?p ?o } }`;
      try {
        const tResult = await opts.client.query({
          sparql: tSparql,
          contextGraphId: opts.contextGraphId,
          subGraphName: 'meta',
          includeSharedMemory: true,
        });
        let text = '';
        let encodingFormat = 'text/plain';
        for (const b of tResult.bindings ?? []) {
          const p = cell(b as any, 'p');
          const o = cell(b as any, 'o');
          if (p === 'http://schema.org/text') text = o;
          else if (p === 'http://schema.org/encodingFormat') encodingFormat = o;
        }
        if (text) {
          templates[key] = { uri, encodingFormat, text };
        }
      } catch (err) {
        // One missing template shouldn't kill the whole manifest fetch;
        // installer will warn about it and skip the corresponding file.
        console.warn(`[manifest] failed to fetch template ${key} at ${uri}: ${(err as Error).message}`);
      }
    }),
  );

  // ── 4. Assemble + validate ──
  const composed: any = {
    uri: mUri,
    contextGraphId: opts.contextGraphId,
    title: props.get('http://purl.org/dc/terms/title')?.[0],
    requiresMcpDkgVersion: props.get(ManifestP.requiresMcpDkgVersion)?.[0],
    supportedTools: props.get(ManifestP.supportedTools) ?? ['cursor'],
    network: props.get(ManifestP.network)?.[0],
    publishedBy: props.get(ManifestP.publishedBy)?.[0],
    publishedAt: props.get('http://purl.org/dc/terms/created')?.[0],
    ontologyUri: props.get(ManifestP.ontology)?.[0],
    cursorRule:          templates.cursorRule,
    cursorHooksTemplate: templates.cursorHooksTemplate,
    claudeHooksTemplate: templates.claudeHooksTemplate,
    configTemplate:      templates.configTemplate,
    agentsMd:            templates.agentsMd,
  };

  // Sanity-trim the supportedTools array (some serialisers can return
  // string-quoted literals where bare strings are expected).
  composed.supportedTools = (composed.supportedTools as string[])
    .map((s) => s.replace(/^["']|["']$/g, ''))
    .filter((s) => s === 'cursor' || s === 'claude-code');

  // We don't expose cursorMcpJson on the validated shape because it's
  // not strictly part of the spec — it's a convenience template the
  // installer also writes. Stash it on the returned object as a side-band.
  const validated = ProjectManifestSchema.parse(composed);
  (validated as any).cursorMcpJson = templates.cursorMcpJson;
  return validated;
}
