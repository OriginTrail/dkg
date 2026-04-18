/**
 * dkg:ProjectManifest — the self-describing onboarding entity.
 *
 * Lives in a project's `meta` sub-graph at
 * `urn:dkg:project:<cgId>:manifest`, alongside `meta/project-ontology`
 * (Phase 7) and `meta/project-profile` (existing).
 *
 * The manifest declares everything an agent needs to participate in
 * the project from a fresh machine:
 *
 *   - Which tools it supports (cursor / claude-code)
 *   - Which network the project lives on (resolved by name; the
 *     installer reads `network/<name>.json` for chain RPC, Hub
 *     address, and relay multiaddrs — already shipped for testnet
 *     on Base Sepolia)
 *   - The Cursor rule, hook templates, AGENTS.md, .dkg/config.yaml
 *     template that the installer materialises into the operator's
 *     workspace
 *   - A reference to the project's Phase 7 ontology so the agent
 *     can pull guide + .ttl on session-start
 *
 * Each template field references a separate `schema:DigitalDocument`
 * entity in the same `meta` sub-graph (the same pattern Phase 7
 * established for ontology + agent-guide). Templates carry their
 * file content as `schema:text` literal + a `schema:encodingFormat`.
 *
 * Templates support a tiny `{{placeholder}}` substitution at install
 * time. The substitution set is fixed (see `MANIFEST_PLACEHOLDERS`)
 * — no nested logic, no conditionals, no script execution. This
 * keeps the security model simple: the manifest is config files,
 * not code.
 */
import { z } from 'zod';

// ── Namespaces ──────────────────────────────────────────────────────
export const NS = {
  rdf:        'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:       'http://www.w3.org/2000/01/rdf-schema#',
  schema:     'http://schema.org/',
  dcterms:    'http://purl.org/dc/terms/',
  xsd:        'http://www.w3.org/2001/XMLSchema#',
  prov:       'http://www.w3.org/ns/prov#',
  dkg:        'http://dkg.io/ontology/',
  dkgOnboard: 'http://dkg.io/ontology/onboarding/',
} as const;

// ── Manifest entity types ───────────────────────────────────────────
export const ManifestType = `${NS.dkg}ProjectManifest`;
export const TemplateType = `${NS.schema}DigitalDocument`;

// ── Manifest predicates ─────────────────────────────────────────────
export const ManifestP = {
  /** SemVer range the local mcp-dkg installation must satisfy. */
  requiresMcpDkgVersion: `${NS.dkgOnboard}requiresMcpDkgVersion`,
  /** Tools the operator may install for (cursor / claude-code / both). */
  supportedTools:        `${NS.dkgOnboard}supportedTools`,
  /** Network name resolving to <repo>/network/<name>.json. */
  network:               `${NS.dkgOnboard}network`,
  /** Templates that get materialised into the operator workspace. */
  cursorRule:            `${NS.dkgOnboard}cursorRule`,
  cursorHooksTemplate:   `${NS.dkgOnboard}cursorHooksTemplate`,
  claudeHooksTemplate:   `${NS.dkgOnboard}claudeHooksTemplate`,
  configTemplate:        `${NS.dkgOnboard}configTemplate`,
  agentsMd:              `${NS.dkgOnboard}agentsMd`,
  /** Reference to the project ontology entity (Phase 7). */
  ontology:              `${NS.dkgOnboard}ontology`,
  /** Curator agent URI — for prov:wasAttributedTo. */
  publishedBy:           `${NS.prov}wasAttributedTo`,
} as const;

