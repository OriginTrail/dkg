import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform, release as osRelease } from 'node:os';
import { execSync } from 'node:child_process';


/** DKG owns one fixed server entry inside each client's declared container. */
export const DKG_SERVER_KEY = 'dkg';
export type McpClientConfigShape =
  | { readonly format: 'json'; readonly serverContainer: 'mcpServers' | 'servers' }
  | { readonly format: 'jsonc'; readonly serverContainer: 'servers' }
  | { readonly format: 'toml'; readonly serverContainer: 'mcp_servers' };
export type McpClientLocation = 'native' | 'windows-wsl';
type WindowsPaths = { USERPROFILE: string | null; APPDATA: string | null };

function homePaths(home: string, ...parts: string[]) {
  const configPath = join(home, ...parts);
  return { configPath, displayPath: tildify(configPath) };
}

const JSON_MCP = { format: 'json', serverContainer: 'mcpServers' } as const;
const JSONC_SERVERS = { format: 'jsonc', serverContainer: 'servers' } as const;
const TOML_SERVERS = { format: 'toml', serverContainer: 'mcp_servers' } as const;

/** One entry owns each client's identity, storage shape, paths and skill delivery. */
const MCP_CLIENT_REGISTRY = [
  { target: { id: 'cursor', name: 'Cursor', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.cursor', 'mcp.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE && join(env.USERPROFILE, '.cursor', 'mcp.json'),
    skillPath: ['.cursor', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-code', name: 'Claude Code', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.claude.json'),
    skillPath: ['.claude', 'skills', 'dkg-node', 'SKILL.md'],
  },
  { target: { id: 'claude-desktop', name: 'Claude Desktop', ...JSON_MCP },
    nativePaths: claudeDesktopPaths,
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Claude', 'claude_desktop_config.json'),
  },
  { target: { id: 'windsurf', name: 'Windsurf', ...JSON_MCP },
    nativePaths: (home: string) => homePaths(home, '.codeium', 'windsurf', 'mcp_config.json'),
    windowsPath: (env: WindowsPaths) => env.USERPROFILE && join(env.USERPROFILE, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  { target: { id: 'vscode', name: 'VSCode', ...JSONC_SERVERS },
    nativePaths: vscodeMcpPaths,
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Code', 'User', 'mcp.json'),
  },
  { target: { id: 'cline', name: 'Cline', ...JSON_MCP },
    nativePaths: clineMcpPaths,
    windowsPath: (env: WindowsPaths) => env.APPDATA && join(env.APPDATA, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
  },
  { target: { id: 'codex-cli', name: 'Codex CLI', ...TOML_SERVERS },
    nativePaths: (home: string) => homePaths(home, '.codex', 'config.toml'),
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

/** Select each physical owned leaf once, retaining its authoritative persistence location. */
export function selectMcpClientTargets(
  clients: readonly ClientTarget[],
  selector?: ReturnType<typeof parseMcpClientSelector>,
): ClientTarget[] {
  const groups = new Map<string, ClientTarget[]>();
  for (const target of clients) {
    let physicalPath: string;
    try { physicalPath = realpathSync(target.configPath); }
    catch { physicalPath = resolve(target.configPath); }
    const leaf = JSON.stringify([physicalPath, target.serverContainer, DKG_SERVER_KEY]);
    const group = groups.get(leaf) ?? [];
    group.push(target);
    groups.set(leaf, group);
  }
  // Match logical aliases before selecting the persistence strategy. A native
  // WSL HOME can point at the same NTFS file as a Windows-side client target;
  // even an explicit :native selector must preserve that file's Windows DACL.
  return [...groups.values()]
    .filter(group => !selector || group.some(target => target.id === selector.id
      && (!selector.location || target.location === selector.location)))
    .map(group => group.find(target => target.location === 'windows-wsl') ?? group[0]!);
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

/**
 * Codex Round-6 Fix 9: resolve the Linux config base directory,
 * honouring `XDG_CONFIG_HOME` when set. Per the XDG Base Directory
 * spec, applications that store config under `~/.config` should
 * defer to `$XDG_CONFIG_HOME` first — users who relocate app
 * configs (common on multi-user systems and dotfile-managed
 * setups) were previously invisible to `dkg mcp setup`'s detection
 * sweep. Used by the Claude Desktop / VSCode + Copilot Chat /
 * Cline Linux path resolvers below.
 */
function linuxConfigDir(home: string): string {
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/**
 * Resolve Claude Desktop's per-platform config path. The macOS path
 * uses `~/Library/Application Support/Claude/`; Windows uses
 * `%APPDATA%\Claude\`; Linux follows XDG-ish convention at
 * `~/.config/Claude/`. The display path tildifies the home prefix
 * so the operator-facing log reads consistently across platforms.
 */
function claudeDesktopPaths(home: string): { configPath: string; displayPath: string } {
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return { configPath, displayPath: '~/Library/Application Support/Claude/claude_desktop_config.json' };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Claude', 'claude_desktop_config.json');
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  // Linux + everything else: XDG-style. Per Claude's docs the active
  // config under Linux is `<XDG_CONFIG_HOME>/Claude/claude_desktop_config.json`,
  // falling back to `~/.config/Claude/...` when XDG_CONFIG_HOME is unset.
  const configPath = join(linuxConfigDir(home), 'Claude', 'claude_desktop_config.json');
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Resolve VSCode + Copilot Chat's per-platform user-settings MCP
 * config path. VSCode keeps user-scoped settings under
 * `<userDataDir>/User/`; on Mac this is
 * `~/Library/Application Support/Code/User/mcp.json`; on Windows
 * it's `%APPDATA%\Code\User\mcp.json`; on Linux it's
 * `~/.config/Code/User/mcp.json`. Note this is the user-scoped
 * (cross-workspace) config, not the per-workspace `.vscode/mcp.json`.
 *
 * Diverges from the canonical `mcpServers.dkg` shape: Copilot Chat's
 * MCP wiring uses `servers.dkg` instead. The phase-1 serverContainer
 * dispatch handles that without per-client write logic.
 */
function vscodeMcpPaths(home: string): { configPath: string; displayPath: string } {
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    return { configPath, displayPath: '~/Library/Application Support/Code/User/mcp.json' };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Code', 'User', 'mcp.json');
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  const configPath = join(linuxConfigDir(home), 'Code', 'User', 'mcp.json');
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Resolve Cline (VSCode extension) per-platform config path. Cline
 * stores its MCP wiring inside VSCode's per-extension globalStorage
 * directory under the extension publisher.id namespace
 * (`saoudrizwan.claude-dev`). Same `mcpServers.dkg` JSON shape as
 * Cursor / Claude Code; what's hard is just the deeply-nested path.
 *
 * macOS: `~/Library/Application Support/Code/User/globalStorage/...`
 * Windows: `%APPDATA%\Code\User\globalStorage\...`
 * Linux:  `~/.config/Code/User/globalStorage/...`
 *
 * Mirrors `vscodeMcpPaths` for the per-platform Code-user-data root,
 * with the per-extension globalStorage suffix appended.
 */
function clineMcpPaths(home: string): { configPath: string; displayPath: string } {
  const suffix = join(
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Code', 'User', suffix);
    return { configPath, displayPath: `~/Library/Application Support/Code/User/${suffix.replace(/\\/g, '/')}` };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Code', 'User', suffix);
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  const configPath = join(linuxConfigDir(home), 'Code', 'User', suffix);
  return { configPath, displayPath: tildify(configPath) };
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
 *   - Claude Desktop: per-platform (see `claudeDesktopPaths`)
 *   - Windsurf (Codeium): `~/.codeium/windsurf/mcp_config.json`
 *
 * Detection is deliberately permissive: any client whose config file is
 * already present OR whose config directory is already present counts as
 * "detected" for write purposes. Operators with a fresh machine and no
 * client installed still see the fallback "no clients detected; run
 * `dkg mcp setup --print-only`" message.
 */
/**
 * Codex Round-13 Fix 20: detect WSL2. Linux platform with `microsoft`
 * / `WSL` markers in env, kernel release, or `/proc/version`. WSL
 * users running `dkg mcp setup` from inside their WSL distro need
 * to register Windows-side GUI clients (Claude Desktop, Windsurf,
 * VSCode + Copilot, Cline) AS WELL AS any Linux-native clients —
 * pre-fix they got the Linux-only set and the README's WSL2
 * promise silently failed for the apps users actually run.
 *
 * Multi-signal detection (env first; cheaper than fs reads):
 *   - `WSL_DISTRO_NAME` / `WSL_INTEROP` set by the WSL launcher.
 *   - `os.release()` contains `microsoft` or `wsl` (WSL kernels
 *     identify themselves there).
 *   - `/proc/version` contains the same markers (slower fallback).
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const release = osRelease().toLowerCase();
    if (release.includes('microsoft') || release.includes('wsl')) return true;
  } catch { /* fall through */ }
  try {
    const procVersion = readFileSync('/proc/version', 'utf-8').toLowerCase();
    if (procVersion.includes('microsoft') || procVersion.includes('wsl')) return true;
  } catch { /* /proc/version not readable; not WSL */ }
  return false;
}

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

/**
 * Exported for Codex Round-13 Fix 20 tests — direct unit testing
 * of WSL2 client-detection branch without going through the full
 * `mcpSetupAction` body. Production callers go via the action.
 * The resolver arg is test-only so WSL Windows path discovery can
 * be exercised without real cmd.exe / wslpath binaries.
 */
export function detectClients(
  resolveWslWindowsEnvPath: (envVarName: string) => string | null =
    wslWindowsEnvPath,
): ClientTarget[] {
  const home = homedir();
  const candidates: ClientTarget[] = MCP_CLIENT_REGISTRY.map((client) => ({
    ...client.target,
    location: 'native',
    ...client.nativePaths(home),
  }));
  if (isWSL()) {
    const windows = {
      USERPROFILE: resolveWslWindowsEnvPath('USERPROFILE'),
      APPDATA: resolveWslWindowsEnvPath('APPDATA'),
    };
    for (const client of MCP_CLIENT_REGISTRY) {
      if (!('windowsPath' in client)) continue;
      const configPath = client.windowsPath(windows);
      if (!configPath) continue;
      candidates.push({
        ...client.target,
        name: `${client.target.name} (Windows-side via WSL)`,
        location: 'windows-wsl',
        configPath,
        displayPath: configPath,
      });
    }
  }
  return candidates.filter((client) => existsSync(client.configPath) || existsSync(dirname(client.configPath)));
}
