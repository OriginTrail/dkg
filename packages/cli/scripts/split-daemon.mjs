#!/usr/bin/env node
// One-shot refactor helper that slices the monolithic `daemon.ts`
// (~10.5k lines) into focused sibling files under `daemon/`. Run once,
// during the refactor; re-runs overwrite the output. Kept in-tree as a
// reviewable record of what was moved where.
//
// Strategy:
//   - Hand-specified line ranges per target module (verified against
//     v10-rc@84b4cf6e, 10,484 lines of source + 1 trailing newline).
//   - Each extracted file gets a hand-authored import header.
//   - `export` is prepended to every top-level *function / class /
//     type / interface / enum* declaration that isn't already
//     exported. Module-private `let`/`const`/`var` declarations are
//     LEFT UNEXPORTED — they were intentionally module-private in
//     the original.
//   - Shared mutable state from the old module-level `let` bindings
//     was lifted into `./state.ts` (`daemonState.*`) before this
//     extraction; the call-site rewrite step below patches references
//     in extracted bodies the same way.
//   - After extraction, `daemon.ts` becomes a pure barrel re-export
//     of every public symbol from the new sub-modules.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, '..');
const SRC = resolve(CLI_ROOT, 'src');
const DAEMON = resolve(SRC, 'daemon.ts');
const OUT = resolve(SRC, 'daemon');

const source = readFileSync(DAEMON, 'utf8');
const lines = source.split('\n');

const getRange = (fromLine1, toLine1) => lines.slice(fromLine1 - 1, toLine1).join('\n');

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// ---------- Headers (hand-authored per module) ----------

const TYPES_HEADER = `// daemon/types.ts
//
// Pure type/interface declarations used across the daemon sub-modules.
// Kept intentionally lean — \`PublishQuad\` / \`PublishRequestBody\` /
// \`PublishAccessPolicy\` deliberately stay in \`./http-utils.ts\` because
// the body parser is their only semantic consumer.

import type { CatchupJobResult } from '../catchup-runner.js';
`;

const MANIFEST_HEADER = `// Manifest / semver / skill-template / bundled-MarkItDown helpers
// extracted from the legacy monolithic \`daemon.ts\`. Scope: helpers used
// by the Phase-8 \`/api/context-graph/{id}/manifest/*\` routes, the
// \`/.well-known/skill.md\` endpoint, and the auto-update binary
// carry-forward flow. Pure functions with small caches; no HTTP
// routing logic lives here.

import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, openSync, closeSync, unlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import {
  appendFile, chmod, copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile,
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
`;

const HTTP_UTILS_HEADER = `// HTTP request/response utilities extracted from the legacy monolithic
// \`daemon.ts\`. Body parsing, JSON validators, CORS resolution, the
// loopback rate-limiter, plus small helpers used across route handlers.
// Pure helpers; the rate-limiter class is the only stateful piece and
// is instantiated per-daemon-boot by \`runDaemonInner\`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PayloadTooLargeError,
  validateContextGraphId,
  validateSubGraphName,
  isSafeIri,
} from '@origintrail-official/dkg-core';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DkgConfig } from '../config.js';

// Co-located here because the body parser is their only semantic
// consumer; moving them to \`./types.ts\` would just add an import
// cycle with no real benefit.
export interface PublishQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export type PublishAccessPolicy = 'public' | 'ownerOnly' | 'allowList';

export interface PublishRequestBody {
  paranetId: string;
  quads: PublishQuad[];
  privateQuads?: PublishQuad[];
  accessPolicy?: PublishAccessPolicy;
  allowedPeers?: string[];
  subGraphName?: string;
}

import type { CorsAllowlist } from './state.js';
`;

