import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform, release as osRelease } from 'node:os';
import { execSync } from 'node:child_process';


export const MCP_CLIENT_IDS = ['cursor', 'claude-code', 'claude-desktop', 'windsurf', 'vscode', 'cline', 'codex-cli'] as const;
export type McpClientId = typeof MCP_CLIENT_IDS[number];
export type McpClientLocation = 'native' | 'windows-wsl';

/** Stable selector identity is independent of display names and detection results. */
export function parseMcpClientSelector(value: string): { id: McpClientId; location?: McpClientLocation } {
  const [id, location, extra] = value.trim().toLowerCase().split(':');
  if (!(MCP_CLIENT_IDS as readonly string[]).includes(id) || extra !== undefined
      || (location !== undefined && location !== 'native' && location !== 'windows-wsl')) {
    throw new Error(`Unsupported MCP client selector "${value}". Use ${MCP_CLIENT_IDS.join(', ')}, optionally followed by :native or :windows-wsl.`);
  }
  return { id: id as McpClientId, location: location as McpClientLocation | undefined };
}

export interface ClientTarget {
  id: McpClientId;
  location: McpClientLocation;
  name: string;
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
  /**
   * Per-client config-file format. Defaults to `'json'` so the existing
   * Cursor + Claude Code targets stay byte-identical post-refactor.
   * Codex CLI uses `'toml'`. The `'yaml'` variant is reserved for
   * future clients (Continue was attempted in PR #443 then reverted
   * because its MCP config is workspace-local, not user-global —
   * structural mismatch with `dkg mcp setup`'s machine-wide UX);
   * `readConfigBody` / `writeConfigBody` keep `NotImplementedError`
   * stubs for the YAML branch so re-adding a YAML client is purely
   * additive when the time comes.
   */
  format?: 'json' | 'toml' | 'yaml';
  /**
   * Dotted path to the per-server entry inside the parsed config.
   * Defaults to `'mcpServers.dkg'` — the shape Cursor / Claude Code /
   * Claude Desktop / Windsurf / Cline all use. Clients diverging from
   * that shape (VSCode + Copilot Chat uses `servers.dkg`; Codex CLI
   * uses `mcp_servers.dkg` under TOML) declare the alternate path
   * here so a single registration helper covers all surfaces without
   * per-client write logic.
   */
  entryPath?: string;
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
 * MCP wiring uses `servers.dkg` instead. The phase-1 entryPath
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
  const claudeDesktop = claudeDesktopPaths(home);
  const vscodeMcp = vscodeMcpPaths(home);
  const candidates: ClientTarget[] = [
    {
      id: 'cursor' as const, location: 'native' as const,
      name: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      displayPath: '~/.cursor/mcp.json',
    },
    {
      id: 'claude-code' as const, location: 'native' as const,
      name: 'Claude Code',
      configPath: join(home, '.claude.json'),
      displayPath: '~/.claude.json',
    },
    {
      id: 'claude-desktop' as const, location: 'native' as const,
      name: 'Claude Desktop',
      configPath: claudeDesktop.configPath,
      displayPath: claudeDesktop.displayPath,
    },
    {
      id: 'windsurf' as const, location: 'native' as const,
      name: 'Windsurf',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      displayPath: '~/.codeium/windsurf/mcp_config.json',
    },
    {
      id: 'vscode' as const, location: 'native' as const,
      name: 'VSCode',
      configPath: vscodeMcp.configPath,
      displayPath: vscodeMcp.displayPath,
      // Copilot Chat's MCP wiring keys under `servers`, not the
      // canonical `mcpServers`. Phase-1 entryPath dispatch handles
      // it without per-client write logic.
      entryPath: 'servers.dkg',
    },
    (() => {
      const cline = clineMcpPaths(home);
      return {
        id: 'cline' as const, location: 'native' as const,
        name: 'Cline',
        configPath: cline.configPath,
        displayPath: cline.displayPath,
        // Cline uses the canonical `mcpServers.dkg` shape; only the
        // path is unusual (deep-nested under VSCode's per-extension
        // globalStorage). entryPath defaults to `mcpServers.dkg`
        // so no override needed.
      };
    })(),
    {
      // Codex CLI (OpenAI). Config: `~/.codex/config.toml`. Entry path:
      // `[mcp_servers.<name>]` table — Codex CLI's canonical naming
      // (note `mcp_servers`, snake-cased, distinct from the
      // `mcpServers` JSON convention used by every other client).
      // Verified against Codex CLI docs at
      // https://github.com/openai/codex (issue #437, 2026-05-08).
      id: 'codex-cli' as const, location: 'native' as const,
      name: 'Codex CLI',
      configPath: join(home, '.codex', 'config.toml'),
      displayPath: '~/.codex/config.toml',
      format: 'toml',
      entryPath: 'mcp_servers.dkg',
    },
  ];

