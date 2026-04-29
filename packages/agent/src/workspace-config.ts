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
 * `.test-audit/
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

/**
 * Normalised shape of the `node:` field in a workspace config.
 *
 * The canonical `.dkg/config.yaml` (see `packages/mcp-dkg/config.yaml.example`
 * and `packages/mcp-dkg/src/config.ts`) declares `node` as an OBJECT with
 * `api`, `tokenFile`, and friends — that's what every running daemon and the
 * existing capture-chat hook already consume. The earlier draft of this
 * loader accepted ONLY a bare-string `node:` field, which made
 * `loadWorkspaceConfig()` throw on every real workspace config it
 * encountered.
 *
 * We now accept BOTH shapes and always return the structured form so
 * downstream callers can read `cfg.node.api` / `cfg.node.tokenFile` without
 * branching:
 *
 *   - `node: "http://127.0.0.1:9201"`  → `{ api: "http://127.0.0.1:9201" }`
 *   - `node: { api: "...", tokenFile: "..." }` → preserved verbatim
 */
export interface WorkspaceConfigNode {
  api: string;
  tokenFile?: string;
  token?: string;
}

export interface WorkspaceConfig {
  contextGraph: string;
  node: WorkspaceConfigNode;
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
 *
 * the spec section §22
 * pinned `node:` as a bare string, but the canonical
 * `.dkg/config.yaml` shape that the rest of the toolchain (mcp-dkg loader,
 * capture-chat hook, README example) consumes uses an OBJECT here — so the
 * old strict-string check threw on every real workspace config and the
 * loader was unusable in practice. Accept both forms; normalise to the
 * structured `WorkspaceConfigNode` shape so consumers don't have to branch.
 */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('workspace config: root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const contextGraph = obj.contextGraph;
  if (typeof contextGraph !== 'string' || contextGraph.length === 0) {
    throw new Error('workspace config: `contextGraph` is required (string)');
  }
  const node = parseNodeField(obj.node);
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

/**
 * Coerce the user-supplied `node:` field into the normalised
 * `WorkspaceConfigNode` shape. Accepts:
 *   - a bare API-URL string  (legacy spec §22 form)
 *   - an object with `api` + optional `tokenFile` / `token`  (canonical
 *     `.dkg/config.yaml` form used by mcp-dkg)
 *
 * Anything else (numbers, booleans, missing field, empty string, missing
 * `api` on an object) is rejected with a descriptive message so misshapen
 * configs surface a real error rather than silently becoming `undefined`
 * downstream.
 */
function parseNodeField(node: unknown): WorkspaceConfigNode {
  if (typeof node === 'string') {
    if (node.length === 0) {
      throw new Error('workspace config: `node` is required (string or {api})');
    }
    return { api: node };
  }
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    const api = n.api;
    if (typeof api !== 'string' || api.length === 0) {
      throw new Error(
        'workspace config: `node.api` is required when `node` is an object',
      );
    }
    const out: WorkspaceConfigNode = { api };
    if (typeof n.tokenFile === 'string' && n.tokenFile.length > 0) {
      out.tokenFile = n.tokenFile;
    }
    if (typeof n.token === 'string' && n.token.length > 0) {
      out.token = n.token;
    }
    return out;
  }
  throw new Error('workspace config: `node` is required (string or {api})');
}

// the original regex required a trailing newline AFTER the closing
// `---`, so a valid AGENTS.md whose entire body is just the YAML
// frontmatter — or whose frontmatter block is the LAST thing in the
// file (very common when authors save without a final newline) —
// would never match and `loadWorkspaceConfig` would silently fall
// through to the "no carriers found" error.
//
// Make the trailing newline optional. The closing fence can be
// followed by a newline + body (the typical case), or by EOF (the
// frontmatter-only / no-final-newline case).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * also accept a fenced
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
// the previous mega-regex
//   /(^|\n)```(?:\s*(?:yaml|yml|json)\s+)?dkg-config\s*\r?\n([\s\S]*?)\r?\n```/i
// combined a lazy `[\s\S]*?` body with a non-anchored opening
// (`(^|\n)`) and an optional sub-pattern (`(?:\s*…\s+)?`). On a
// pathological input shaped like `\n``` dkg-config\n` followed by
// many lines that LOOK like fences but aren't (`\n   `, `\n\t`, …),
// the engine repeatedly retried the lazy quantifier from every
// candidate `\n` start, which CodeQL flagged as super-linear.
//
// Replace it with a deterministic line-by-line scan: find the first
// line whose content matches the open-fence shape, then look for the
// next line whose content matches the close-fence shape. Each char
// of the input is now visited a bounded number of times — the whole
// scan is strictly linear and impossible to backtrack.
// workspace-config.ts:130). CommonMark
// allows code-block fences to be indented by up to THREE spaces (anything
// from four onwards reverts to an indented code block). The strict
// column-0 anchor rejected legitimate `dkg-config` blocks that lived
// under a list item, blockquote, or were emitted by a Markdown
// formatter that normalised indentation. The optional `[ ]{0,3}`
// prefix (only ASCII spaces, no tabs — same restriction CommonMark
// uses) accepts the spec-allowed indentation while still rejecting
// 4+ spaces (which is an indented code block, not a fenced one) and
// any tab-indented variant.
const OPEN_FENCE_LINE_RE = /^ {0,3}```(?:\s*(?:yaml|yml|json))?\s*dkg-config\s*$/i;
const CLOSE_FENCE_LINE_RE = /^ {0,3}```\s*$/;

