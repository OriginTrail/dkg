/**
 * Manifest publisher (Node-side).
 *
 * Composes a `dkg:ProjectManifest` + its template entities for a
 * project and writes them all into the project's `meta` sub-graph
 * via the canonical /api/assertion/<name>/write+promote path. After
 * this returns, any node subscribed to the CG can read the manifest
 * via gossip and use it to onboard new agents.
 *
 * Two callers:
 *   - The CLI (`dkg-mcp create-project`) — reads cursor-rule + AGENTS.md
 *     from the local repo, composes templates from the constants in
 *     templates.ts, writes to a daemon over HTTP.
 *   - The browser (CreateProjectModal) — equivalent but with templates
 *     bundled via Vite ?raw imports. Lives in node-ui as a sibling.
 *
 * Both share `composeManifestQuads()` so the on-the-wire triple shape
 * is identical regardless of who publishes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  NS,
  ManifestType,
  TemplateType,
  ManifestP,
  WORKSPACE_TARGETS,
  manifestUri,
  templateUri,
  type TemplateField,
} from './schema.js';
import {
  CURSOR_HOOKS_TEMPLATE,
  CLAUDE_HOOKS_TEMPLATE,
  CONFIG_YAML_TEMPLATE,
  CURSOR_MCP_JSON_TEMPLATE,
} from './templates.js';
import type { DkgClient } from '../client.js';

// ── Triple helpers (mirror writes.ts conventions) ───────────────────
const U = (iri: string): string => `<${iri}>`;
const escLit = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
const L = (v: string, dt?: string): string =>
  dt ? `"${escLit(v)}"^^<${dt}>` : `"${escLit(v)}"`;

const TypeP = NS.rdf + 'type';
const LabelP = NS.rdfs + 'label';
const NameP = NS.schema + 'name';
const TitleP = NS.dcterms + 'title';
const CreatedP = NS.dcterms + 'created';
const ModifiedP = NS.dcterms + 'modified';
const SourceFileP = NS.dcterms + 'source';
const EncodingFormatP = NS.schema + 'encodingFormat';
const TextP = NS.schema + 'text';
const ReferencesP = NS.dcterms + 'references';
const AboutP = NS.schema + 'about';

// ── Public types ────────────────────────────────────────────────────

export interface ManifestComposeArgs {
  contextGraphId: string;
  network: 'testnet' | 'mainnet' | 'devnet';
  supportedTools: ('cursor' | 'claude-code')[];
  /** URI of the agent (curator) publishing the manifest. */
  publisherAgentUri: string;
  /** URI of the project's ontology entity (Phase 7). */
  ontologyUri?: string;
  /** SemVer range for compatible mcp-dkg installations. */
  requiresMcpDkgVersion?: string;
  /**
   * Bodies of the template entities. Caller assembles these from
   * either repo files (CLI) or bundled assets (browser). Anything
   * omitted means "this project doesn't ship a template for that
   * field" — the installer skips that file.
   */
  templates: Partial<Record<
    TemplateField | 'cursorMcpJson',
    { encodingFormat: string; text: string }
  >>;
}

export interface ManifestPublishResult {
  manifestUri: string;
  templateUris: Record<string, string>;
  tripleCount: number;
}

// ── Quad composition (shared between Node + browser publishers) ─────

/**
 * Build the full quad set for a manifest + its template entities.
 * Pure function — no I/O. Callers handle write+promote separately.
 */
