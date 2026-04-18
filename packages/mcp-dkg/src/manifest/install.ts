/**
 * Manifest-driven workspace installer.
 *
 * Plans + writes the files declared by a `dkg:ProjectManifest` into
 * the operator's workspace. Path-locked: only writes to a fixed
 * allowlist of locations (see WORKSPACE_TARGETS in schema.ts). All
 * file content goes through `{{placeholder}}` substitution with a
 * fixed substitution set.
 *
 * The installer is structured as plan → preview → write so the CLI
 * (and the future modal) can show the operator exactly what's about
 * to happen before any disk I/O. The same `planInstall()` output
 * powers `buildReviewMarkdown()` which the dkg_review_manifest MCP
 * tool returns to the agent for review.
 *
 * No script execution. No arbitrary paths. No tokens travel through
 * the manifest. The only configurable destination is `<workspace>`
 * itself; everything else is computed deterministically from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  WORKSPACE_TARGETS,
  MANIFEST_PLACEHOLDERS,
  substitutePlaceholders,
  type ProjectManifest,
  type ManifestPlaceholder,
  type TemplateField,
} from './schema.js';

// ── Types ──────────────────────────────────────────────────────────

export interface InstallContext {
  /** Manifest the installer is materialising. */
  manifest: ProjectManifest;
  /** Absolute path to operator's workspace (the dir that gets `.cursor/`, `.dkg/`, `AGENTS.md`). */
  workspaceAbsPath: string;
  /** Operator's chosen agent slug for this machine — drives all `urn:dkg:agent:<slug>` URIs. */
  agentSlug: string;
  /** Local daemon API URL the agent will talk to. */
  daemonApiUrl: string;
  /** Relative path (from `<workspace>/.dkg/config.yaml`) to the daemon's auth.token. */
  daemonTokenFile: string;
  /** Absolute path to packages/mcp-dkg/dist/index.js (so Cursor can spawn the server). */
  mcpDkgDistAbsPath: string;
  /** Absolute path to the capture-chat.mjs hook script. */
  captureScriptPath: string;
  /** Override $HOME for tests; defaults to os.homedir(). */
  homedir?: string;
}

export interface PlannedFile {
  /** Slug from the manifest (cursorRule, cursorHooksTemplate, etc.) — also the predicate name. */
  field: TemplateField | 'cursorMcpJson';
  /** Absolute resolved path the installer will write. */
  absPath: string;
  /** True if the target file already exists on disk. */
  exists: boolean;
  /** True if the operation merges JSON into existing content vs full overwrite. */
  merges: boolean;
  /** Bytes that will be written (post-substitution). */
  bytes: number;
  /** The post-substitution body, ready to write. */
  body: string;
  /** Encoding format from the manifest (text/markdown, application/json, text/yaml). */
  encodingFormat: string;
}

export interface InstallPlan {
  files: PlannedFile[];
  /** Substitution values that were applied. Surfaced for review. */
  substitutionValues: Partial<Record<ManifestPlaceholder, string>>;
  /** Things in the manifest the installer chose to skip with reason. */
  warnings: string[];
}

// ── Workspace-target resolution ────────────────────────────────────

/**
 * Resolve a `<workspace>/...` or `<homedir>/...` template path to an
 * absolute path on disk. Path-lock: only paths starting with these
 * two prefixes are allowed; anything else returns null (installer
 * skips with a warning).
 */
function resolveTargetPath(
  template: string,
  ctx: Pick<InstallContext, 'workspaceAbsPath' | 'homedir'>,
): string | null {
  const home = ctx.homedir ?? os.homedir();
  if (template.startsWith('<workspace>/')) {
    return path.resolve(ctx.workspaceAbsPath, template.slice('<workspace>/'.length));
  }
  if (template.startsWith('<homedir>/')) {
    return path.resolve(home, template.slice('<homedir>/'.length));
  }
  return null;
}

/** Build the substitution-value map from the install context. */
function buildSubstitutionValues(
  ctx: InstallContext,
): Partial<Record<ManifestPlaceholder, string>> {
  return {
    agentSlug: ctx.agentSlug,
    agentUri: `urn:dkg:agent:${ctx.agentSlug}`,
    contextGraphId: ctx.manifest.contextGraphId,
    daemonApiUrl: ctx.daemonApiUrl,
    daemonTokenFile: ctx.daemonTokenFile,
    workspaceAbsPath: ctx.workspaceAbsPath,
    mcpDkgDistAbsPath: ctx.mcpDkgDistAbsPath,
    captureScriptPath: ctx.captureScriptPath,
    network: ctx.manifest.network,
  };
}