// ── Placeholders the installer substitutes into templates ───────────
//
// At install time, every occurrence of these {{names}} in a template's
// `schema:text` body is replaced with the corresponding value. Anything
// not in this fixed set is left as literal text (so a template that
// uses {{anything-else}} silently no-ops on it; safer than failing).
export const MANIFEST_PLACEHOLDERS = [
  'agentSlug',          // operator-chosen, e.g. "branarakic-laptop2"
  'agentUri',           // urn:dkg:agent:<agentSlug>
  'contextGraphId',     // the project's CG ID (e.g. dkg-code-project)
  'daemonApiUrl',       // local daemon API (default http://localhost:9201)
  'daemonTokenFile',    // relative path to auth.token (e.g. ../.devnet/node1/auth.token)
  'workspaceAbsPath',   // absolute path of the operator's workspace
  'mcpDkgDistAbsPath',  // absolute path to packages/mcp-dkg/dist/index.js
  'captureScriptPath',  // absolute path to packages/mcp-dkg/hooks/capture-chat.mjs
  'network',            // testnet / mainnet / devnet
] as const;

export type ManifestPlaceholder = (typeof MANIFEST_PLACEHOLDERS)[number];

// ── Workspace install targets (path-locked) ─────────────────────────
//
// Phase 8 security model: the installer ONLY writes to these paths.
// Anything else in a manifest is ignored with a warning.
//
// Each template field maps to one workspace target. We model this as a
// fixed map rather than letting the manifest declare arbitrary
// destinations — keeps the trust boundary tight.
export const WORKSPACE_TARGETS = {
  cursorRule:          '<workspace>/.cursor/rules/dkg-annotate.mdc',
  cursorHooksTemplate: '<workspace>/.cursor/hooks.json',
  claudeHooksTemplate: '<homedir>/.claude/settings.json',  // merge, not replace
  configTemplate:      '<workspace>/.dkg/config.yaml',
  agentsMd:            '<workspace>/AGENTS.md',
} as const;

export type TemplateField = keyof typeof WORKSPACE_TARGETS;

// ── Zod schemas (validate manifest entities pulled from the graph) ──

/** A single template entity. Carries the file content as `schema:text`. */
export const TemplateEntitySchema = z.object({
  uri: z.string().min(1),
  encodingFormat: z.string().min(1),
  text: z.string(),
});
export type TemplateEntity = z.infer<typeof TemplateEntitySchema>;

/** The composed manifest, after dereferencing all template entities. */
export const ProjectManifestSchema = z.object({
  uri: z.string().regex(/^urn:dkg:project:/, 'manifest URI must be urn:dkg:project:<cgId>:manifest'),
  contextGraphId: z.string().min(1),
  title: z.string().optional(),
  requiresMcpDkgVersion: z.string().optional(),
  supportedTools: z.array(z.enum(['cursor', 'claude-code'])).min(1),
  network: z.enum(['testnet', 'mainnet', 'devnet']),
  publishedBy: z.string().optional(),         // curator agent URI
  publishedAt: z.string().datetime().optional(),
  ontologyUri: z.string().min(1).optional(),  // points at meta/project-ontology

  // Template entities — referenced by URI, carry the file text inline
  // once dereferenced. Optional fields stay undefined for tools the
  // project doesn't ship templates for (e.g. claude-code-only project
  // would omit cursorHooksTemplate).
  cursorRule:          TemplateEntitySchema.optional(),
  cursorHooksTemplate: TemplateEntitySchema.optional(),
  claudeHooksTemplate: TemplateEntitySchema.optional(),
  configTemplate:      TemplateEntitySchema.optional(),
  agentsMd:            TemplateEntitySchema.optional(),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

// ── URI builders ────────────────────────────────────────────────────

export function manifestUri(contextGraphId: string): string {
  return `urn:dkg:project:${contextGraphId}:manifest`;
}

export function templateUri(contextGraphId: string, slug: TemplateField): string {
  return `urn:dkg:project:${contextGraphId}:manifest:${slug}`;
}

// ── Substitution helper ─────────────────────────────────────────────

/**
 * Apply {{placeholder}} substitution to a template body. Unknown
 * placeholders are left as literal text — fail-soft, by design.
 */
export function substitutePlaceholders(
  body: string,
  values: Partial<Record<ManifestPlaceholder, string>>,
): string {
  let out = body;
  for (const ph of MANIFEST_PLACEHOLDERS) {
    const v = values[ph];
    if (v == null) continue;
    out = out.split(`{{${ph}}}`).join(v);
  }
  return out;
}
