/**
 * Workspace configuration loader (spec §22 — AGENT_ONBOARDING).
 *
 * Discovers the active workspace's DKG configuration using the three-step
 * priority order documented in the spec:
 *
 *   1. `<workspace>/.dkg/config.yaml`       (preferred)
 *   2. `<workspace>/.dkg/config.json`       (machine-generated fallback)
 *   3. `<workspace>/AGENTS.md` YAML frontmatter under a top-level `dkg:` key
 *
 * The loader performs schema validation, applies defaults, and returns a
 * normalised `WorkspaceConfig` so the rest of the agent can consume a
 * stable shape regardless of source file. See A-13 in
 * `.test-audit/BUGS_FOUND.md` for the audit context that motivated this
 * module.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const EXTRACTION_POLICIES = new Set([
  'structural-only',
  'structural-plus-semantic',
  'semantic-required',
] as const);

export type ExtractionPolicy = 'structural-only' | 'structural-plus-semantic' | 'semantic-required';

export interface WorkspaceConfig {
  contextGraph: string;
  node: string;
  autoShare: boolean;
  extractionPolicy: ExtractionPolicy;
}

export interface LoadedWorkspaceConfig {
  source: string;
  cfg: WorkspaceConfig;
}

/**
 * Validate a raw parsed config object and apply defaults. Throws with a
 * descriptive error if the schema is violated.
 */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('workspace config: root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const contextGraph = obj.contextGraph;
  const node = obj.node;
  if (typeof contextGraph !== 'string' || contextGraph.length === 0) {
    throw new Error('workspace config: `contextGraph` is required (string)');
  }
  if (typeof node !== 'string' || node.length === 0) {
    throw new Error('workspace config: `node` is required (string)');
  }
  const autoShare = obj.autoShare ?? true;
  if (typeof autoShare !== 'boolean') {
    throw new Error('workspace config: `autoShare` must be boolean');
  }
  const extractionPolicy = (obj.extractionPolicy as string | undefined) ?? 'structural-plus-semantic';
  if (!EXTRACTION_POLICIES.has(extractionPolicy as ExtractionPolicy)) {
    throw new Error(
      `workspace config: \`extractionPolicy\` must be one of ${[...EXTRACTION_POLICIES].join(', ')}`,
    );
  }
  return {
    contextGraph,
    node,
    autoShare,
    extractionPolicy: extractionPolicy as ExtractionPolicy,
  };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * PR #229 bot review (post-v10-rc-merge, r21-4): also accept a fenced
 * code block tagged with the `dkg-config` info-string anywhere in
 * the document. The repo's own `AGENTS.md` (and the wider AGENTS.md
 * convention popularised by Cursor / Continue / Codex CLI) is plain
 * Markdown WITHOUT YAML frontmatter, so the frontmatter-only third
 * tier is unusable for the projects that actually rely on AGENTS.md
 * as their workspace-config carrier. By recognising
 *
 *   ```dkg-config
 *   contextGraph: my-project
 *   node: http://127.0.0.1:9201
 *   ```
 *
 * (or `yaml dkg-config` / `json dkg-config` for editors that want
 * syntax highlighting), `loadWorkspaceConfig` works on plain
 * Markdown agent files without forcing the project to add a YAML
 * frontmatter block that would also need to be hidden in every
 * Markdown renderer downstream.
 *
 * The fence info-string is the discriminator (NOT a heading or
 * proximity rule) so the parser stays oblivious to surrounding
 * prose, embedded snippets, and code samples. The first matching
 * fence wins; later ones are ignored so a project can demote a
 * draft block by renaming the info-string to something else.
 */
const DKG_CONFIG_FENCE_RE =
  /(^|\n)```(?:\s*(?:yaml|yml|json)\s+)?dkg-config\s*\r?\n([\s\S]*?)\r?\n```/i;