/**
 * Find the body of the first ```dkg-config``` (or
 * ```yaml dkg-config``` / ```json dkg-config```) fenced block.
 * Returns `undefined` when no such fence exists. The scan is a
 * deterministic single pass over the input lines (no regex
 * backtracking on the body), so it is safe against the pathological
 * inputs CodeQL flagged on the previous mega-regex.
 *
 * If an opening fence is found but no matching closing fence
 * follows, returns `undefined` (treated as "no fence present"); the
 * caller then falls through to the standard "no carrier found"
 * diagnostic, which is the right behaviour for an unterminated
 * block.
 */
function extractDkgConfigFenceBody(src: string): string | undefined {
  const lines = src.split(/\r?\n/);
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OPEN_FENCE_LINE_RE.test(lines[i])) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return undefined;
  for (let j = openIdx + 1; j < lines.length; j++) {
    if (CLOSE_FENCE_LINE_RE.test(lines[j])) {
      return lines.slice(openIdx + 1, j).join('\n');
    }
  }
  return undefined;
}

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
  // the previous
  // revision threw as soon as YAML frontmatter existed without a top-
  // level `dkg:` key, which meant any AGENTS.md that already uses
  // frontmatter for OTHER tooling (tags, owner, prompt metadata —
  // extremely common in the AI-agent ecosystem we're integrating with)
  // could never use the documented ```dkg-config``` fence fallback.
  // The contract from the JSDoc above is "frontmatter OR fence";
  // honour it by treating frontmatter-without-`dkg` as "keep looking"
  // and only erroring after BOTH carriers have been checked.
  //
  // the
  // prior revision called `yaml.load(fm[1])` directly. If the
  // frontmatter is unrelated to DKG and uses a YAML extension or
  // shape that `js-yaml` rejects (a tab-indented block, a bare
  // colon, a custom tag) the parse error bubbled out of the
  // function and the fenced-block fallback never ran — exactly
  // the multi-tool case this logic is supposed to serve. Catch
  // YAML parse errors here and treat the frontmatter as "absent
  // for our purposes"; the ```dkg-config``` fence (or the final
  // diagnostic) carries the loader the rest of the way. We
  // remember that frontmatter WAS present so the trailing error
  // can still surface the more helpful "frontmatter present but
  // no `dkg:` key" diagnostic when neither carrier yields a
  // config.
  const fm = FRONTMATTER_RE.exec(src);
  let frontmatterPresent = !!fm;
  if (fm) {
    try {
      const parsed = yaml.load(fm[1]) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object' && 'dkg' in parsed) {
        return parseWorkspaceConfig(parsed.dkg);
      }
    } catch {
      // Frontmatter is not parseable as YAML — most likely it's
      // intended for a different tool. Fall through to the
      // fenced-block fallback rather than aborting the loader.
      frontmatterPresent = false;
    }
  }
  const fenceBody = extractDkgConfigFenceBody(src);
  if (fenceBody !== undefined) {
    // The fenced block speaks the same shape as `.dkg/config.yaml`
    // / `.dkg/config.json` directly (NOT the frontmatter shape that
    // wraps the schema under a top-level `dkg:` key) so the body of
    // the fence is identical to a standalone config file. This
    // keeps the three carriers symmetric and avoids forcing
    // AGENTS.md authors to add an indentation level.
    const body = fenceBody;
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
  if (frontmatterPresent) {
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