const AUTO_UPDATE_HEADER = `// Auto-update subsystem extracted from the legacy monolithic
// \`daemon.ts\`. Two independent flavours of update: \`performNpmUpdate\`
// (standalone npm-installed \`dkg\` binary) and \`performUpdate\` (dkg-v9
// monorepo checkout, blue/green release slots). Live "last check"
// state is shared with \`handleRequest\`'s \`/status\` endpoint via
// \`daemonState\` in \`./state.js\`.

import { execSync, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, readFileSync, openSync, closeSync, unlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import {
  readFile, writeFile, mkdir, rm, chmod, copyFile, stat, rename, unlink,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  dkgDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  gitCommandArgs,
  gitCommandEnv,
  isStandaloneInstall,
  slotEntryPoint,
  CLI_NPM_PACKAGE,
  type DkgConfig,
  type AutoUpdateConfig,
} from '../config.js';
import {
  _autoUpdateIo,
  DAEMON_EXIT_CODE_RESTART,
  currentBundledMarkItDownAssetName,
  carryForwardBundledMarkItDownBinary,
} from './manifest.js';
import { daemonState } from './state.js';
import {
  expectedBundledMarkItDownBuildMetadata,
  readCliPackageVersion,
} from '../extraction/markitdown-bundle-metadata.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const daemonRequire = createRequire(import.meta.url);
`;

const OPENCLAW_HEADER = `// OpenClaw channel/bridge/attach machinery extracted from the legacy
// monolithic \`daemon.ts\`. Owns the gateway helpers, UI-attach job
// machinery, channel headers, the streaming pipe, attachment-ref
// normalisation, and provenance verification.
//
// Bridge health cache lives in \`./state.ts\` (mutated from
// \`handle-request.ts\` after each /send round trip).
// \`pendingOpenClawUiAttachJobs\` is module-private working memory
// and is intentionally not exported.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  contextGraphAssertionUri,
  contextGraphMetaUri,
  isSafeIri,
  validateSubGraphName,
  type Logger,
} from '@origintrail-official/dkg-core';
import {
  dkgDir,
  saveConfig,
  loadConfig,
  type DkgConfig,
  type LocalAgentIntegrationConfig,
  type LocalAgentIntegrationTransport,
} from '../config.js';
import {
  type ExtractionStatusRecord,
  getExtractionStatusRecord,
} from '../extraction-status.js';
import { daemonState } from './state.js';
import { normalizeDetectedContentType } from './manifest.js';
// Cycle: local-agents imports lots from openclaw, and openclaw needs
// these two getters from local-agents. TS handles the cycle because
// every reference is inside a function body (not module-init).
import {
  getStoredLocalAgentIntegrations,
  getLocalAgentIntegration,
} from './local-agents.js';

const daemonRequire = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Tiny module-private helper duplicated from \`./local-agents.ts\` to
// avoid a deeper cycle (the canonical \`isPlainRecord\` is only used
// within local-agents normalisation; openclaw uses it once for
// attachment-ref normalisation).
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
`;

const LOCAL_AGENTS_HEADER = `// Local-agent integration code extracted from the legacy monolithic
// \`daemon.ts\`. Owns the integration registry, normalize/merge
// helpers, and the UI-driven connect / reverse / refresh flows that
// drive Hermes / OpenClaw setup from the node UI.
//
// Heavy on calls into \`./openclaw.ts\` for the actual transport
// machinery. Stays separate so the local-agent vocabulary
// (definitions, records, statuses) doesn't pollute the openclaw
// module.

import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  loadConfig,
  saveConfig,
  dkgDir,
  type DkgConfig,
  type LocalAgentIntegrationCapabilities,
  type LocalAgentIntegrationConfig,
  type LocalAgentIntegrationManifest,
  type LocalAgentIntegrationRuntime,
  type LocalAgentIntegrationStatus,
  type LocalAgentIntegrationTransport,
} from '../config.js';
import { daemonState } from './state.js';
// Pull every needed symbol from openclaw — including the previously
// module-private helpers that handle-request and these flows reach
// into.
import {
  OpenClawChannelTarget,
  OpenClawChannelHealthReport,
  OpenClawUiAttachDeps,
  cancelPendingLocalAgentAttachJob,
  scheduleOpenClawUiAttachJob,
  isOpenClawUiAttachCancelled,
  formatOpenClawUiAttachFailure,
  getOpenClawChannelTargets,
  isOpenClawMemorySlotElected,
  probeOpenClawChannelHealth,
  runOpenClawUiSetup,
  restartOpenClawGateway,
  waitForOpenClawChatReady,
  transportPatchFromOpenClawTarget,
  ensureOpenClawBridgeAvailable,
  buildOpenClawChannelHeaders,
  trimTrailingSlashes,
  buildOpenClawGatewayBase,
  loadBridgeAuthToken,
  localOpenclawConfigPath,
} from './openclaw.js';

const daemonRequire = createRequire(import.meta.url);
`;

