import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { resolveMcpConfigDestination } from './mcp-config-file.js';
import { McpPhysicalConfig } from './mcp-physical-config.js';
import { detectMcpRuntime } from './mcp-runtime.js';
import { claudeDesktopConfigPaths } from './mcp-claude-desktop-path.js';

import { DKG_SERVER_KEY } from './mcp-config-document.js';
export { DKG_SERVER_KEY, type McpClientConfigShape } from './mcp-config-document.js';
export type McpClientLocation = 'native' | 'windows-wsl';
type WindowsPaths = { USERPROFILE: string | null; APPDATA: string | null; LOCALAPPDATA: string | null };

/** Preferred setup destination comes first; removal can inspect every candidate. */
interface ClientPaths { configPaths: string[]; checkedPaths?: string[] }
interface NativePathContext { home: string; root: string; localAppData: string | null; platform: NodeJS.Platform }
function configPaths(root: string, ...parts: string[]): ClientPaths {
  return { configPaths: [join(root, ...parts)] };
}

const JSON_MCP = { format: 'json', serverContainer: 'mcpServers' } as const;
const JSONC_SERVERS = { format: 'jsonc', serverContainer: 'servers' } as const;
const TOML_SERVERS = { format: 'toml', serverContainer: 'mcp_servers' } as const;