export function composeManifestQuads(
  args: ManifestComposeArgs,
): {
  manifestUri: string;
  templateUris: Record<string, string>;
  quads: Array<{ subject: string; predicate: string; object: string }>;
} {
  const mUri = manifestUri(args.contextGraphId);
  const nowIso = new Date().toISOString();
  const quads: Array<{ subject: string; predicate: string; object: string }> = [];

  // ── Manifest entity ──
  quads.push(
    { subject: mUri, predicate: TypeP, object: U(ManifestType) },
    { subject: mUri, predicate: LabelP, object: L(`Project manifest — ${args.contextGraphId}`) },
    { subject: mUri, predicate: NameP, object: L(`Project manifest — ${args.contextGraphId}`) },
    { subject: mUri, predicate: TitleP, object: L(`Project manifest — ${args.contextGraphId}`) },
    { subject: mUri, predicate: ManifestP.network, object: L(args.network) },
    { subject: mUri, predicate: CreatedP, object: L(nowIso, NS.xsd + 'dateTime') },
    { subject: mUri, predicate: ModifiedP, object: L(nowIso, NS.xsd + 'dateTime') },
    { subject: mUri, predicate: ManifestP.publishedBy, object: U(args.publisherAgentUri) },
  );
  if (args.requiresMcpDkgVersion) {
    quads.push({
      subject: mUri,
      predicate: ManifestP.requiresMcpDkgVersion,
      object: L(args.requiresMcpDkgVersion),
    });
  }
  for (const tool of args.supportedTools) {
    quads.push({ subject: mUri, predicate: ManifestP.supportedTools, object: L(tool) });
  }
  if (args.ontologyUri) {
    quads.push({ subject: mUri, predicate: ManifestP.ontology, object: U(args.ontologyUri) });
  }

  // ── Template entities ──
  //
  // Each template gets its own URI under the manifest namespace, its
  // own DigitalDocument triples, and a back-link from the manifest
  // via the appropriate predicate.
  const templateUris: Record<string, string> = {};
  const templateMap: Array<{
    key: TemplateField | 'cursorMcpJson';
    predicate: string;
  }> = [
    { key: 'cursorRule',          predicate: ManifestP.cursorRule },
    { key: 'cursorHooksTemplate', predicate: ManifestP.cursorHooksTemplate },
    { key: 'claudeHooksTemplate', predicate: ManifestP.claudeHooksTemplate },
    { key: 'configTemplate',      predicate: ManifestP.configTemplate },
    { key: 'agentsMd',            predicate: ManifestP.agentsMd },
    // cursorMcpJson lives under a non-onboarding-namespace predicate
    // because it doesn't have a workspace target in WORKSPACE_TARGETS
    // (it's a separate file the installer writes; recorded for
    // completeness so the same publisher can ship it).
    { key: 'cursorMcpJson',       predicate: NS.dkgOnboard + 'cursorMcpTemplate' },
  ];
  for (const { key, predicate } of templateMap) {
    const tmpl = args.templates[key];
    if (!tmpl) continue;
    const tUri = templateUri(args.contextGraphId, key as TemplateField);
    templateUris[key] = tUri;
    quads.push(
      { subject: mUri, predicate, object: U(tUri) },
      { subject: tUri, predicate: TypeP, object: U(TemplateType) },
      { subject: tUri, predicate: LabelP, object: L(`${key} template — ${args.contextGraphId}`) },
      { subject: tUri, predicate: NameP, object: L(`${key} template — ${args.contextGraphId}`) },
      { subject: tUri, predicate: TitleP, object: L(`${key} template — ${args.contextGraphId}`) },
      { subject: tUri, predicate: EncodingFormatP, object: L(tmpl.encodingFormat) },
      { subject: tUri, predicate: TextP, object: L(tmpl.text) },
      { subject: tUri, predicate: AboutP, object: U(mUri) },
      { subject: tUri, predicate: ReferencesP, object: U(mUri) },
      { subject: tUri, predicate: CreatedP, object: L(nowIso, NS.xsd + 'dateTime') },
      // Workspace target hint (helps the installer + helps debugging).
      // For cursorMcpJson we use a pseudo-target that the installer
      // recognises specifically.
      {
        subject: tUri,
        predicate: NS.dkgOnboard + 'workspaceTarget',
        object: L(
          (WORKSPACE_TARGETS as Record<string, string>)[key] ?? '<workspace>/.cursor/mcp.json',
        ),
      },
    );
  }

  return { manifestUri: mUri, templateUris, quads };
}

// ── Node-side template assembler (reads canonical files from repo) ──

/**
 * Assemble the standard template set for a coding-flavoured project.
 * Reads cursor-rule and AGENTS.md from the canonical repo files so
 * they stay in lockstep with what we ship locally; emits hook +
 * config templates from the constants in `templates.ts`.
 *
 * `repoRoot` is the absolute path to the dkg-v9 checkout (the dir
 * containing `packages/`, `AGENTS.md`, `.cursor/`).
 */
