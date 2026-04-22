/**
 * `.dkg/config.yaml` loader. This file is the spec-canonical way a DKG
 * workspace tells agents how to connect to the local daemon and which
 * project to target (see dkgv10-spec 22_AGENT_ONBOARDING §2.1).
 *
 * The MCP server walks upwards from the current working directory looking
 * for the first `.dkg/config.yaml` it can find. Everything is overridable
 * by environment variables so npx-style installs that live outside a
 * workspace can still point at something:
 *
 *   DKG_API          — daemon base URL    (default http://localhost:9200)
 *   DKG_TOKEN        — bearer token       (no default; read-only tools
 *                                          still need it in most setups)
 *   DKG_PROJECT      — contextGraphId     (fallback when .dkg/config.yaml
 *                                          is absent or doesn't pin one)
 *   DKG_AGENT_URI    — this operator's agent URI
 *
 * Anything declared in YAML beats the env defaults; anything passed as a
 * tool argument beats both. This matters on machines with long-running
 * shells: a stale `DKG_PROJECT=foo` exported from last week's session
 * must NOT override today's workspace `.dkg/config.yaml` and silently
 * point the MCP server at the wrong project. If you actually want env
 * to win, unset the file value or launch the server outside a
 * `.dkg`-bearing workspace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface DkgConfig {
  /** Base URL of the local DKG daemon. */
  api: string;
  /** Bearer token for the daemon. May be empty for fully-open dev setups. */
  token: string;
  /** Preferred contextGraphId when a tool call doesn't specify one. */
  defaultProject: string | null;
  /** Agent URI that represents *this* operator (for write-tool attribution). */
  agentUri: string | null;
  /** Chat capture defaults surfaced as resources for the hook to consume. */
  capture: {
    /** Auto-promote newly written chat turns to SWM. */
    autoShare: boolean;
    /** Session default privacy — mirrors `.dkg/config.yaml`. */
    defaultPrivacy: 'private' | 'team' | 'public';
    /** Sub-graph name where chat is stored; default `chat`. */
    subGraph: string;
    /** Assertion name for chat turns; default `chat-log`. */
    assertion: string;
  };
  /** Where the config was actually loaded from, for diagnostics. */
  sourcePath: string | null;
}

const DEFAULT_API = 'http://localhost:9200';

/**
 * Expand a leading `~/` (or bare `~`) to the user's home directory.
 * Anything else is returned unchanged. Mirrors what most shells do —
 * we need it because YAML config files commonly use `~/...` paths but
 * `path.resolve` and `path.isAbsolute` treat `~` as a regular char.
 */
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Walk upwards from `start` looking for `.dkg/config.yaml`. */
function findConfigFile(start: string): string | null {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.dkg', 'config.yaml');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveTokenFromFile(filePath: string): string | null {
  const raw = readIfExists(filePath);
  if (raw == null) return null;
  const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return line ? line.trim() : null;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return fallback;
}

function asPrivacy(v: unknown): 'private' | 'team' | 'public' {
  const s = asString(v);
  if (s === 'private' || s === 'team' || s === 'public') return s;
  return 'team';
}

/**
 * Load `.dkg/config.yaml` from cwd (or up the tree) and overlay environment
 * variables. Never throws — a missing/broken config just falls back to env
 * + defaults, which is fine for tools that don't need auth.
 */
export function loadConfig(cwd: string = process.cwd()): DkgConfig {
  const envApi = asString(process.env.DKG_API) ?? asString(process.env.DEVNET_API);
  const envToken = asString(process.env.DKG_TOKEN) ?? asString(process.env.DEVNET_TOKEN) ?? asString(process.env.DKG_AUTH);
  const envProject = asString(process.env.DKG_PROJECT);
  const envAgent = asString(process.env.DKG_AGENT_URI);

  let fromFile: Record<string, unknown> = {};
  let sourcePath: string | null = null;
  const configPath = findConfigFile(cwd);
  if (configPath) {
    sourcePath = configPath;
    const raw = readIfExists(configPath);
    if (raw) {
      try {
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === 'object') {
          fromFile = parsed as Record<string, unknown>;
        }
      } catch (err) {
        // Malformed YAML is not fatal — we just ignore it and log to stderr
        // so the user sees the problem without blocking the server startup.
        process.stderr.write(
          `[mcp-dkg] warning: could not parse ${configPath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  const node = (fromFile.node && typeof fromFile.node === 'object') ? fromFile.node as Record<string, unknown> : {};
  const agent = (fromFile.agent && typeof fromFile.agent === 'object') ? fromFile.agent as Record<string, unknown> : {};
  const capture = (fromFile.capture && typeof fromFile.capture === 'object') ? fromFile.capture as Record<string, unknown> : {};

  // Token resolution priority (file wins):
  //   .dkg/config.yaml node.token (literal)
  //   → .dkg/config.yaml node.tokenFile (path; `~/…` expanded,
  //     relative resolved against the config's dir)
  //   → env DKG_TOKEN / DEVNET_TOKEN / DKG_AUTH
  //   → fail-open (empty token)
  //
  // tokenFile path expansion: `~/...` → `<homedir>/...`, then absolute paths
  // are taken verbatim, then relative paths are resolved against the
  // config file's directory. Without `~` expansion, a config that says
  // `tokenFile: ~/.dkg/auth.token` ends up trying to read
  // `<workspace>/.dkg/~/.dkg/auth.token` and silently fails (token=empty
  // → every write 401s). The capture-chat hook had the same bug; fixed
  // there too.
  let token: string | null = asString(node.token);
  if (!token) {
    const tokenFileRaw = asString(node.tokenFile);
    if (tokenFileRaw && sourcePath) {
      const expanded = expandHome(tokenFileRaw);
      const abs = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(path.dirname(sourcePath), expanded);
      token = resolveTokenFromFile(abs);
    }
  }
  if (!token) token = envToken;

  // File wins over env for project/api/agent too — env is only used as
  // a fallback when the workspace file doesn't pin the value. This
  // prevents a stale `DKG_PROJECT` export from silently overriding the
  // on-disk workspace binding.
  const project = asString(fromFile.contextGraph)
    ?? asString(fromFile.project)
    ?? envProject
    ?? null;

  return {
    api: asString(node.api) ?? envApi ?? DEFAULT_API,
    token: token ?? '',
    defaultProject: project,
    agentUri: asString(agent.uri) ?? envAgent ?? null,
    capture: {
      autoShare: asBool(fromFile.autoShare ?? capture.autoShare, true),
      defaultPrivacy: asPrivacy(capture.privacy ?? capture.defaultPrivacy),
      subGraph: asString(capture.subGraph) ?? 'chat',
      assertion: asString(capture.assertion) ?? 'chat-log',
    },
    sourcePath,
  };
}

/**
 * Small summary blob the stdio-MCP server logs at startup. Useful when
 * diagnosing "why does my agent not see any projects" complaints.
 */
export function describeConfig(cfg: DkgConfig): string {
  const pieces = [
    `api=${cfg.api}`,
    cfg.sourcePath ? `config=${cfg.sourcePath}` : 'config=<none>',
    cfg.defaultProject ? `project=${cfg.defaultProject}` : 'project=<unset>',
    cfg.agentUri ? `agent=${cfg.agentUri}` : 'agent=<unset>',
    cfg.token ? 'token=[set]' : 'token=[empty]',
  ];
  return pieces.join(' · ');
}