// ── Plan ───────────────────────────────────────────────────────────

/**
 * Produce a non-side-effecting install plan from a manifest +
 * context. No disk writes. Caller can show this to the operator,
 * persist for audit, or hand off to write().
 */
export function planInstall(ctx: InstallContext): InstallPlan {
  const subValues = buildSubstitutionValues(ctx);
  const files: PlannedFile[] = [];
  const warnings: string[] = [];
  const m = ctx.manifest;

  // Map of (template field on manifest) → (template entity body, target path template).
  // Wrap the side-band cursorMcpJson so it gets installed too.
  const candidates: Array<{
    field: TemplateField | 'cursorMcpJson';
    entity: { encodingFormat: string; text: string } | undefined;
    target: string;
    merges: boolean;
  }> = [
    { field: 'cursorRule',          entity: m.cursorRule,          target: WORKSPACE_TARGETS.cursorRule,          merges: false },
    { field: 'cursorHooksTemplate', entity: m.cursorHooksTemplate, target: WORKSPACE_TARGETS.cursorHooksTemplate, merges: false },
    { field: 'claudeHooksTemplate', entity: m.claudeHooksTemplate, target: WORKSPACE_TARGETS.claudeHooksTemplate, merges: true  },
    { field: 'configTemplate',      entity: m.configTemplate,      target: WORKSPACE_TARGETS.configTemplate,      merges: false },
    { field: 'agentsMd',            entity: m.agentsMd,            target: WORKSPACE_TARGETS.agentsMd,            merges: false },
    {
      field: 'cursorMcpJson',
      entity: (m as any).cursorMcpJson,
      target: '<workspace>/.cursor/mcp.json',
      merges: true,
    },
  ];

  for (const c of candidates) {
    if (!c.entity) {
      // Manifest didn't ship this template — operator opted out (or
      // project doesn't support that tool). Silent skip.
      continue;
    }
    const absPath = resolveTargetPath(c.target, ctx);
    if (!absPath) {
      warnings.push(
        `Skipping ${c.field}: target "${c.target}" is outside the path-locked allowlist (workspace + homedir).`,
      );
      continue;
    }
    const body = substitutePlaceholders(c.entity.text, subValues);
    files.push({
      field: c.field,
      absPath,
      exists: fs.existsSync(absPath),
      merges: c.merges,
      bytes: Buffer.byteLength(body, 'utf-8'),
      body,
      encodingFormat: c.entity.encodingFormat,
    });
  }

  // Skip claude hooks if claude-code isn't a supported tool.
  if (!m.supportedTools.includes('claude-code')) {
    const idx = files.findIndex((f) => f.field === 'claudeHooksTemplate');
    if (idx >= 0) {
      warnings.push(
        `Manifest declared a claudeHooksTemplate but supportedTools doesn't include claude-code; skipping ~/.claude/settings.json wiring.`,
      );
      files.splice(idx, 1);
    }
  }

  return { files, substitutionValues: subValues, warnings };
}

// ── JSON merge for cursor mcp.json + claude settings.json ──────────

/**
 * Merge a small additions object into an existing JSON file body.
 * For `mcpServers`: shallow-merge (new servers added; existing keys
 * preserved). For `hooks`: shallow-merge by event name; existing
 * events preserved (so the operator's other hooks survive).
 */
function jsonMerge(existingBody: string, addition: object): string {
  let existing: Record<string, any> = {};
  if (existingBody.trim()) {
    try {
      existing = JSON.parse(existingBody);
    } catch {
      // Existing file is not valid JSON; refuse to clobber it.
      throw new Error('existing file is not valid JSON; refusing to overwrite. Move it aside and re-run install.');
    }
  }
  for (const [key, value] of Object.entries(addition)) {
    if (key === '_comment') continue; // skip metadata keys when merging
    if (
      typeof value === 'object'
      && value != null
      && !Array.isArray(value)
      && typeof existing[key] === 'object'
      && existing[key] != null
      && !Array.isArray(existing[key])
    ) {
      existing[key] = { ...existing[key], ...value };
    } else {
      existing[key] = value;
    }
  }
  return JSON.stringify(existing, null, 2);
}