export function assembleStandardTemplates(repoRoot: string): NonNullable<ManifestComposeArgs['templates']> {
  const cursorRulePath = path.join(repoRoot, '.cursor', 'rules', 'dkg-annotate.mdc');
  const agentsMdPath = path.join(repoRoot, 'AGENTS.md');
  if (!fs.existsSync(cursorRulePath)) {
    throw new Error(
      `Canonical cursor rule not found at ${cursorRulePath}. Make sure you're publishing from a dkg-v9 checkout that has Phase 7 landed.`,
    );
  }
  if (!fs.existsSync(agentsMdPath)) {
    throw new Error(
      `Canonical AGENTS.md not found at ${agentsMdPath}. Make sure you're publishing from a dkg-v9 checkout that has Phase 7 landed.`,
    );
  }
  return {
    cursorRule: {
      encodingFormat: 'text/markdown',
      text: fs.readFileSync(cursorRulePath, 'utf-8'),
    },
    agentsMd: {
      encodingFormat: 'text/markdown',
      text: fs.readFileSync(agentsMdPath, 'utf-8'),
    },
    cursorHooksTemplate: {
      encodingFormat: 'application/json',
      text: CURSOR_HOOKS_TEMPLATE,
    },
    claudeHooksTemplate: {
      encodingFormat: 'application/json',
      text: CLAUDE_HOOKS_TEMPLATE,
    },
    configTemplate: {
      encodingFormat: 'text/yaml',
      text: CONFIG_YAML_TEMPLATE,
    },
    cursorMcpJson: {
      encodingFormat: 'application/json',
      text: CURSOR_MCP_JSON_TEMPLATE,
    },
  };
}

// ── Top-level: publish a manifest to a project ──────────────────────

export interface PublishOptions extends ManifestComposeArgs {
  client: DkgClient;
  /** Auto-promote the manifest to SWM (default: true). */
  autoShare?: boolean;
  /** Override the assertion name; default `project-manifest`. */
  assertionName?: string;
}

/**
 * Compose + write + promote a manifest. Returns the manifest URI and
 * the URIs of all published template entities so the caller can show
 * the operator what was published.
 */
export async function publishManifest(
  opts: PublishOptions,
): Promise<ManifestPublishResult> {
  const { manifestUri: mUri, templateUris, quads } = composeManifestQuads(opts);

  const assertion = opts.assertionName ?? 'project-manifest';
  await opts.client.ensureSubGraph(opts.contextGraphId, 'meta');
  // Republish semantics: clear the existing assertion graph before
  // writing the fresh quads. `assertionWrite` is append-only (the
  // daemon's `store.insert` is set-merge, not replace), so without the
  // discard step a second publish would leave stale predicate values
  // alongside the new ones — e.g. the manifest entity would end up
  // with N `publishedAt` timestamps and every previously-supported
  // tool lingering in `supportedTools`. `assertionDiscard` is idempotent
  // (no-op on an assertion that was never written), so we can always
  // call it. Template entities live under the SAME assertion name, so
  // a single discard clears them too.
  await opts.client
    .discardAssertion({
      contextGraphId: opts.contextGraphId,
      assertionName: assertion,
      subGraphName: 'meta',
    })
    .catch(() => {
      // Swallow: discard on a first-publish CG will 404 from the
      // `_meta` cleanup path. The subsequent write is still correct.
    });
  await opts.client.writeAssertion({
    contextGraphId: opts.contextGraphId,
    assertionName: assertion,
    subGraphName: 'meta',
    triples: quads,
  });

  if (opts.autoShare !== false) {
    try {
      await opts.client.promoteAssertion({
        contextGraphId: opts.contextGraphId,
        assertionName: assertion,
        subGraphName: 'meta',
        entities: [mUri, ...Object.values(templateUris)],
      });
    } catch {
      // Promote failure is non-fatal; manifest is in WM and can be promoted later.
    }
  }

  return { manifestUri: mUri, templateUris, tripleCount: quads.length };
}
