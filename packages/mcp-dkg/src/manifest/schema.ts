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
  'agentUri',           // urn:dkg:agent:<lowercase-wallet-address> (cryptographic identity)
  'agentNickname',      // human-readable label, e.g. "Brana laptop 1" — lands as rdfs:label
  'agentAddress',       // raw wallet address (lowercase, 0x-prefixed) — convenience for tools that prefer it
  'agentSlug',          // BACK-COMPAT alias for agentNickname (slug-shaped, e.g. "brana-laptop-1")
  'contextGraphId',     // the project's CG ID (e.g. dkg-code-project)
  'daemonApiUrl',       // local daemon API (default http://localhost:9200)
  'daemonTokenFile',    // relative path to auth.token (e.g. ../.devnet/node1/auth.token)
  'workspaceAbsPath',   // absolute path of the operator's workspace
  'mcpDkgDistAbsPath',  // absolute path to packages/mcp-dkg/dist/index.js (LEGACY — kept for older templates)
  'mcpDkgPackageDir',   // absolute path to packages/mcp-dkg — used to run `pnpm --dir … exec tsx src/index.ts` on the TS source (dist/ is gitignored)
  'mcpDkgSrcAbsPath',   // absolute path to packages/mcp-dkg/src/index.ts — passed to tsx so we don't depend on CWD
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
 * POSIX shell single-quoting: wraps `v` so it's safe to paste literally
 * into a shell command line. A single quote inside the value is closed,
 * escaped as `\'`, and reopened — the canonical POSIX trick that works
 * in every sh-family shell (bash, zsh, dash, sh).
 *
 * Used by the `{{sh:...}}` placeholder form so hook-command templates
 * can safely embed operator-supplied values (absolute paths, URLs,
 * nicknames) without shell metacharacters like `$(...)`, backticks,
 * spaces, or quotes being interpreted by the user's shell.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * JSON string-literal encoding: `JSON.stringify(v)` produces a
 * double-quoted, fully-escaped string that is valid in both JSON and
 * YAML (YAML accepts JSON scalars as "flow" scalars). Used by the
 * `{{json:...}}` placeholder form for free-form values like
 * `agentNickname` that operators can set to arbitrary UTF-8 and could
 * otherwise break the generated `.cursor/mcp.json` or
 * `.dkg/config.yaml`. The placeholder itself emits the surrounding
 * quotes, so the containing template MUST NOT pre-quote it — e.g.
 *   YAML:  `nickname: {{json:agentNickname}}`   ✅
 *   JSON:  `"DKG_AGENT_NICKNAME": {{json:agentNickname}}`  ✅
 */
export function jsonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Apply {{placeholder}} substitution to a template body. Unknown
 * placeholders are left as literal text — fail-soft, by design.
 *
 * Three placeholder forms are supported:
 *   `{{name}}`       — raw substitution; the template is responsible
 *                      for its own quoting (suitable for values we
 *                      control, like absolute paths / CG ids / URIs
 *                      that don't carry YAML-special chars).
 *   `{{sh:name}}`    — POSIX-shell-safe substitution; the value is
 *                      single-quoted and embedded single quotes are
 *                      escaped. Use this for every placeholder that
 *                      ends up inside a shell command line (see
 *                      `CURSOR_HOOKS_TEMPLATE` / `CLAUDE_HOOKS_TEMPLATE`
 *                      in templates.ts). Without this form an attacker
 *                      who controls e.g. `workspaceAbsPath` or
 *                      `daemonApiUrl` could inject arbitrary commands
 *                      into the hook that runs on every Cursor session.
 *   `{{json:name}}`  — JSON-string-literal substitution (emits its own
 *                      surrounding double-quotes). Use this for every
 *                      free-form value that lands inside a JSON or
 *                      YAML scalar — currently `agentNickname`. Raw
 *                      substitution of e.g. `Brana "laptop"` into
 *                      `"DKG_AGENT_NICKNAME": "{{agentNickname}}"`
 *                      would produce `"Brana "laptop""` and break the
 *                      JSON parser.
 */
export function substitutePlaceholders(
  body: string,
  values: Partial<Record<ManifestPlaceholder, string>>,
): string {
  let out = body;
  for (const ph of MANIFEST_PLACEHOLDERS) {
    const v = values[ph];
    if (v == null) continue;
    // Order matters: replace the most specific form first so
    // `{{sh:name}}` doesn't get eaten by the `{{name}}` pass when the
    // raw value itself contains the literal substring `{{sh:name}}`.
    out = out.split(`{{sh:${ph}}}`).join(shellSingleQuote(v));
    out = out.split(`{{json:${ph}}}`).join(jsonStringLiteral(v));
    out = out.split(`{{${ph}}}`).join(v);
  }
  return out;
}