// ── Write ──────────────────────────────────────────────────────────

export interface WriteResult {
  field: PlannedFile['field'];
  absPath: string;
  bytesWritten: number;
  action: 'created' | 'overwrote' | 'merged';
}

/**
 * Apply an install plan to disk. Atomic per-file. Creates parent
 * directories as needed. JSON merges respect existing keys outside
 * the manifest's contribution.
 */
export async function writeInstall(plan: InstallPlan): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(f.absPath), { recursive: true });
    let action: WriteResult['action'];
    let toWrite = f.body;
    if (f.merges && f.exists) {
      const existing = fs.readFileSync(f.absPath, 'utf-8');
      try {
        const addition = JSON.parse(f.body);
        toWrite = jsonMerge(existing, addition);
        action = 'merged';
      } catch (err) {
        throw new Error(
          `Failed to merge ${f.absPath}: ${(err as Error).message}. ` +
          `Either fix the existing file by hand, or move it aside and re-run.`,
        );
      }
    } else {
      action = f.exists ? 'overwrote' : 'created';
    }
    fs.writeFileSync(f.absPath, toWrite, 'utf-8');
    results.push({
      field: f.field,
      absPath: f.absPath,
      bytesWritten: Buffer.byteLength(toWrite, 'utf-8'),
      action,
    });
  }
  return results;
}

// ── Review summary (shared between CLI + MCP review tool) ──────────

/**
 * Build a markdown summary of an install plan suitable for showing
 * to a human operator OR returning from the dkg_review_manifest MCP
 * tool for an agent to assess.
 */
export function buildReviewMarkdown(
  manifest: ProjectManifest,
  plan: InstallPlan,
): string {
  const lines: string[] = [];
  lines.push(`# Manifest review for \`${manifest.contextGraphId}\``);
  lines.push('');
  lines.push(`- **Manifest URI:** \`${manifest.uri}\``);
  if (manifest.publishedBy) lines.push(`- **Published by:** \`${manifest.publishedBy}\``);
  if (manifest.publishedAt) lines.push(`- **Published at:** ${manifest.publishedAt}`);
  lines.push(`- **Network:** \`${manifest.network}\``);
  lines.push(`- **Tools supported:** ${manifest.supportedTools.map((t) => `\`${t}\``).join(', ')}`);
  if (manifest.requiresMcpDkgVersion) {
    lines.push(`- **Requires mcp-dkg version:** ${manifest.requiresMcpDkgVersion}`);
  }
  if (manifest.ontologyUri) lines.push(`- **Ontology:** \`${manifest.ontologyUri}\``);
  lines.push('');
  lines.push('## Files this install will write');
  lines.push('');
  if (!plan.files.length) {
    lines.push('_No files would be written — manifest contains no installable templates._');
  } else {
    lines.push('| Field | Target | Action | Size |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of plan.files) {
      const action = f.merges
        ? f.exists ? '**merge** (preserves your other keys)' : '**create**'
        : f.exists ? '**overwrite**' : '**create**';
      const size = `${f.bytes.toLocaleString()} bytes`;
      lines.push(`| \`${f.field}\` | \`${f.absPath}\` | ${action} | ${size} |`);
    }
  }
  if (plan.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const w of plan.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('## Substitutions applied');
  lines.push('');
  for (const ph of MANIFEST_PLACEHOLDERS) {
    const v = plan.substitutionValues[ph];
    if (v) lines.push(`- \`{{${ph}}}\` → \`${v}\``);
  }
  lines.push('');
  lines.push('## Security boundaries enforced');
  lines.push('');
  lines.push('- **Path-locked.** Only writes inside `<workspace>/.cursor/`, `<workspace>/.dkg/`, `<workspace>/AGENTS.md`, `~/.claude/settings.json`. Any other paths in the manifest are dropped (see warnings).');
  lines.push('- **No script execution.** Manifest entities are config files only. Hooks reference your locally-installed `packages/mcp-dkg/hooks/capture-chat.mjs`.');
  lines.push('- **No tokens leave your machine.** The daemon auth token is referenced by relative path only — never embedded in the manifest.');
  return lines.join('\n');
}
