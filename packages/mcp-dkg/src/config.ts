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
 *   DKG_HOME         — DKG state directory. When set, config is
 *                      resolved from one of two sources at the
 *                      home:
 *                        1. `<DKG_HOME>/config.json` — the daemon
 *                           config that `dkg mcp setup`'s
 *                           writeDkgConfig writes (apiPort /
 *                           contextGraphs / auth shape). Translated
 *                           to DkgConfig via readHomeFileDefaults:
 *                           `api ← http://localhost:<apiPort>`,
 *                           `token ← <DKG_HOME>/auth.token`'s first
 *                           non-comment line, `defaultProject ←
 *                           contextGraphs[0]`.
 *                        2. `<DKG_HOME>/config.yaml` — workspace-
 *                           shape, parsed via the regular yaml flow.
 *                           Used when an operator hand-writes a
 *                           workspace config at the home directly.
 *                      The cwd-walk is skipped entirely under
 *                      DKG_HOME. Propagated by `dkg mcp setup` via
 *                      the MCP entry's `env: { DKG_HOME }` field
 *                      (Round-9 Fix 16) so GUI clients spawning the
 *                      registered command read the same home setup
 *                      just bootstrapped — they don't inherit shell
 *                      env. Operators can also export it from their
 *                      shell. (Round-11 Fix 18 added DKG_HOME-as-
 *                      yaml; Round-19 Fix 25 added json precedence
 *                      via the wrong parser; Round-21 Fix 27
 *                      replaced that with a real daemon-config
 *                      translator.)
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
import { readDkgApiPortSync, resolveDkgHome } from '@origintrail-official/dkg-core';
import { MISSING_TOKEN_HELP } from './auth-diagnostics.js';

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

/** Discovered defaults and credentials belong only to their own local endpoint. */
function matchesDiscoveredHomeEndpoint(api: string | null, homeApi: string): boolean {
  if (!api) return true;
  try {
    const target = new URL(api);
    const home = new URL(homeApi);
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    return target.protocol === home.protocol && target.port === home.port
      && loopback.has(target.hostname) && loopback.has(home.hostname)
      && !target.username && !target.password && target.pathname === '/';
  } catch { return false; }
}

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

/**
 * Locate a workspace-shape `.dkg/config.yaml`. When `DKG_HOME` is
 * set, this checks `<DKG_HOME>/config.yaml` directly and returns
 * `null` if it doesn't exist (the cwd-walk is suppressed). When
 * `DKG_HOME` is unset, walks upwards from `start` looking for the
 * spec-canonical `.dkg/config.yaml`.
 *
 * Codex Round-21 Fix 27: this helper now ONLY handles the
 * workspace-shape yaml. The setup-home daemon-config path (where
 * `dkg mcp setup` writes `<DKG_HOME>/config.json` with apiPort /
 * contextGraphs / auth, NOT the node.api/node.token/project shape
 * loadConfig parses) is handled by `readHomeFileDefaults` in a
 * dedicated translator. Round-19 Fix 25 incorrectly tried to
 * parse the daemon-config JSON with the workspace-yaml extractor
 * — every field name mismatched, so the translation extracted
 * nothing and the post-setup path 401'd.
 */
