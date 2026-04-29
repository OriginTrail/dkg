// Manifest / semver / skill-template / bundled-MarkItDown helpers
// extracted from the legacy monolithic `daemon.ts`. Scope: helpers used
// by the Phase-8 `/api/context-graph/{id}/manifest/*` routes, the
// `/.well-known/skill.md` endpoint, and the auto-update binary
// carry-forward flow. Pure functions with small caches; no HTTP
// routing logic lives here.

import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, openSync, closeSync, unlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import {
  appendFile, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises';
import { execSync, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as osModule from 'node:os';
const { homedir } = osModule;
import type { IncomingMessage } from 'node:http';

import {
  CLI_NPM_PACKAGE,
  dkgDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  type AutoUpdateConfig,
} from '../config.js';
import {
  expectedBundledMarkItDownBuildMetadata,
  readCliPackageVersion,
  type BundledMarkItDownMetadata,
} from '../extraction/markitdown-bundle-metadata.js';
import {
  checksumPathFor as markItDownChecksumPath,
  hasVerifiedBundledBinary as hasVerifiedBundledMarkItDownBinary,
  metadataPathFor as markItDownMetadataPath,
} from '../../scripts/markitdown-bundle-validation.mjs';
import { type InstallContext } from '@origintrail-official/dkg-mcp/manifest/install';
import { DkgClient } from '@origintrail-official/dkg-mcp/client';

const daemonRequire = createRequire(import.meta.url);
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type MarkItDownTarget = {
  platform: string;
  arch: string;
  assetName: string;
  runner?: string;
};

// ── Phase 8 manifest helpers (used by /api/context-graph/{id}/manifest/* routes) ──
//
// These are deliberately small and pure so the route handlers stay
// readable. They live at module scope (not inside handleRequest) so
// they don't get re-created on every request.

/**
 * Marker files/dirs that prove we're running from a dkg-v9 checkout.
 * Anything on this list must be present at the resolved repo root, and
 * must NOT exist next to a typical npm-global `node_modules/.bin`
 * install tree, so we can cheaply tell the two apart.
 */
const REPO_ROOT_MARKERS = ['.cursor', 'AGENTS.md', 'packages'] as const;

/**
 * Resolve the dkg-v9 repo root from the daemon's compiled location.
 * The daemon ships at packages/cli/dist/daemon/manifest.js, so the
 * repo root is four levels up.
 *
 * Bakes a monorepo-checkout assumption into every generated
 * `.dkg/config.yaml`, hooks file, and `mcp.json` the daemon's
 * manifest install flow produces — absolute paths like
 * `<root>/packages/mcp-dkg/src/index.ts` are written verbatim into
 * the workspace. If that assumption is wrong (npm-global install,
 * tarball extract, etc.) those paths don't exist and the workspace
 * wiring is silently dead: the MCP server fails to start and every
 * subsequent tool call 500s with cryptic "ENOENT … index.ts".
 *
 * Rather than ship a dead config, fail fast here with a clear message.
 * When npm distribution lands we'll switch this to a bundled-assets
 * resolver, but until then "require a checkout" is the actual
 * invariant of the manifest publish flow.
 */
export function manifestRepoRoot(): string {
  const daemonDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(daemonDir, '..', '..', '..', '..');
  const missing = REPO_ROOT_MARKERS.filter((m) => !existsSync(resolve(root, m)));
  if (missing.length) {
    throw new Error(
      `manifestRepoRoot: daemon appears to be running outside a dkg-v9 checkout ` +
        `(resolved root ${root} is missing ${missing.join(', ')}). The manifest ` +
        `publish flow reads canonical cursor-rule + AGENTS.md from the repo, ` +
        `so it is only supported from a checkout today. Install/plan-install ` +
        `flows use resolveMcpDkgAssets() and work against npm-installed packages.`,
    );
  }
  return root;
}

/**
 * Resolve the absolute paths of `@origintrail-official/dkg-mcp`'s
 * runtime assets (bundled entry + capture-chat hook) that get baked
 * into the generated `.cursor/mcp.json` / `.cursor/hooks.json` /
 * `.claude/settings.json`.
 *
 * Tries three sources, in order:
 *   1. Node module resolution of `@origintrail-official/dkg-mcp/package.json`.
 *      Works for npm-global installs, per-workspace `node_modules`, and
 *      monorepo checkouts (pnpm symlinks the workspace package in).
 *   2. The daemon's own monorepo layout (`packages/mcp-dkg/...`) as a
 *      fallback for checkouts where the import graph somehow didn't
 *      surface dkg-mcp on the require paths.
 *   3. Throws with a clear, actionable error — callers should turn
 *      this into a 500 on `/manifest/plan-install` + `/manifest/install`.
 *
 * The returned paths MUST exist on disk; the manifest installer
 * embeds them in free-form JSON/YAML without further validation, and
 * a missing path would silently break Cursor/Claude wiring on the
 * operator's machine.
 *
 * Fixes Codex tier-4g finding N7: before this, both install routes
 * called `manifestRepoRoot()` and 500'd when the daemon ran from a
 * published `@origintrail-official/dkg` package.
 */
export interface McpDkgAssets {
  packageDir: string;
  distEntry: string;       // <pkg>/dist/index.js
  captureScript: string;   // <pkg>/hooks/capture-chat.mjs
  source: 'node-resolution' | 'repo-fallback';
}
export function resolveMcpDkgAssets(): McpDkgAssets {
  try {
    const pkgJsonPath = daemonRequire.resolve('@origintrail-official/dkg-mcp/package.json');
    const packageDir = dirname(pkgJsonPath);
    const distEntry = resolve(packageDir, 'dist', 'index.js');
    const captureScript = resolve(packageDir, 'hooks', 'capture-chat.mjs');
    if (existsSync(distEntry) && existsSync(captureScript)) {
      return { packageDir, distEntry, captureScript, source: 'node-resolution' };
    }
    // Resolution worked but assets are missing (e.g. a pruned install).
    // Fall through to repo-layout path so checkouts still work.
  } catch {
    // Not resolvable via node — e.g. the daemon is running from a
    // plain `tsx` on source without any `node_modules`. Fall back to
    // the monorepo layout below.
  }
  // Repo-fallback: from packages/cli/dist/daemon/manifest.js, four
  // `..` segments land at the monorepo root. PR #258 nested this
  // module under dist/daemon/, so the original three-level walk was
  // off by one and landed inside packages/, pointing at the bogus
  // <root>/packages/packages/mcp-dkg path.
  const daemonDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(daemonDir, '..', '..', '..', '..');
  const packageDir = resolve(repoRoot, 'packages', 'mcp-dkg');
  const distEntry = resolve(packageDir, 'dist', 'index.js');
  const captureScript = resolve(packageDir, 'hooks', 'capture-chat.mjs');
  if (existsSync(distEntry) && existsSync(captureScript)) {
    return { packageDir, distEntry, captureScript, source: 'repo-fallback' };
  }
  throw new Error(
    `resolveMcpDkgAssets: could not locate @origintrail-official/dkg-mcp. ` +
      `Tried Node module resolution and the monorepo layout at ${packageDir}. ` +
      `Install @origintrail-official/dkg-mcp alongside the daemon or run ` +
      `from a built dkg-v9 checkout (pnpm -r build).`,
  );
}

/**
 * Read the installed @origintrail-official/dkg-mcp package version from
 * its package.json. Used by the manifest install/plan-install routes to
 * enforce `requiresMcpDkgVersion`. Returns null when the package can't
 * be located (caller should treat this as "unknown" and skip gating
 * rather than block).
 */
export function readMcpDkgVersion(): string | null {
  try {
    const pkgJsonPath = daemonRequire.resolve('@origintrail-official/dkg-mcp/package.json');
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version;
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse an "X.Y.Z[-pre]" semver into comparable tuple; returns null on
 * malformed input so callers can bail cleanly.
 */
export function parseSemver(v: string): [number, number, number, string] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''];
}

// NOTE: we use a local variant (`cmpSemverForRange`) rather than the
// exported `compareSemver` below because the exported one is also used
// by the auto-update path and its prerelease ordering is slightly
// looser than the range-checking semantics we need here.
export function cmpSemverForRange(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === '') return 1;
  if (pb[3] === '') return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/**
 * Minimal `requiresMcpDkgVersion` range check. Understands the range
 * forms the mcp-dkg ecosystem actually publishes today: exact version,
 * `>=a.b.c`, `>a.b.c`, `<=a.b.c`, `<a.b.c`, `^a.b.c` (compatible within
 * major), `~a.b.c` (compatible within minor), space-separated `AND`
 * conjunctions, and ` || ` disjunctions. Unparseable ranges resolve to
 * `true` — we'd rather let an install proceed with a warning than block
 * it on a syntax we don't recognise. Codex tier-4k N30.
 */
export function versionSatisfiesRange(version: string, range: string): boolean {
  if (!range || range.trim() === '*' || range.trim() === 'latest') return true;
  const alts = range.split('||').map((s) => s.trim()).filter(Boolean);
  for (const alt of alts) {
    const comparators = alt.split(/\s+/).filter(Boolean);
    let ok = true;
    for (const c of comparators) {
      let passed = true;
      if (c.startsWith('>=')) passed = cmpSemverForRange(version, c.slice(2)) >= 0;
      else if (c.startsWith('<=')) passed = cmpSemverForRange(version, c.slice(2)) <= 0;
      else if (c.startsWith('>')) passed = cmpSemverForRange(version, c.slice(1)) > 0;
      else if (c.startsWith('<')) passed = cmpSemverForRange(version, c.slice(1)) < 0;
      else if (c.startsWith('^')) {
        const base = parseSemver(c.slice(1));
        const cur = parseSemver(version);
        if (!base || !cur) { passed = true; break; }
        const upper: [number, number, number] =
          base[0] > 0 ? [base[0] + 1, 0, 0]
          : base[1] > 0 ? [base[0], base[1] + 1, 0]
          : [base[0], base[1], base[2] + 1];
        passed = cmpSemverForRange(version, `${base[0]}.${base[1]}.${base[2]}`) >= 0 &&
          cmpSemverForRange(version, `${upper[0]}.${upper[1]}.${upper[2]}`) < 0;
      } else if (c.startsWith('~')) {
        const base = parseSemver(c.slice(1));
        if (!base) { passed = true; break; }
        const upper: [number, number, number] = [base[0], base[1] + 1, 0];
        passed = cmpSemverForRange(version, `${base[0]}.${base[1]}.${base[2]}`) >= 0 &&
          cmpSemverForRange(version, `${upper[0]}.${upper[1]}.${upper[2]}`) < 0;
      } else if (/^\d/.test(c)) {
        passed = cmpSemverForRange(version, c) === 0;
      } else {
        // Unrecognised comparator — give up on this alt rather than block.
        return true;
      }
      if (!passed) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Map the loaded `network.networkName` to the canonical label used
 * in the manifest schema. Anything that doesn't smell like testnet
 * or mainnet falls through to devnet.
 */
export function manifestNetworkLabel(networkName: string | undefined | null): 'testnet' | 'mainnet' | 'devnet' {
  const n = (networkName ?? '').toLowerCase();
  if (n.includes('testnet')) return 'testnet';
  if (n.includes('mainnet')) return 'mainnet';
  return 'devnet';
}

/**
 * Construct a self-pointing DkgClient for the manifest helpers to
 * round-trip through.
 *
 * The URL is derived from the daemon's own listening socket
 * (`apiHost`/`apiPort` resolved by the outer scope) — NOT from request
 * headers like `Host` or `X-Forwarded-Proto`. Those headers are
 * attacker-controlled on a direct daemon request: a crafted POST can
 * point this self-client at an arbitrary origin and exfiltrate the
 * bearer token we forward. The daemon only binds 127.0.0.1 by default
 * and always over plain HTTP, so hard-coding both is both safer and
 * more accurate.
 */
/**
 * Format a `host:port` pair safely for an `http://` URL, including the
 * IPv6-literal bracket rules from RFC-3986 §3.2.2 (`[::1]:9201`, not
 * `::1:9201`). We also downgrade the "all-interfaces" binds to their
 * matching loopback so a self-call can't escape the machine when the
 * operator bound the daemon to LAN: `0.0.0.0` → `127.0.0.1`, `::` →
 * `::1`. Crucially, `::` does NOT become `127.0.0.1` — an IPv6-only
 * listener (e.g. `bindv6only=1`) won't accept v4 loopback, and the
 * self-client would silently point at a dead socket.
 *
 * Returned strings are always parseable as a URL authority component:
 *   127.0.0.1   → 127.0.0.1:9201
 *   ::1         → [::1]:9201
 *   fe80::1     → [fe80::1]:9201
 *   localhost   → localhost:9201
 */
export function formatDaemonAuthority(apiHost: string, apiPort: number): string {
  // Downgrade the "all-interfaces" binds to their same-family loopback
  // so the self-client can't escape the machine even if the operator
  // opened the daemon to the LAN. `::` MUST go to `::1`, not 127.0.0.1
  // — on v6-only listeners (bindv6only=1) v4 loopback doesn't reach the
  // socket and `/manifest/*` would 404 at the transport layer. `::1` is
  // already loopback and we emit it verbatim (bracketed below).
  let downgraded: string;
  if (apiHost === '0.0.0.0') {
    downgraded = '127.0.0.1';
  } else if (apiHost === '::') {
    downgraded = '::1';
  } else {
    downgraded = apiHost;
  }
  // Bracket bare IPv6 literals. `:` only appears in IPv6 addresses for
  // anything we emit (host names and IPv4 literals never contain `:`).
  const isIpv6Literal = downgraded.includes(':') && !downgraded.startsWith('[');
  const host = isIpv6Literal ? `[${downgraded}]` : downgraded;
  return `${host}:${apiPort}`;
}

export function manifestSelfClient(
  apiHost: string,
  apiPort: number,
  requestToken: string | null | undefined,
): DkgClient {
  return new DkgClient({
    config: {
      api: `http://${formatDaemonAuthority(apiHost, apiPort)}`,
      token: requestToken ?? '',
      defaultProject: null,
      agentUri: null,
      capture: { autoShare: true, defaultPrivacy: 'team', subGraph: 'chat', assertion: 'chat-log' },
      sourcePath: null,
    },
  });
}

/**
 * Map the requesting agent's resolved ETH address into the
 * `urn:dkg:agent:<address>` URI form used for prov:wasAttributedTo
 * on every manifest entity.
 *
 * `DKGAgent.resolveAgentAddress()` falls back to the node's peer ID
 * when there's no agent token and no default wallet on the daemon.
 * A peer ID is NOT an EVM address, so lowercasing it into
 * `urn:dkg:agent:<peerId>` would mint an invalid, non-dereferenceable
 * agent URI and then write it into the generated workspace config
 * (where the chat-capture hook uses it as `agentUri`). Reject anything
 * that isn't a canonical `0x` + 40 hex char address and emit
 * `urn:dkg:agent:unknown` so the rest of the manifest still validates
 * and the operator can see the misconfiguration downstream.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export function manifestPublisherUri(requestAgentAddress: string | undefined | null): string {
  if (requestAgentAddress && EVM_ADDRESS_RE.test(requestAgentAddress)) {
    return `urn:dkg:agent:${requestAgentAddress.toLowerCase()}`;
  }
  return 'urn:dkg:agent:unknown';
}

/**
 * Tools the install panel may target. `cursor` and `claude-code` map to
 * actual template entities the manifest publisher ships today; `codex`
 * is recognised so the UI can list it but no template wiring exists yet
 * — selecting it is a no-op apart from logging.
 */
export type SupportedTool = 'cursor' | 'claude-code' | 'codex';

/**
 * Slug-shape an arbitrary nickname so back-compat with anything that
 * still expects a slug-form `agentSlug` keeps working. Same rule as
 * `normaliseSlug` in mcp-dkg/src/tools/annotations.ts.
 */
export function nicknameToSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'agent';
}

/**
 * Build an InstallContext from the request body. The body shape:
 *   { workspaceRoot, agentNickname?, agentSlug? (legacy), tools?: string[] }
 *
 * The cryptographic agent URI is derived from the daemon's bearer-token
 * wallet, NOT from anything in the body — that's the whole point of
 * grounding attribution in the wallet.
 *
 * The `tools` field lists which template categories the operator wants
 * installed (cursor / claude-code / codex). Anything not in the list is
 * stripped from `manifest.supportedTools` before plan, so the planner
 * naturally skips its templates (mirroring the legacy --skip-claude flag).
 */
export function buildManifestInstallContext(
  _req: IncomingMessage,
  body: Record<string, unknown>,
  _contextGraphId: string,
  _requestToken: string | null | undefined,
  requestAgentAddress: string | undefined | null,
  daemonApiHost: string,
  daemonApiPort: number,
):
  | { ok: true; context: Omit<InstallContext, 'manifest'> & { tools: SupportedTool[]; agentNickname: string }; }
  | { ok: false; error: string } {
  const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot.trim() : '';
  const rawNickname = typeof body.agentNickname === 'string'
    ? body.agentNickname.trim()
    : (typeof body.agentSlug === 'string' ? body.agentSlug.trim() : '');
  if (!workspaceRoot) return { ok: false, error: 'workspaceRoot is required (absolute path)' };
  if (!workspaceRoot.startsWith('/') && !workspaceRoot.match(/^[A-Za-z]:[\\/]/)) {
    return { ok: false, error: 'workspaceRoot must be an absolute path (must start with /)' };
  }
  if (!rawNickname) return { ok: false, error: 'agentNickname is required' };
  if (rawNickname.length > 80) return { ok: false, error: 'agentNickname must be ≤ 80 characters' };
  if (!requestAgentAddress) {
    return { ok: false, error: 'cannot derive agent URI: no wallet address resolved from the bearer token' };
  }
  // `DKGAgent.resolveAgentAddress()` falls back to the node's peer ID
  // when no agent token / default wallet is configured. A peer ID is
  // NOT a canonical EVM address, so lowercasing it here would mint a
  // malformed `urn:dkg:agent:<peerId>` and bake it into the generated
  // `.dkg/config.yaml` as `agentUri`. Downstream (chat-capture,
  // manifest prov) would then emit non-dereferenceable agent URIs on
  // every turn. Fail fast so the operator sees the misconfiguration
  // immediately instead of silently poisoning the graph.
  if (!EVM_ADDRESS_RE.test(requestAgentAddress)) {
    return {
      ok: false,
      error:
        'cannot derive agent URI: the daemon resolved a non-EVM identifier ' +
        '(likely the node peer ID fallback). Configure a default wallet on the ' +
        'daemon or use a bearer token tied to an agent wallet before installing.',
    };
  }

  // Tool selection. Default to ['cursor'] when nothing's specified — the
  // single most common case. Claude Code requires explicit opt-in to avoid
  // the ~/.claude/settings.json pollution we hit during day-2 testing.
  let tools: SupportedTool[] = ['cursor'];
  if (Array.isArray(body.tools)) {
    tools = (body.tools as unknown[])
      .filter((t): t is SupportedTool =>
        t === 'cursor' || t === 'claude-code' || t === 'codex')
      .filter((t, i, a) => a.indexOf(t) === i);
    if (tools.length === 0) tools = ['cursor'];
  }

  // Resolve the MCP package via Node's resolver first, so the install
  // flow works when the daemon is running from a published
  // `@origintrail-official/dkg` package (no monorepo checkout). Falls
  // back to the repo layout. Codex tier-4g finding N7.
  const mcpDkgAssets = resolveMcpDkgAssets();
  // `daemonApiUrl` must come from the daemon's own trusted listening
  // socket, NOT from `req.headers.host` / `x-forwarded-proto`. Those
  // headers are attacker-controlled on any direct HTTP request: a
  // crafted Host header would get baked into the generated
  // `.dkg/config.yaml` and hooks config, so subsequent MCP/hook calls
  // would send the local bearer token to whatever origin the attacker
  // chose. Plain HTTP over loopback is what the daemon actually serves
  // by default, so this is also more accurate than trusting proxies.
  // `formatDaemonAuthority` handles IPv6 bracketing so binds to `::1`
  // or `fe80::…` produce valid URLs (`http://[::1]:9201`) instead of
  // the ambiguous `http://::1:9201`.
  const daemonAuthority = formatDaemonAuthority(daemonApiHost, daemonApiPort);
  const wallet = requestAgentAddress.toLowerCase();
  const agentUri = `urn:dkg:agent:${wallet}`;
  return {
    ok: true,
    context: {
      workspaceAbsPath: workspaceRoot,
      // The schema's required `agentSlug` placeholder gets the slug-shape
      // of the nickname so legacy templates that reference {{agentSlug}}
      // still substitute sensibly. Everything new uses {{agentNickname}}
      // (free-form) or {{agentUri}} (wallet-based).
      agentSlug: nicknameToSlug(rawNickname),
      daemonApiUrl: `http://${daemonAuthority}`,
      // Absolute default (the daemon's auth.token always lives at
      // <homedir>/.dkg/auth.token unless overridden). Avoids the ~/...
      // expansion-bug class entirely; still overridable by the operator.
      daemonTokenFile: typeof body.daemonTokenFile === 'string'
        ? body.daemonTokenFile
        : `${osModule.homedir()}/.dkg/auth.token`,
      mcpDkgDistAbsPath: mcpDkgAssets.distEntry,
      mcpDkgPackageDir: mcpDkgAssets.packageDir,
      // Legacy {{mcpDkgSrcAbsPath}} placeholder: only populated when
      // we're running from a monorepo checkout (src/ doesn't ship in
      // the published tarball). Modern templates reference the dist
      // entry so this being stale is fine.
      mcpDkgSrcAbsPath: resolve(mcpDkgAssets.packageDir, 'src', 'index.ts'),
      captureScriptPath: mcpDkgAssets.captureScript,
      tools,
      agentNickname: rawNickname,
      // Cryptographic agent URI derived from the daemon's wallet (the
      // requestAgentAddress resolved from the bearer token). planInstall
      // reads this directly from the context and feeds it into the
      // {{agentUri}} substitution; if we left it null the planner would
      // fall back to the legacy slug-based form, which is exactly what
      // the Phase-8-day-3-plus polish was meant to fix.
      agentUri,
      agentAddress: wallet,
    } as unknown as Omit<InstallContext, 'manifest'> & { tools: SupportedTool[]; agentNickname: string },
  };
}

export const _autoUpdateIo = {
  readFile,
  readdir: readdir as (...args: any[]) => Promise<any[]>,
  writeFile,
  mkdir,
  rm,
  chmod,
  copyFile,
  stat,
  rename,
  unlink,
  existsSync: existsSync as (...args: any[]) => boolean,
  readFileSync: readFileSync as (...args: any[]) => any,
  openSync: openSync as (...args: any[]) => number,
  closeSync: closeSync as (...args: any[]) => void,
  writeFileSync: fsWriteFileSync as (...args: any[]) => void,
  unlinkSync: unlinkSync as (...args: any[]) => void,
  exec: execAsync as (...args: any[]) => Promise<any>,
  execFile: execFileAsync as (...args: any[]) => Promise<any>,
  execSync: execSync as (...args: any[]) => any,
  dkgDir,
  releasesDir,
  activeSlot: activeSlot as () => Promise<'a' | 'b'>,
  inactiveSlot: inactiveSlot as () => Promise<'a' | 'b'>,
  swapSlot: swapSlot as (slot: 'a' | 'b') => Promise<void>,
  fetch: globalThis.fetch as typeof fetch,
  hasVerifiedBundledMarkItDownBinary: hasVerifiedBundledMarkItDownBinary as (...args: any[]) => Promise<boolean>,
  expectedBundledMarkItDownBuildMetadata: expectedBundledMarkItDownBuildMetadata as (...args: any[]) => any,
  readCliPackageVersion: readCliPackageVersion as (...args: any[]) => string | null,
};

let cachedMarkItDownTargets: MarkItDownTarget[] | null = null;

export function loadMarkItDownTargets(): MarkItDownTarget[] {
  if (cachedMarkItDownTargets) return cachedMarkItDownTargets;
  try {
    const raw = readFileSync(
      new URL("../../markitdown-targets.json", import.meta.url),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cachedMarkItDownTargets = [];
      return cachedMarkItDownTargets;
    }
    cachedMarkItDownTargets = parsed.filter(
      (entry): entry is MarkItDownTarget =>
        !!entry &&
        typeof entry === "object" &&
        typeof entry.platform === "string" &&
        typeof entry.arch === "string" &&
        typeof entry.assetName === "string",
    );
    return cachedMarkItDownTargets;
  } catch {
    cachedMarkItDownTargets = [];
    return cachedMarkItDownTargets;
  }
}

export function getNodeVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function getCurrentCommitShort(): string {
  try {
    const commitFile = join(dkgDir(), ".current-commit");
    return readFileSync(commitFile, "utf-8").trim().slice(0, 8);
  } catch {
    try {
      const rDir = releasesDir();
      const slotDir = existsSync(join(rDir, "current"))
        ? join(rDir, "current")
        : dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      return execSync("git rev-parse --short=8 HEAD", {
        encoding: "utf-8",
        stdio: "pipe",
        cwd: slotDir,
      }).trim();
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// SKILL.MD serving — Agent Skills standard (https://agentskills.io)
// ---------------------------------------------------------------------------

let cachedSkillMd: string | null = null;
let cachedSkillEtag: string | null = null;

export function loadSkillTemplate(): string {
  if (cachedSkillMd) return cachedSkillMd;
  const skillPath = new URL("../../skills/dkg-node/SKILL.md", import.meta.url);
  const content = readFileSync(skillPath, "utf-8");
  cachedSkillMd = content;
  return content;
}

export function buildSkillMd(opts: {
  version: string;
  baseUrl: string;
  peerId: string;
  nodeRole: string;
  extractionPipelines: string[];
}): string {
  const template = loadSkillTemplate();
  const dynamicSection = [
    `- **Node version:** ${opts.version}`,
    `- **Base URL:** ${opts.baseUrl}`,
    `- **Peer ID:** ${opts.peerId}`,
    `- **Node role:** ${opts.nodeRole}`,
    `- **Available extraction pipelines:** ${opts.extractionPipelines.length > 0 ? opts.extractionPipelines.join(", ") : "none (install markitdown to enable document conversion)"}`,
    '',
    'To see which context graphs (projects) are currently subscribed, call `GET /api/context-graph/list` — this returns a live list that stays current as projects are created or subscribed during the session.',
  ].join("\n");

  const staticPlaceholder =
    "> This section is dynamically generated from node state at serve-time.\n\n" +
    "- **Node version:** (dynamic)\n" +
    "- **Base URL:** (dynamic)\n" +
    "- **Peer ID:** (dynamic)\n" +
    "- **Node role:** (dynamic — `core` or `edge`)\n" +
    "- **Available extraction pipelines:** (dynamic)\n" +
    "\n" +
    "To see which context graphs (projects) are currently subscribed, call `GET /api/context-graph/list` — this returns a live list that stays current as projects are created or subscribed during the session.";

  return template.replace(staticPlaceholder, dynamicSection);
}

export function skillEtag(content: string): string {
  return (
    '"' + createHash("md5").update(content).digest("hex").slice(0, 16) + '"'
  );
}


export const DAEMON_EXIT_CODE_RESTART = 75;

/**
 * Validate and parse a `requiredSignatures` value from an API request body.
 * Returns `{ value }` on success or `{ error }` on failure.
 */
export function parseRequiredSignatures(
  raw: unknown,
): { value: number } | { error: string } {
  if (raw === undefined) return { value: 0 };
  if (typeof raw !== "number")
    return { error: "requiredSignatures must be a number" };
  if (!Number.isInteger(raw) || raw < 1)
    return { error: "requiredSignatures must be a positive integer (>= 1)" };
  return { value: raw };
}

export function normalizeDetectedContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0
    ? normalized
    : "application/octet-stream";
}

export function currentBundledMarkItDownAssetName(): string | null {
  return (
    loadMarkItDownTargets().find(
      (target) =>
        target.platform === process.platform && target.arch === process.arch,
    )?.assetName ?? null
  );
}

// SPARQL bindings returned by `agent.query()` / `/api/query` can arrive as
// either bare strings (quadstore internal path) or SPARQL-JSON objects like
// `{ value, type, datatype?, "xml:lang"? }` (the path that goes through the
// query-result normaliser). Calling `.match()` / `.trim()` on the object
// form throws at runtime, so every consumer must normalise the cell first.
export function bindingValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    const raw = (v as { value?: unknown }).value;
    return raw === null || raw === undefined ? '' : String(raw);
  }
  return String(v);
}

export async function carryForwardBundledMarkItDownBinary(opts: {
  sourceCandidates: string[];
  targetBinaryPath: string;
  log: (msg: string) => void;
  context: string;
  expectedMetadata: BundledMarkItDownMetadata | null;
}): Promise<boolean> {
  const { existsSync, mkdir, copyFile, stat, chmod, rm, rename, hasVerifiedBundledMarkItDownBinary } = _autoUpdateIo;
  for (const sourceBinaryPath of opts.sourceCandidates) {
    if (!existsSync(sourceBinaryPath)) continue;
    if (!(await hasVerifiedBundledMarkItDownBinary(sourceBinaryPath))) {
      opts.log(
        `${opts.context}: skipping active-slot bundled MarkItDown binary without a valid checksum sidecar (${sourceBinaryPath}).`,
      );
      continue;
    }
    if (
      !(await hasVerifiedBundledMarkItDownBinary(
        sourceBinaryPath,
        opts.expectedMetadata,
      ))
    ) {
      opts.log(
        `${opts.context}: skipping active-slot bundled MarkItDown binary with incompatible metadata (${sourceBinaryPath}).`,
      );
      continue;
    }
    await mkdir(dirname(opts.targetBinaryPath), { recursive: true });

    const sourceChecksumPath = markItDownChecksumPath(sourceBinaryPath);
    const sourceMetadataPath = markItDownMetadataPath(sourceBinaryPath);
    const targetChecksumPath = markItDownChecksumPath(opts.targetBinaryPath);
    const targetMetadataPath = markItDownMetadataPath(opts.targetBinaryPath);
    const tempSuffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempTargetBinaryPath = `${opts.targetBinaryPath}${tempSuffix}`;
    const tempTargetChecksumPath = `${targetChecksumPath}${tempSuffix}`;
    const tempTargetMetadataPath = `${targetMetadataPath}${tempSuffix}`;
    try {
      await copyFile(sourceBinaryPath, tempTargetBinaryPath);
      await copyFile(sourceChecksumPath, tempTargetChecksumPath);
      await copyFile(sourceMetadataPath, tempTargetMetadataPath);
      const sourceMode = (await stat(sourceBinaryPath)).mode & 0o777;
      await chmod(tempTargetBinaryPath, sourceMode || 0o755);
      await Promise.all([
        rm(opts.targetBinaryPath, { force: true }),
        rm(targetChecksumPath, { force: true }),
        rm(targetMetadataPath, { force: true }),
      ]);
      await rename(tempTargetBinaryPath, opts.targetBinaryPath);
      await rename(tempTargetChecksumPath, targetChecksumPath);
      await rename(tempTargetMetadataPath, targetMetadataPath);
      opts.log(
        `${opts.context}: reused bundled MarkItDown binary from the active slot (${sourceBinaryPath}).`,
      );
      return true;
    } catch (err: any) {
      await Promise.all([
        rm(tempTargetBinaryPath, { force: true }),
        rm(tempTargetChecksumPath, { force: true }),
        rm(tempTargetMetadataPath, { force: true }),
      ]);
      opts.log(
        `${opts.context}: failed to reuse bundled MarkItDown binary from the active slot (${sourceBinaryPath}) - ${err?.message ?? String(err)}.`,
      );
    }
  }
  return false;
}
