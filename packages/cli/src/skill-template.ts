/**
 * SKILL.md template rendering — the ONE boundary every delivery surface goes
 * through (GH#1125, PR #2331 review).
 *
 * Package-level, not under daemon/: this artifact serves the daemon endpoint
 * AND the non-daemon `dkg mcp setup` / `dkg hermes setup` flows, so setup
 * commands must not have to reach into a daemon implementation directory for
 * it. Daemon and setup are peers here.
 *
 * `skills/dkg-node/SKILL.md` has two delivery modes and they must not diverge:
 *
 *   1. SERVED, by the daemon at `/.well-known/skill.md`, with live node state.
 *   2. DELIVERED, as a standalone file copied into a client's skill directory
 *      by `dkg mcp setup` / `dkg hermes setup`. There is no node context there.
 *
 * The template carries named `{{token}}` values. Extracting this module out of
 * `manifest.ts` (a catch-all that had grown past 1,000 lines) gives the
 * subsystem an owner, and — more importantly — makes it impossible to reach the
 * raw template without choosing a render mode. Handing the raw file to a client
 * is what would ship `{{nodeVersion}}` into a user's skill directory.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The token contract, as ONE source of truth.
 *
 * Required token names are derived from this object's keys, so the template,
 * the substitution map and the validator cannot drift apart — the previous
 * shape kept a separate array that could silently disagree (PR #2331 review).
 */
export interface SkillTokenValues {
  nodeVersion: string;
  baseUrl: string;
  peerId: string;
  nodeRole: string;
  extractionPipelines: string;
}

/**
 * Static text for the STANDALONE copy, which has no node to describe. Prose
 * rather than an internal placeholder: a reader of a delivered skill file
 * should get an instruction, not a broken-looking template artifact.
 */
export const STANDALONE_SKILL_VALUES: SkillTokenValues = Object.freeze({
  nodeVersion: "_(run `dkg --version` on your node)_",
  baseUrl: "_(your node's API base URL — `http://localhost:9200` by default)_",
  peerId: "_(run `dkg status` on your node)_",
  nodeRole: "_(`core` or `edge` — run `dkg status`)_",
  extractionPipelines: "_(depends on installed converters — run `dkg status`)_",
});

export const REQUIRED_SKILL_TOKENS: ReadonlyArray<keyof SkillTokenValues> =
  Object.freeze(Object.keys(STANDALONE_SKILL_VALUES) as Array<keyof SkillTokenValues>);

const TOKEN_RE = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g;

let cachedSkillMd: string | null = null;

export function loadSkillTemplate(): string {
  if (cachedSkillMd) return cachedSkillMd;
  const skillPath = new URL("../skills/dkg-node/SKILL.md", import.meta.url);
  cachedSkillMd = readFileSync(skillPath, "utf-8");
  return cachedSkillMd;
}

/** Required tokens the template is missing. */
export function missingSkillTokens(template: string = loadSkillTemplate()): string[] {
  return REQUIRED_SKILL_TOKENS.filter((t) => !template.includes(`{{${t}}}`));
}

/**
 * Tokens the template uses that nothing supplies. Without this, adding
 * `{{networkId}}` to SKILL.md would render it verbatim into the served doc and
 * `missingSkillTokens()` would still report a clean bill of health.
 */
export function unknownSkillTokens(template: string = loadSkillTemplate()): string[] {
  const known = new Set<string>(REQUIRED_SKILL_TOKENS as ReadonlyArray<string>);
  const found = new Set<string>();
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(template)) !== null) {
    if (!known.has(m[1]!)) found.add(m[1]!);
  }
  return [...found].sort();
}

/**
 * Substitute every token, LITERALLY.
 *
 * The replacement is a function on purpose. `String.replace(needle, string)`
 * interprets `$&`, `$'`, "$`" and `$n` in the replacement, and `baseUrl` is
 * derived from the `X-Forwarded-Host` / `Host` request headers on a public,
 * unauthenticated endpoint. Before this was a callback, a crafted Host could
 * re-insert the placeholder block or append the ~94 KB template suffix per
 * `$'`, giving unbounded response amplification. Do not turn it back into a
 * string.
 */
export function renderSkillTemplate(values: SkillTokenValues, template = loadSkillTemplate()): string {
  let out = template;
  for (const token of REQUIRED_SKILL_TOKENS) {
    const value = values[token];
    out = out.replaceAll(`{{${token}}}`, () => value);
  }
  return out;
}

/** SERVED mode — live node state, for `/.well-known/skill.md`. */
export function buildSkillMd(opts: {
  version: string;
  baseUrl: string;
  peerId: string;
  nodeRole: string;
  extractionPipelines: string[];
}): string {
  return renderSkillTemplate({
    nodeVersion: opts.version,
    baseUrl: opts.baseUrl,
    peerId: opts.peerId,
    nodeRole: opts.nodeRole,
    extractionPipelines:
      opts.extractionPipelines.length > 0
        ? opts.extractionPipelines.join(", ")
        : "none (install markitdown to enable document conversion)",
  });
}

/**
 * DELIVERED mode — the standalone artifact copied into a client's skill
 * directory. Every caller that used to read the bundled file directly must go
 * through this, or it ships raw `{{token}}` syntax to end users.
 */
export function renderStandaloneDkgNodeSkill(): string {
  return renderSkillTemplate(STANDALONE_SKILL_VALUES);
}

export function skillEtag(content: string): string {
  return '"' + createHash("md5").update(content).digest("hex").slice(0, 16) + '"';
}