// Read once so we can build the kitchen-sink import block for
// lifecycle / handle-request from the original imports section.
// All `./xxx.js` paths in the original were relative to
// `packages/cli/src/`; from `packages/cli/src/daemon/` they need
// `../xxx.js` instead. Rewrite in one pass.
function rewriteSrcRelativeImports(block) {
  return block.replace(
    /from\s+(['"])\.\/([^'"]+)\1/g,
    'from $1../$2$1',
  ).replace(
    /from\s+(['"])\.\.\/scripts\//g,
    'from $1../../scripts/',
  );
}
const ORIGINAL_TOP_IMPORTS = rewriteSrcRelativeImports(lines.slice(0, 128).join('\n'));
// And the app-loader import that was wedged in mid-file.
const APP_LOADER_IMPORT = rewriteSrcRelativeImports(lines.slice(737, 743).join('\n'));

// Build the kitchen-sink import block lazily, after all other
// modules are extracted (so we know exactly what they export). The
// header for lifecycle / handle-request is constructed in the
// second pass below.
function buildKitchenSinkImports() {
  const SIBLING_FILES = [
    'state.ts',
    'types.ts',
    'manifest.ts',
    'http-utils.ts',
    'auto-update.ts',
    'openclaw.ts',
    'local-agents.ts',
  ];
  const blocks = SIBLING_FILES.map((file) => {
    const modName = file.replace(/\.ts$/, '');
    const decls = file === 'state.ts'
      ? [{ name: 'daemonState', isType: false }, { name: 'CorsAllowlist', isType: true }]
      : (publicSymbolsByModule[file] ?? []);
    if (decls.length === 0) return '';
    const specs = decls.map((d) => (d.isType ? `type ${d.name}` : d.name));
    return `import {\n  ${specs.join(',\n  ')},\n} from './${modName}.js';`;
  }).filter(Boolean);
  return `${ORIGINAL_TOP_IMPORTS}
${APP_LOADER_IMPORT}

// Daemon sub-module imports — every public symbol from sibling
// modules is pulled in here because the legacy monolithic file used
// them all without explicit imports. Unused ones are tolerated by
// the project's tsconfig (\`noUnusedLocals\` is off).
${blocks.join('\n')}
`;
}

const LIFECYCLE_HEADER_PROLOGUE = `// daemon/lifecycle.ts
//
// \`runDaemon\` + \`runDaemonInner\` extracted verbatim from the legacy
// monolithic \`daemon.ts\`. Owns the daemon boot sequence: PID file,
// config load, agent construction, http server, signal handling,
// shutdown.
//
// The router (\`handleRequest\`) is in \`./handle-request.ts\` and
// imported here purely so \`createServer\` can wire it up.

`;

const HANDLE_REQUEST_HEADER_PROLOGUE = `// daemon/handle-request.ts
//
// The \`handleRequest\` HTTP router (~5,160 lines) extracted verbatim
// from the legacy monolithic \`daemon.ts\`. Single switch over URL
// pathnames; called per-request by the http server set up in
// \`./lifecycle.ts\`.
//
// Splitting this internally by route group is the next AI-DX win
// and is queued as a follow-up PR.

`;

// `forceExport` lists const/let/var declarations that need to be
// promoted to `export` even though our default exportify pass leaves
// `const` alone (most module-level consts in the original were
// internal). Anything in this list is also added to the kitchen-sink
// import block for lifecycle/handle-request.
const PLAN = [
  { file: 'types.ts',          slices: [[870, 895]],                                     header: TYPES_HEADER, forceExport: [] },
  { file: 'manifest.ts',       slices: [[129, 736], [744, 860]],                         header: MANIFEST_HEADER, forceExport: [] },
  {
    file: 'http-utils.ts',
    slices: [[8824, 9394]],
    header: HTTP_UTILS_HEADER,
    // Body size limits + the reused ImportFile response constant
    // are referenced by handle-request.ts.
    forceExport: ['MAX_BODY_BYTES', 'SMALL_BODY_BYTES', 'MAX_UPLOAD_BYTES'],
  },
  { file: 'auto-update.ts',    slices: [[9396, 10483]],                                  header: AUTO_UPDATE_HEADER, forceExport: [] },
  // Slice boundaries are sensitive to JSDoc comments that "belong"
  // to the next-block's first declaration. See the original v10-rc
  // baseline lines 2277 (openclaw section header comment) and
  // 2934-2939 (CONTRACT JSDoc on connectLocalAgentIntegrationFromUi).
  {
    file: 'openclaw.ts',
    slices: [[2277, 2329], [2608, 2933], [3231, 3660]],
    header: OPENCLAW_HEADER,
    // Constants referenced from handle-request.ts (HTTP route
    // closure timeout) and the openclaw `bridgeHealthCache` accessor.
    forceExport: [
      'OPENCLAW_CHANNEL_RESPONSE_TIMEOUT_MS',
      'OPENCLAW_UI_CONNECT_TIMEOUT_MS',
      'OPENCLAW_UI_CONNECT_POLL_MS',
    ],
  },
  {
    file: 'local-agents.ts',
    slices: [[2223, 2276], [2330, 2606], [2934, 3229]],
    header: LOCAL_AGENTS_HEADER,
    // The handler menu in `handle-request.ts` reads this directly
    // when listing supported integrations.
    forceExport: ['LOCAL_AGENT_INTEGRATION_DEFINITIONS'],
  },
  // Headers for these two are deferred until kitchen-sink imports are
  // built; placeholder is replaced inside the extraction loop.
  { file: 'lifecycle.ts',      slices: [[917, 2219]],                                    header: null, forceExport: [], deferredHeader: 'lifecycle' },
  { file: 'handle-request.ts', slices: [[3662, 8822]],                                   header: null, forceExport: [], deferredHeader: 'handle-request' },
];

// ---------- Top-level declaration scanner ----------

// Match a top-level declaration anchored at column 0.
const DECL_RE = /^(export\s+)?(?:(async\s+)?function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)|type\s+(\w+)|interface\s+(\w+)|enum\s+(\w+))\b/gm;

// Heuristic: identifiers that should remain module-private even
// though they're top-level declarations (\`function\` / \`class\` /
// \`type\` / \`interface\` / \`enum\`). Mostly internal helpers and
// bundled-asset cache markers.
function isPrivateIdentifier(name) {
  if (name.startsWith('_')) return true;
  if (name.startsWith('cached')) return true;
  if (name === 'REPO_ROOT_MARKERS') return true;
  if (name === 'EVM_ADDRESS_RE') return true;
  return false;
}

function exportifyDeclarations(body) {
  return body.replace(DECL_RE, (match, already, _async, fn, cls, varName, typeName, iface, enm) => {
    if (already) return match;
    // Only auto-export functions / classes / types / interfaces /
    // enums. Module-level `let`/`const`/`var` bindings stay as
    // authored — anything that needed to be public was already
    // marked `export const ...` in the original.
    if (varName) return match;
    const name = fn || cls || typeName || iface || enm;
    if (!name) return match;
    if (isPrivateIdentifier(name)) return match;
    return `export ${match}`;
  });
}

// Scan a (post-exportify) body for `export ...` declarations.
const EXPORTED_RE = /^export\s+(?:default\s+)?(?:(?:async\s+)?function\s+(\w+)|class\s+(\w+)|(?:const|let|var)\s+(\w+)|type\s+(\w+)|interface\s+(\w+)|enum\s+(\w+))\b/gm;

function collectPublicDeclarations(body) {
  const names = [];
  for (const m of body.matchAll(EXPORTED_RE)) {
    const fn = m[1], cls = m[2], varName = m[3], typeName = m[4], iface = m[5], enm = m[6];
    const name = fn || cls || varName || typeName || iface || enm;
    if (!name) continue;
    const isType = Boolean(typeName || iface);
    names.push({ name, isType });
  }
  return names;
}

// ---------- Process each module ----------

// `daemonState.foo` rewrites to apply uniformly to every extracted
// body so module-level mutable state continues to round-trip
// correctly via the canonical state object.
function rewriteSharedState(body) {
  return body
    .replace(/\blastUpdateCheck\b/g, 'daemonState.lastUpdateCheck')
    .replace(/\bisUpdating\s*=\s*/g, 'daemonState.isUpdating = ')
    .replace(/\bif\s*\(\s*isUpdating\s*\)/g, 'if (daemonState.isUpdating)')
    .replace(/\breturn\s+isUpdating\s*;/g, 'return daemonState.isUpdating;')
    .replace(/\bdaemonCatchupRunner\b/g, 'daemonState.catchupRunner')
    .replace(/\b_moduleCorsAllowed\b/g, 'daemonState.moduleCorsAllowed')
    .replace(/\b_standaloneCache\b/g, 'daemonState.standaloneCache')
    // bridgeHealthCache is mutated from handle-request.ts (after
    // each /send round trip) AND read from openclaw.ts; lives in
    // daemonState so both modules see the same instance.
    .replace(/\nlet bridgeHealthCache: \{[^}]*\} \| null = null;\n/, '\n')
    .replace(/\bbridgeHealthCache\b/g, 'daemonState.openClawBridgeHealth');
}

const publicSymbolsByModule = {};

for (const mod of PLAN) {
  let body = mod.slices.map(([f, t]) => getRange(f, t)).join('\n\n');

  // Remove duplicate type definitions from extracted bodies whose
  // canonical home is now elsewhere.
  if (mod.file === 'http-utils.ts') {
    body = body.replace(/\ntype CorsAllowlist = "\*" \| string\[\];\n/, '\n');
  }

  // The handle-request slice still contains `let _standaloneCache`
  // at line 3661 — wait, our slice starts at 3662 so it's already
  // excluded. Same for `let _moduleCorsAllowed` (2221) — excluded
  // by lifecycle.ts ending at 2219.

  // `new URL("../foo", import.meta.url)` in the original daemon.ts
  // resolved relative to `packages/cli/src/`. After moving into the
  // `daemon/` sub-directory, `..` only goes back up to `src/`, so
  // bundled assets disappear. Rewrite every such URL to `../../...`
  // so the resolution is identical to the original.
  body = body.replace(
    /new URL\("\.\.\/([^"]+)"/g,
    'new URL("../../$1"',
  );

  // Same depth fix for the two hard-coded `dist/`-relative repo-root
  // walks in the manifest helpers and the lifecycle node-ui fallback.
  // Pre-split they walked from `packages/cli/dist/daemon.js`; post-split
  // they walk from `packages/cli/dist/daemon/<module>.js` — one level
  // deeper, so each walk needs one extra `..` to land at the repo root
  // (or the `packages/` directory in lifecycle's case).
  if (mod.file === 'manifest.ts') {
    body = body.replace(
      /resolve\(daemonDir, '\.\.', '\.\.', '\.\.'\)/g,
      `resolve(daemonDir, '..', '..', '..', '..')`,
    );
    // Update the manifestRepoRoot doc comment that still names the old
    // `dist/daemon.js` path / three-level walk.
    body = body.replace(
      ` * The daemon ships at packages/cli/dist/daemon.js, so the repo root\n * is three levels up.`,
      ` * The daemon ships at packages/cli/dist/daemon/manifest.js, so the\n * repo root is four levels up.`,
    );
    // Inject a short context comment ahead of the resolveMcpDkgAssets
    // repo-fallback walk so future maintainers see why the depth is 4
    // and not 3.
    body = body.replace(
      /(\n)(  const daemonDir = dirname\(fileURLToPath\(import\.meta\.url\)\);\n  const repoRoot = resolve\(daemonDir, '\.\.', '\.\.', '\.\.', '\.\.'\);)/,
      `$1  // Repo-fallback: from packages/cli/dist/daemon/manifest.js, four\n  // \`..\` segments land at the monorepo root. PR #258 nested this\n  // module under dist/daemon/, so the original three-level walk was\n  // off by one and landed inside packages/, pointing at the bogus\n  // <root>/packages/packages/mcp-dkg path.\n$2`,
    );
  }
  if (mod.file === 'lifecycle.ts') {
    body = body.replace(
      /(\bresolve\(\s*\n\s*dirname\(fileURLToPath\(import\.meta\.url\)\),\s*\n\s*)"\.\.",\s*\n(\s*)"\.\.",\s*\n(\s*)"node-ui",/,
      `$1"..",\n$2"..",\n$3"..",\n$3"node-ui",`,
    );
    // Annotate the node-ui fallback walk so the extra `..` doesn't
    // look accidental on later passes through this code.
    body = body.replace(
      `  // Resolve the static UI directory (built by @origintrail-official/dkg-node-ui)\n  let nodeUiStaticDir: string;`,
      `  // Resolve the static UI directory (built by @origintrail-official/dkg-node-ui)\n  //\n  // The last fallback walks the filesystem from THIS module's compiled\n  // location. PR #258 nests this module under \`dist/daemon/lifecycle.js\`,\n  // one level deeper than the pre-split \`dist/lifecycle.js\` layout, so\n  // the relative walk needs one extra \`..\` to land at the monorepo's\n  // \`packages/\` directory. Without it, dashboard assets resolve to\n  // \`packages/cli/node-ui/dist-ui\` and 404 on the rare paths that hit\n  // this branch (when both \`import.meta.resolve\` and \`repoDir()\` fail).\n  let nodeUiStaticDir: string;`,
    );
  }

  body = rewriteSharedState(body);

  let exported = exportifyDeclarations(body);

  // Apply forceExport: promote specific const/let/var declarations
  // that the default exportify pass leaves alone but that downstream
  // modules need to import (e.g. body-size limits, openclaw timeouts).
  for (const name of mod.forceExport ?? []) {
    const re = new RegExp(String.raw`^(const|let|var)\s+${name}\b`, 'm');
    if (!re.test(exported)) {
      throw new Error(`forceExport: ${name} not found in ${mod.file}`);
    }
    exported = exported.replace(re, `export $1 ${name}`);
  }

  publicSymbolsByModule[mod.file] = collectPublicDeclarations(exported);

  let header = mod.header;
  if (mod.deferredHeader) {
    const kitchen = buildKitchenSinkImports();
    if (mod.deferredHeader === 'lifecycle') {
      header = `${LIFECYCLE_HEADER_PROLOGUE}${kitchen}\nimport { handleRequest } from './handle-request.js';\n`;
    } else if (mod.deferredHeader === 'handle-request') {
      header = `${HANDLE_REQUEST_HEADER_PROLOGUE}${kitchen}\n`;
    }
  }

  const contents = `${header}\n${exported}\n`;
  writeFileSync(resolve(OUT, mod.file), contents);
  console.log(
    `wrote ${mod.file}: ${contents.split('\n').length} lines, ${publicSymbolsByModule[mod.file].length} public decls`,
  );
}

// ---------- Rebuild daemon.ts as a pure barrel ----------

const allSlices = PLAN.flatMap((m) => m.slices).sort((a, b) => a[0] - b[0]);
for (let i = 1; i < allSlices.length; i++) {
  if (allSlices[i][0] <= allSlices[i - 1][1]) {
    throw new Error(`overlapping slices: ${allSlices[i - 1]} vs ${allSlices[i]}`);
  }
}

const BARREL = `// Split-refactor barrel: every helper that used to live inline in
// this 10.5k-line file now lives under \`./daemon/*.ts\`. External
// consumers (cli.ts, tests) import from \`./daemon.js\`, so we re-
// export every public symbol here. See \`./daemon/index.ts\` for the
// per-module barrel used inside the refactor.

export { daemonState, type CorsAllowlist } from './daemon/state.js';
export * from './daemon/types.js';
export * from './daemon/manifest.js';
export * from './daemon/http-utils.js';
export * from './daemon/auto-update.js';
export * from './daemon/openclaw.js';
export * from './daemon/local-agents.js';
export * from './daemon/lifecycle.js';
export * from './daemon/handle-request.js';
`;

writeFileSync(DAEMON, BARREL);
console.log(`rewrote daemon.ts: ${BARREL.split('\n').length} lines (was ${lines.length})`);

// ---------- Update daemon/index.ts barrel ----------

const INDEX = `// Barrel for the split \`daemon\` module.
//
// The original \`packages/cli/src/daemon.ts\` became unmanageable at
// ~10.5k lines. This directory hosts the sub-modules it was cut into;
// the barrel re-exports every public symbol so consumers can import
// from \`./daemon/index.js\` without depending on the internal file
// layout.
//
// Cross-cutting mutable module state that used to live at the top
// level of the old daemon.ts is kept in \`./state.js\` so the split
// modules share one canonical instance.

export { daemonState, type CorsAllowlist } from './state.js';
export * from './types.js';
export * from './manifest.js';
export * from './http-utils.js';
export * from './auto-update.js';
export * from './openclaw.js';
export * from './local-agents.js';
export * from './lifecycle.js';
export * from './handle-request.js';
`;

writeFileSync(resolve(OUT, 'index.ts'), INDEX);
console.log('wrote daemon/index.ts');