/** One entry owns each client's identity, storage shape, paths and skill delivery. */
const MCP_CLIENT_REGISTRY = [
  { target: { id: 'cursor', name: 'Cursor', ...JSON_MCP },
    nativePaths: ({ home }: NativePathContext) => configPaths(home, '.cursor', 'mcp.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE ? configPaths(env.USERPROFILE, '.cursor', 'mcp.json') : null,
    skillPath: ['.cursor', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-code', name: 'Claude Code', ...JSON_MCP },
    nativePaths: ({ home }: NativePathContext) => configPaths(home, '.claude.json'),
    skillPath: ['.claude', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-desktop', name: 'Claude Desktop', ...JSON_MCP },
    nativePaths: ({ root, localAppData, platform: host }: NativePathContext): ClientPaths => host === 'win32'
      ? claudeDesktopConfigPaths(join(root, 'Claude', 'claude_desktop_config.json'), localAppData)
      : configPaths(root, 'Claude', 'claude_desktop_config.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA
      ? claudeDesktopConfigPaths(join(env.APPDATA, 'Claude', 'claude_desktop_config.json'), env.LOCALAPPDATA) : null,
  },
  { target: { id: 'windsurf', name: 'Windsurf', ...JSON_MCP },
    nativePaths: ({ home }: NativePathContext) => configPaths(home, '.codeium', 'windsurf', 'mcp_config.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE ? configPaths(env.USERPROFILE, '.codeium', 'windsurf', 'mcp_config.json') : null,
  },
  { target: { id: 'vscode', name: 'VSCode', ...JSONC_SERVERS },
    nativePaths: ({ root }: NativePathContext) => configPaths(root, 'Code', 'User', 'mcp.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA ? configPaths(env.APPDATA, 'Code', 'User', 'mcp.json') : null,
  },
  { target: { id: 'cline', name: 'Cline', ...JSON_MCP },
    nativePaths: ({ root }: NativePathContext) => configPaths(root, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    windowsPath: (env: WindowsPaths) => env.APPDATA ? configPaths(env.APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json') : null,
  },
  { target: { id: 'codex-cli', name: 'Codex CLI', ...TOML_SERVERS },
    nativePaths: ({ home }: NativePathContext) => configPaths(home, '.codex', 'config.toml'),
    // A WSL process has no Windows-compatible Node/CLI launch command for Codex.
  },
] as const;

type McpClientDefinition = typeof MCP_CLIENT_REGISTRY[number];
export type McpClientId = McpClientDefinition['target']['id'];
export const MCP_CLIENT_IDS = Object.freeze(MCP_CLIENT_REGISTRY.map((client) => client.target.id));
type NativeTarget = McpClientDefinition['target'] & { location: 'native' };
type WindowsTarget = Extract<McpClientDefinition, { windowsPath: unknown }>['target'] & { location: 'windows-wsl' };
/** Identity determines its config shape and supported locations in the registry. */
type WithDisplayName<T> = T extends unknown ? Omit<T, 'name'> & { name: string } : never;
export type ClientTarget = WithDisplayName<NativeTarget | WindowsTarget> & {
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
};

/** Stable selector identity is independent of display names and detection results. */
export function parseMcpClientSelector(value: string): { id: McpClientId; location?: McpClientLocation } {
  const [id, location, extra] = value.trim().toLowerCase().split(':');
  const client = MCP_CLIENT_REGISTRY.find(entry => entry.target.id === id);
  if (!client || extra !== undefined
      || (location === 'windows-wsl' && !('windowsPath' in client))
      || (location !== undefined && location !== 'native' && location !== 'windows-wsl')) {
    throw new Error(`Unsupported MCP client selector "${value}". Use ${MCP_CLIENT_IDS.join(', ')}, optionally followed by :native or :windows-wsl.`);
  }
  return { id: client.target.id, location };
}

export interface McpConfigSelection {
  readonly file: McpPhysicalConfig;
  /** Logical clients selected by the caller; never replaced by a storage alias. */
  readonly aliases: readonly ClientTarget[];
}

export function mcpConfigClientNames(selection: McpConfigSelection): string {
  return [...new Set(selection.aliases.map(alias => alias.name))].join(', ');
}

/** Select each physical owned leaf once while retaining the selected logical aliases. */
export function selectMcpClientTargets(
  clients: readonly ClientTarget[],
  selector?: ReturnType<typeof parseMcpClientSelector>,
): McpConfigSelection[] {
  const groups = new Map<string, { path: string; aliases: ClientTarget[] }>();
  for (const target of clients) {
    let physicalPath: string;
    try { physicalPath = resolveMcpConfigDestination(target.configPath); }
    catch { physicalPath = resolve(target.configPath); }
    const leaf = JSON.stringify([physicalPath, target.format, target.serverContainer, DKG_SERVER_KEY]);
    const group = groups.get(leaf) ?? { path: physicalPath, aliases: [] };
    group.aliases.push(target);
    groups.set(leaf, group);
  }
  const selected: McpConfigSelection[] = [];
  for (const group of groups.values()) {
    const aliases = group.aliases.filter(target => !selector || (target.id === selector.id
      && (!selector.location || target.location === selector.location)));
    if (aliases.length === 0) continue;
    selected.push({ file: McpPhysicalConfig.create(aliases), aliases });
  }
  return selected;
}

export function clientSkillPath(id: McpClientId, home: string): string | null {
  const client = MCP_CLIENT_REGISTRY.find((entry) => entry.target.id === id);
  return client && 'skillPath' in client ? join(home, ...client.skillPath) : null;
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Resolve the native application-config root once for the detection sweep. */
function nativeApplicationConfigRoot(home: string): string {
  switch (platform()) {
    case 'darwin': return join(home, 'Library', 'Application Support');
    case 'win32': return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    default: return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  }
}

/**
 * Discover MCP-aware clients on the machine. We look at the standard
 * config-file locations rather than probing for installed binaries — a
 * config file is the artifact `dkg mcp setup` actually writes into, and
 * its existence (or non-existence) is the signal that matters.
 *
 * Per-client docs source-of-truth (verify on next-cycle if anything
 * drifts):
 *   - Cursor:        `~/.cursor/mcp.json` — global per-user MCP config
 *   - Claude Code:   `~/.claude.json` — user-scoped path the MCP-server
 *     wiring already uses across the rest of the codebase
 *   - Claude Desktop: per-platform (native application-config root)
 *   - Windsurf (Codeium): `~/.codeium/windsurf/mcp_config.json`
 *
 * Detection is deliberately permissive: any client whose config file is
 * already present OR whose config directory is already present counts as
 * "detected" for write purposes. Operators with a fresh machine and no
 * client installed still see the fallback "no clients detected; run
 * `dkg mcp setup --print-only`" message.
 */
/**
 * Resolve a Windows-side env var (e.g. `%USERPROFILE%`,
 * `%APPDATA%`) into a WSL-mounted Linux path (`/mnt/c/...`). Uses
 * `cmd.exe` to read the env var, then `wslpath` to convert. Returns
 * `null` on any failure (cmd.exe / wslpath missing, env var
 * unset, conversion error) so callers fall back to Linux-only
 * detection.
 *
 * Codex Round-13 Fix 20 helper.
 */
function wslWindowsEnvPath(envVarName: string): string | null {
  try {
    const winPath = execSync(`cmd.exe /c "echo %${envVarName}%"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `cmd.exe` echoes `%FOO%` literally when the var is unset.
    if (!winPath || winPath.startsWith('%')) return null;
    // Strip Windows CR if present.
    const cleaned = winPath.replace(/\r/g, '');
    // wslpath -u takes the Windows path and emits the /mnt/c/...
    // form. Quote the input to handle spaces in usernames.
    const linuxPath = execSync(`wslpath -u '${cleaned.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return linuxPath || null;
  } catch {
    return null;
  }
}

export interface MissingMcpClient {
  id: McpClientId;
  name: string;
  location: McpClientLocation;
  checkedPaths: string[];
}

/**
 * Exported for Codex Round-13 Fix 20 tests — direct unit testing
 * of WSL2 client-detection branch without going through the full
 * `mcpSetupAction` body. Production callers go via the action.
 * The resolver arg is test-only so WSL Windows path discovery can
 * be exercised without real cmd.exe / wslpath binaries.
 */
export interface DetectMcpClientsOptions {
  resolveWslWindowsEnvPath?: (envVarName: string) => string | null;
  reportMissing?: (client: MissingMcpClient) => void;
  selection?: 'preferred' | 'all';
}

export function detectClients({
  resolveWslWindowsEnvPath = wslWindowsEnvPath, reportMissing, selection = 'preferred',
}: DetectMcpClientsOptions = {}): ClientTarget[] {
  const home = homedir();
  const context: NativePathContext = {
    home, root: nativeApplicationConfigRoot(home), platform: platform(),
    localAppData: process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
  };
  const candidates: ClientTarget[] = [];
  const add = (target: WithDisplayName<NativeTarget | WindowsTarget>, paths: ClientPaths) => {
    const selected = selection === 'all' ? paths.configPaths : paths.configPaths.slice(0, 1);
    const found = selected.filter((path) => existsSync(path) || existsSync(dirname(path)));
    for (const configPath of found) candidates.push({
      ...target, configPath,
      displayPath: target.location === 'native' ? tildify(configPath) : configPath,
    });
    if (!found.length) reportMissing?.({ id: target.id, name: target.name, location: target.location,
      checkedPaths: paths.checkedPaths ?? paths.configPaths });
  };
  for (const client of MCP_CLIENT_REGISTRY) add({ ...client.target, location: 'native' }, client.nativePaths(context));
  if (detectMcpRuntime() === 'wsl') {
    const windows = {
      USERPROFILE: resolveWslWindowsEnvPath('USERPROFILE'),
      APPDATA: resolveWslWindowsEnvPath('APPDATA'),
      LOCALAPPDATA: resolveWslWindowsEnvPath('LOCALAPPDATA'),
    };
    for (const client of MCP_CLIENT_REGISTRY) {
      if (!('windowsPath' in client)) continue;
      const paths = client.windowsPath(windows);
      if (paths) add({ ...client.target, name: `${client.target.name} (Windows-side via WSL)`, location: 'windows-wsl' }, paths);
    }
  }
  return candidates;
}