/**
 * Extract the `dkg:` workspace config from an AGENTS.md file. Tries:
 *   1. YAML frontmatter (`---\n…\n---\n`) with a top-level `dkg:` key
 *      (canonical spec §22 shape).
 *   2. A fenced code block tagged ```dkg-config``` (or ```yaml
 *      dkg-config``` / ```json dkg-config```) anywhere in the
 *      document — supports the plain-Markdown AGENTS.md convention
 *      that the rest of the AI-coding-agent ecosystem uses.
 *
 * Throws a descriptive error if neither carrier is present so an
 * adopter who genuinely intended to embed config but mistyped the
 * fence info-string sees a real diagnostic instead of "no workspace
 * configuration found".
 */
export function parseAgentsMdFrontmatter(src: string): WorkspaceConfig {
  // Bot review (PR #229 r22-5, workspace-config.ts:125): the previous
  // revision threw as soon as YAML frontmatter existed without a top-
  // level `dkg:` key, which meant any AGENTS.md that already uses
  // frontmatter for OTHER tooling (tags, owner, prompt metadata —
  // extremely common in the AI-agent ecosystem we're integrating with)
  // could never use the documented ```dkg-config``` fence fallback.
  // The contract from the JSDoc above is "frontmatter OR fence";
  // honour it by treating frontmatter-without-`dkg` as "keep looking"
  // and only erroring after BOTH carriers have been checked.
  const fm = FRONTMATTER_RE.exec(src);
  if (fm) {
    const parsed = yaml.load(fm[1]) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object' && 'dkg' in parsed) {
      return parseWorkspaceConfig(parsed.dkg);
    }
  }
  const fence = DKG_CONFIG_FENCE_RE.exec(src);
  if (fence) {
    // The fenced block speaks the same shape as `.dkg/config.yaml`
    // / `.dkg/config.json` directly (NOT the frontmatter shape that
    // wraps the schema under a top-level `dkg:` key) so the body of
    // the fence is identical to a standalone config file. This
    // keeps the three carriers symmetric and avoids forcing
    // AGENTS.md authors to add an indentation level.
    const body = fence[2];
    let parsed: unknown;
    try {
      parsed = yaml.load(body);
    } catch (err) {
      throw new Error(
        `AGENTS.md \`dkg-config\` fenced block did not parse as YAML/JSON: ${(err as Error).message}`,
      );
    }
    return parseWorkspaceConfig(parsed);
  }
  if (fm) {
    // Frontmatter was present but did not carry `dkg:`, and no fenced
    // fallback exists either. Surface a diagnostic that tells the
    // adopter exactly which carriers we tried so they don't have to
    // guess whether the fence info-string or the frontmatter key is
    // the mistyped one.
    throw new Error(
      'AGENTS.md: frontmatter is present but has no top-level `dkg:` '
        + 'key, and no fenced code block tagged ```dkg-config``` was '
        + 'found either — add one of those two carriers to expose the '
        + 'workspace config.',
    );
  }
  throw new Error(
    'AGENTS.md: no workspace config found — expected either YAML '
      + 'frontmatter with a top-level `dkg:` key, or a fenced code block '
      + 'tagged ```dkg-config```.',
  );
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace config from `workspaceDir`, following spec §22
 * priority order. Returns the path of the source file alongside the
 * validated config. Throws if no recognised config is found.
 */
export function loadWorkspaceConfig(workspaceDir: string): LoadedWorkspaceConfig {
  const yml = join(workspaceDir, '.dkg', 'config.yaml');
  if (pathExists(yml)) {
    const parsed = yaml.load(readFileSync(yml, 'utf8'));
    return { source: yml, cfg: parseWorkspaceConfig(parsed) };
  }
  const jsn = join(workspaceDir, '.dkg', 'config.json');
  if (pathExists(jsn)) {
    const parsed = JSON.parse(readFileSync(jsn, 'utf8'));
    return { source: jsn, cfg: parseWorkspaceConfig(parsed) };
  }
  const md = join(workspaceDir, 'AGENTS.md');
  if (pathExists(md)) {
    return { source: md, cfg: parseAgentsMdFrontmatter(readFileSync(md, 'utf8')) };
  }
  throw new Error(
    `loadWorkspaceConfig: no workspace configuration found under ${workspaceDir}`,
  );
}