function findConfigFile(start: string): string | null {
  const dkgHome = process.env.DKG_HOME?.trim() || null;
  if (dkgHome) {
    const candidate = path.join(dkgHome, 'config.yaml');
    return fs.existsSync(candidate) ? candidate : null;
  }
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

type HomeFileDefaults = Pick<DkgConfig, 'api' | 'token' | 'defaultProject' | 'sourcePath'>;

/** A configured daemon home has config.json; a token-only home has just auth.token. */
const homeConfigPath = (dkgHome: string) => path.join(dkgHome, 'config.json');

/** Decode daemon-home files only; endpoint selection and precedence belong to loadConfig. */
function readHomeFileDefaults(dkgHome: string): HomeFileDefaults | null {
  const jsonPath = homeConfigPath(dkgHome);
  if (!fs.existsSync(jsonPath)) return null;
  let daemonConfig: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') daemonConfig = parsed as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[mcp-dkg] warning: could not parse ${jsonPath}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const apiPort = typeof daemonConfig.apiPort === 'number' ? daemonConfig.apiPort : 9200;
  const contextGraphs = Array.isArray(daemonConfig.contextGraphs) ? daemonConfig.contextGraphs : [];
  return {
    api: `http://localhost:${apiPort}`,
    token: resolveTokenFromFile(path.join(dkgHome, 'auth.token')) ?? '',
    defaultProject: typeof contextGraphs[0] === 'string' ? contextGraphs[0] : null,
    sourcePath: jsonPath,
  };
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
export function loadConfig(cwd: string = process.cwd(), overrides: { api?: string } = {}): DkgConfig {
  return resolveCredential(cwd, overrides).config;
}

/** Credentials a command selected for itself, on top of normal configuration. */
export interface CredentialChoice {
  /** Endpoint the command contacts; automatic credentials stay bound to their own endpoint. */
  api?: string;
  /** Token selected for this command (`--token`, `DKG_TOKEN`, `DEVNET_TOKEN`). */
  token?: string;
  /** Token file selected for this command (`--token-file`). */
  tokenFile?: string;
  /** Legacy token-only home file. It is automatic, so only its own local endpoint may use it. */
  fallbackTokenFile?: string;
}

export interface ResolvedCredential {
  config: DkgConfig;
  /** File the token was read from; null for a literal, environment or missing token. */
  tokenFile: string | null;
}

/**
 * The single credential resolver. Choices made for this command come first,
 * then a workspace or DKG_HOME binding, then automatic sources: the active
 * node home for this endpoint, then the legacy token-only home at its
 * recorded local port (9200 when unrecorded). A home with config.json is
 * never reached through the legacy file, so a rejected endpoint stays rejected.
 */
export function resolveCredential(cwd: string, choice: CredentialChoice = {}): ResolvedCredential {
  const configured = loadConfiguredCredential(cwd, asString(choice.api));
  const { config } = configured;
  if (choice.token) return { config: { ...config, token: choice.token }, tokenFile: null };
  if (choice.tokenFile) {
    return { config: { ...config, token: resolveTokenFromFile(choice.tokenFile) ?? '' }, tokenFile: choice.tokenFile };
  }
  const fallback = choice.fallbackTokenFile;
  if (config.token || !fallback) return configured;
  const fallbackHome = path.dirname(fallback);
  const eligible = !fs.existsSync(homeConfigPath(fallbackHome))
    && matchesDiscoveredHomeEndpoint(config.api, `http://localhost:${readDkgApiPortSync(fallbackHome) ?? 9200}`);
  const token = eligible ? resolveTokenFromFile(fallback) : null;
  return token ? { config: { ...config, token }, tokenFile: fallback } : configured;
}

function loadConfiguredCredential(cwd: string, overrideApi: string | null): ResolvedCredential {
  const envApi = asString(process.env.DKG_API) ?? asString(process.env.DEVNET_API);
  const requestedApi = overrideApi ?? envApi;
  const envToken = asString(process.env.DKG_TOKEN) ?? asString(process.env.DEVNET_TOKEN) ?? asString(process.env.DKG_AUTH);
  const envProject = asString(process.env.DKG_PROJECT);
  const envAgent = asString(process.env.DKG_AGENT_URI);
  const dkgHome = process.env.DKG_HOME?.trim() || null;
  const configPath = findConfigFile(cwd);
  // Explicit JSON homes precede their YAML fallback. Otherwise a workspace
  // binding precedes discovery, and discovered defaults stay bound to that node.
  const home = dkgHome ?? (!configPath ? resolveDkgHome({ daemonUrl: requestedApi ?? undefined }) : null);
  if (home) {
    const defaults = readHomeFileDefaults(home);
    if (defaults) {
      const runtimePort = dkgHome ? null : readDkgApiPortSync(home);
      const homeApi = runtimePort === null ? defaults.api : `http://localhost:${runtimePort}`;
      if (dkgHome || matchesDiscoveredHomeEndpoint(requestedApi, homeApi)) {
        const config: DkgConfig = {
          ...defaults, api: requestedApi ?? homeApi, token: envToken ?? defaults.token,
          defaultProject: envProject ?? defaults.defaultProject, agentUri: envAgent,
          capture: { autoShare: true, defaultPrivacy: 'team', subGraph: 'chat', assertion: 'chat-log' },
        };
        return { config, tokenFile: !envToken && defaults.token ? path.resolve(home, 'auth.token') : null };
      }
    }
  }

  let fromFile: Record<string, unknown> = {};
  let sourcePath: string | null = null;
  if (configPath) {
    sourcePath = configPath;
    const raw = readIfExists(configPath);
    if (raw) {
      try {
        // Workspace-canonical yaml format. Round-21 Fix 27 reverted
        // the Round-19 Fix 25 format-aware dispatch — the daemon
        // config.json path is handled upstream by
        // readHomeFileDefaults, so by the time we get here, the
        // file is always yaml-shape (either a workspace
        // .dkg/config.yaml or a hand-written DKG_HOME/config.yaml).
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === 'object') {
          fromFile = parsed as Record<string, unknown>;
        }
      } catch (err) {
        // Malformed YAML is not fatal — we just ignore it and log to
        // stderr so the user sees the problem without blocking the
        // server startup.
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
  let tokenFile: string | null = null;
  if (!token) {
    const tokenFileRaw = asString(node.tokenFile);
    if (tokenFileRaw && sourcePath) {
      const expanded = expandHome(tokenFileRaw);
      const abs = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(path.dirname(sourcePath), expanded);
      token = resolveTokenFromFile(abs);
      if (token) tokenFile = abs;
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

  const config: DkgConfig = {
    api: overrideApi ?? asString(node.api) ?? envApi ?? DEFAULT_API,
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
  return { config, tokenFile };
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
    cfg.token ? 'token=[set]' : `token=[empty] — ${MISSING_TOKEN_HELP}`,
  ];
  return pieces.join(' · ');
}