  // Codex Round-13 Fix 20: when running inside WSL2, ALSO probe the
  // Windows-side config locations for the four GUI clients users
  // typically run on Windows even when their dev shell is in WSL.
  // Linux-side entries above are preserved (some WSL users run
  // native Linux GUI clients too); the new entries are additive
  // with disambiguated names so the operator-facing log is clear.
  if (isWSL()) {
    const winUserProfile = resolveWslWindowsEnvPath('USERPROFILE');
    const winAppData = resolveWslWindowsEnvPath('APPDATA');
    if (winAppData) {
      // Claude Desktop on Windows: %APPDATA%\Claude\claude_desktop_config.json.
      const claudeWinPath = join(winAppData, 'Claude', 'claude_desktop_config.json');
      candidates.push({
        id: 'claude-desktop', location: 'windows-wsl',
        name: 'Claude Desktop (Windows-side via WSL)',
        configPath: claudeWinPath,
        displayPath: claudeWinPath,
      });
      // VSCode + Copilot Chat on Windows: %APPDATA%\Code\User\mcp.json.
      const vscodeWinPath = join(winAppData, 'Code', 'User', 'mcp.json');
      candidates.push({
        id: 'vscode', location: 'windows-wsl',
        name: 'VSCode (Windows-side via WSL)',
        configPath: vscodeWinPath,
        displayPath: vscodeWinPath,
        entryPath: 'servers.dkg',
      });
      // Cline on Windows: %APPDATA%\Code\User\globalStorage\
      // saoudrizwan.claude-dev\settings\cline_mcp_settings.json.
      const clineWinPath = join(
        winAppData, 'Code', 'User',
        'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json',
      );
      candidates.push({
        id: 'cline', location: 'windows-wsl',
        name: 'Cline (Windows-side via WSL)',
        configPath: clineWinPath,
        displayPath: clineWinPath,
      });
    }
    if (winUserProfile) {
      // Windsurf on Windows: %USERPROFILE%\.codeium\windsurf\mcp_config.json
      // (the `~/.codeium/...` path resolves under USERPROFILE on Windows,
      // not APPDATA).
      const windsurfWinPath = join(winUserProfile, '.codeium', 'windsurf', 'mcp_config.json');
      candidates.push({
        id: 'windsurf', location: 'windows-wsl',
        name: 'Windsurf (Windows-side via WSL)',
        configPath: windsurfWinPath,
        displayPath: windsurfWinPath,
      });
      // Codex Round-17 Fix 23: Cursor on Windows — same shape as
      // Linux Cursor (~/.cursor/mcp.json + canonical mcpServers.dkg
      // entry), just resolved through %USERPROFILE%. Round-13 FIX 20
      // skipped this; "Windows Cursor + WSL shell" is a common dev
      // setup that was silently unregistered until now even though
      // Cursor's been in the detection set since round 1.
      const cursorWinPath = join(winUserProfile, '.cursor', 'mcp.json');
      candidates.push({
        id: 'cursor', location: 'windows-wsl',
        name: 'Cursor (Windows-side via WSL)',
        configPath: cursorWinPath,
        displayPath: cursorWinPath,
      });
      // PR #443 local review: do not register Windows-side Codex
      // from a WSL process yet. The canonical entry is computed from
      // the current Linux/WSL Node + CLI paths; writing that into
      // %USERPROFILE%\.codex\config.toml would leave Windows Codex
      // unable to spawn the MCP server. Add this only once we emit a
      // Windows-compatible wrapper command, e.g. via wsl.exe.
    }
  }

  return candidates.filter((c) => {
    if (existsSync(c.configPath)) return true;
    if (existsSync(dirname(c.configPath))) return true;
    return false;
  });
}
