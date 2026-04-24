#!/usr/bin/env node
// One-shot helper that slices the 5,491-line `daemon/handle-request.ts`
// into per-route-group modules under `daemon/routes/`. Run once during
// the refactor; re-runs reset to the baseline (HEAD of
// refactor/split-cli-daemon) and overwrite the outputs. Kept in-tree
// alongside `split-daemon.mjs` as a reviewable record.
//
// Strategy:
//   - `handleRequest` is a flat cascade of ~84 `if (method && path ...)`
//     dispatch blocks. No closures or between-block setup live at its
//     base indentation — the preamble (url/path/requestToken/
//     requestAgentAddress) is the only non-dispatch code in the body.
//   - Each block is tagged with a route-group. Dispatch between groups
//     is done in the surviving `handleRequest` shell by checking
//     `res.writableEnded` after each group handler, so NO edits to
//     route bodies are required — each block is moved verbatim.
//   - A single `RequestContext` type in `routes/context.ts` bundles
//     the 24 parameters `handleRequest` used to take plus the 4
//     derived locals (url, path, requestToken, requestAgentAddress).
//     Each group function destructures ctx on entry.
//   - Relative imports shift one level deeper: `./state.js` becomes
//     `../state.js`, `../config.js` becomes `../../config.js`, etc.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, '..');
const SRC = resolve(CLI_ROOT, 'src');
const DAEMON_DIR = resolve(SRC, 'daemon');
const HANDLE_REQUEST = resolve(DAEMON_DIR, 'handle-request.ts');
const ROUTES_DIR = resolve(DAEMON_DIR, 'routes');

// ---------- Reset baseline ----------
// Restore handle-request.ts to its HEAD state so re-runs are deterministic.
// Also wipe a stale routes/ dir so removed groups don't linger.
//
// Set `SKIP_RESET=1` in the environment to bypass the git-reset step —
// useful when running the script's anchor-validation pass against a
// manually staged source file (e.g. when re-pinning sentinels after a
// new route is added in a separate branch).
if (process.env.SKIP_RESET !== '1') {
  try {
    execSync(`git checkout HEAD -- ${HANDLE_REQUEST}`, { stdio: 'pipe' });
  } catch {
    // first run, or outside a git worktree — fine
  }
}
if (existsSync(ROUTES_DIR)) rmSync(ROUTES_DIR, { recursive: true, force: true });
mkdirSync(ROUTES_DIR, { recursive: true });

const source = readFileSync(HANDLE_REQUEST, 'utf8');
const lines = source.split('\n');

// ---------- Constants tied to the post-PR-1 baseline ----------

// First line of the first route block (GET /.well-known/skill.md).
const FIRST_ROUTE_LINE = 379;
// Last line belonging to the final route block (inclusive). Line 5490
// is the 404 fallthrough, which stays in the surviving shell.
const LAST_ROUTE_LINE_INCL = 5400;
// Line of the 404 fallthrough inside the shell.
const FALLTHROUGH_LINE = 5401;

// ---------- Route blocks: [startLine, group, sentinel] ----------
//
// startLine points at the `if (req.method && path ...)` line OR — for
// match-based routes like `const joinMatch = path.match(...)` — at the
// `const xMatch = ...` line that precedes the `if`. Leading JSDoc and
// blank lines above this line are absorbed automatically by
// `walkBackComments` below.
//
// `sentinel` is one or more pipe-separated substrings that MUST appear
// inside the 16-line window starting at `startLine`. The script aborts
// before writing any output if any sentinel is missing — that turns
// every silent line-number drift in `handle-request.ts` into a loud
// pre-flight failure. To re-pin after intentional source edits, run
// the script's `--print-anchors` mode (described in `validateAnchors`)
// and paste the new sentinels back into this table.
//
// Groups are chosen by pathname prefix. Within a group, blocks keep
// their original relative order (matters for `startsWith` fallthrough,
// e.g. the 7 `/api/assertion/...` blocks).
const BLOCKS = [
  [379, 'status', '/.well-known/skill.md'], // GET /.well-known/skill.md
  [415, 'status', '/api/status'], // GET /api/status
  [464, 'status', '/api/info'], // GET /api/info
  [496, 'status', '/api/connections'], // GET /api/connections
  [519, 'agent-chat', '/api/agent/register'], // POST /api/agent/register
  [545, 'agent-chat', '/api/agent/identity'], // GET /api/agent/identity
  [562, 'agent-chat', '/api/agents'], // GET /api/agents
  [612, 'agent-chat', '/api/peer-info'], // GET /api/peer-info
  [641, 'agent-chat', '/api/skills'], // GET /api/skills
  [650, 'agent-chat', '/api/invoke-skill'], // POST /api/invoke-skill
  [690, 'agent-chat', '/api/chat'], // POST /api/chat
  [733, 'agent-chat', '/api/messages'], // GET /api/messages
  [755, 'openclaw', '/api/openclaw-agents'], // GET /api/openclaw-agents
  [785, 'openclaw', '/api/chat-openclaw'], // POST /api/chat-openclaw
  [865, 'openclaw', '/api/openclaw-channel/send'], // POST /api/openclaw-channel/send
  [991, 'openclaw', '/api/openclaw-channel/stream'], // POST /api/openclaw-channel/stream
  [1163, 'openclaw', '/api/openclaw-channel/persist-turn'], // POST /api/openclaw-channel/persist-turn
  [1223, 'openclaw', '/api/openclaw-channel/health'], // GET /api/openclaw-channel/health
  [1228, 'agent-chat', '/api/connect'], // POST /api/connect
  [1243, 'agent-chat', '/api/update'], // POST /api/update
  [1318, 'memory', '/api/shared-memory/write|/api/workspace/write'], // multi-line if
  [1378, 'memory', '/api/shared-memory/publish|/api/workspace/enshrine'], // multi-line if
  [1463, 'publisher', '/api/publisher/enqueue'], // POST /api/publisher/enqueue
  [1515, 'publisher', '/api/publisher/jobs'], // GET /api/publisher/jobs
  [1527, 'publisher', '"/api/publisher/job"'], // GET /api/publisher/job (quote-anchored to disambiguate from /jobs and /job-payload)
  [1539, 'publisher', '/api/publisher/job-payload'], // GET /api/publisher/job-payload
  [1552, 'publisher', '/api/publisher/jobs/'], // GET /api/publisher/jobs/* (trailing slash anchors startsWith)
  [1569, 'publisher', '/api/publisher/stats'], // GET /api/publisher/stats
  [1575, 'publisher', '/api/publisher/cancel'], // POST /api/publisher/cancel
  [1590, 'publisher', '/api/publisher/retry'], // POST /api/publisher/retry
  [1608, 'publisher', '/api/publisher/clear'], // POST /api/publisher/clear
  [1630, 'context-graph', '/api/context-graph/create'], // POST /api/context-graph/create
  [1761, 'context-graph', '/api/context-graph/register'], // POST /api/context-graph/register
  [1802, 'context-graph', '/api/context-graph/invite'], // POST /api/context-graph/invite
  [1833, 'context-graph', '/api/sub-graph/create'], // POST /api/sub-graph/create
  [1868, 'context-graph', '/api/sub-graph/list'], // GET /api/sub-graph/list
  [1931, 'assertion', '/api/assertion/create'], // POST /api/assertion/create
  [1966, 'assertion', '/api/assertion/|/write'], // multi-line if — assertion write
  [2013, 'assertion', '/api/assertion/|/query'], // multi-line if — assertion query
  [2054, 'assertion', '/api/assertion/|/promote'], // multi-line if — assertion promote
  [2096, 'assertion', '/api/assertion/|/discard'], // multi-line if — assertion discard
  [2144, 'assertion', '/api/assertion/|/history'], // multi-line if — assertion history
  [2207, 'assertion', '/api/assertion/|/import-file'], // multi-line if — assertion import-file
  [3116, 'assertion', '/api/assertion/|/extraction-status'], // late fallthrough — extraction-status
  [3169, 'assertion', '/api/file/'], // GET /api/file/*
  [3209, 'memory', '/api/shared-memory/conditional-write'], // multi-line if
  [3254, 'query', '/api/query'], // POST /api/query
  [3477, 'query', '/api/genui/render'], // POST /api/genui/render
  [3659, 'query', '/api/query-remote'], // POST /api/query-remote
  [3712, 'context-graph', 'addParticipantMatch = path.match'], // /context-graph/:id/add-participant
  [3730, 'context-graph', 'removeParticipantMatch = path.match'], // /context-graph/:id/remove-participant
  [3748, 'context-graph', 'listParticipantsMatch = path.match'], // /context-graph/:id/participants
  [3763, 'context-graph', 'requestJoinMatch = path.match'], // /context-graph/:id/request-join
  [3792, 'context-graph', 'joinRequestsMatch = path.match'], // /context-graph/:id/join-requests
  [3805, 'context-graph', 'approveJoinMatch = path.match'], // /context-graph/:id/approve-join
  [3821, 'context-graph', 'rejectJoinMatch = path.match'], // /context-graph/:id/reject-join
  [3837, 'context-graph', 'signJoinMatch = path.match'], // /context-graph/:id/sign-join
  [3880, 'context-graph', 'manifestPublishMatch = path.match'], // /context-graph/:id/manifest/publish
  [3979, 'context-graph', 'manifestPlanInstallMatch = path.match'], // /context-graph/:id/manifest/plan-install
  [4072, 'context-graph', 'manifestInstallMatch = path.match'], // /context-graph/:id/manifest/install
  [4152, 'status', '/api/host/info'], // GET /api/host/info
  [4181, 'context-graph', '/api/context-graph/subscribe|/api/subscribe'], // multi-line if
  [4324, 'query', '/api/sync/catchup-status'], // GET /api/sync/catchup-status
  [4354, 'context-graph', '/api/paranet/create'], // POST /api/paranet/create
  [4382, 'context-graph', '/api/context-graph/rename|/api/paranet/rename'], // multi-line if
  [4409, 'context-graph', '/api/context-graph/list|/api/paranet/list'], // multi-line if
  [4421, 'local-agents', '/api/local-agent-integrations'], // GET /api/local-agent-integrations
  [4428, 'local-agents', '/api/local-agent-integrations/'], // GET /api/local-agent-integrations/*
  [4437, 'local-agents', '/api/local-agent-integrations/connect'], // POST /api/local-agent-integrations/connect
  [4458, 'local-agents', '/api/local-agent-integrations/|/refresh'], // multi-line if — disconnect/etc
  [4482, 'local-agents', '/api/local-agent-integrations/'], // PUT /api/local-agent-integrations/*
  [4523, 'status', '/api/integrations'], // GET /api/integrations
  [4538, 'status', '/api/register-adapter'], // POST /api/register-adapter
  [4567, 'context-graph', '/api/context-graph/exists|/api/paranet/exists'], // multi-line if
  [4579, 'query', '/api/verify'], // POST /api/verify
  [4609, 'query', '/api/endorse'], // POST /api/endorse
  [4661, 'query', '/api/ccl/policy/publish'], // POST /api/ccl/policy/publish
  [4692, 'query', '/api/ccl/policy/approve'], // POST /api/ccl/policy/approve
  [4718, 'query', '/api/ccl/policy/revoke'], // POST /api/ccl/policy/revoke
  [4744, 'query', '/api/ccl/policy/list'], // GET /api/ccl/policy/list
  [4756, 'query', '/api/ccl/policy/resolve'], // GET /api/ccl/policy/resolve
  [4774, 'query', '/api/ccl/eval'], // POST /api/ccl/eval
  [4819, 'query', '/api/ccl/results'], // GET /api/ccl/results
  [4841, 'status', '/api/wallet|/api/wallets'], // multi-line if
  [4852, 'status', '/api/wallets/balances'], // GET /api/wallets/balances
  [4922, 'status', '/api/chain/rpc-health'], // GET /api/chain/rpc-health
  [4957, 'status', '"/api/identity"'], // GET /api/identity (quote-anchored to distinguish from /identity/ensure)
  [4966, 'status', '/api/identity/ensure'], // POST /api/identity/ensure
  [4983, 'status', '/api/shutdown'], // POST /api/shutdown
  [4990, 'epcis', '/api/epcis/events'], // GET /api/epcis/events
  [5024, 'epcis', '/api/epcis/capture'], // POST /api/epcis/capture
  [5087, 'memory', '/api/memory/turn'], // POST /api/memory/turn
  [5280, 'memory', '/api/memory/search'], // POST /api/memory/search
];

// ---------- Structural anchors ----------
//
// These pin the few line numbers used outside `BLOCKS` (import block,
// signature, body preamble, last route, fallthrough). Each entry is
// `[lineNum, expectedSubstring, label]` and is checked in
// `validateAnchors()` below. Same drift-detection contract as the
// per-block sentinels.
const STRUCTURAL_ANCHORS = [
  [11, 'import {', 'top-of-file imports start'],
  [328, "} from './local-agents.js';", 'imports end (last from-spec)'],
  [340, 'export async function handleRequest(', 'handleRequest signature'],
  [
    376,
    'const requestAgentAddress = agent.resolveAgentAddress(requestToken)',
    'body preamble end (requestAgentAddress)',
  ],
  [FIRST_ROUTE_LINE, '/.well-known/skill.md', 'first route block'],
  [
    FALLTHROUGH_LINE,
    "jsonResponse(res, 404, { error: 'Not found' })",
    '404 fallthrough',
  ],
];

// ---------- Anchor validation ----------
//
// Called immediately after reading `handle-request.ts` and BEFORE any
// output is written. Throws on the first mismatch with a precise
// pointer at the offending anchor and a recovery hint. Per-block
// sentinels are matched against a 16-line window starting at the
// anchor (covers multi-line `if (` conditions); structural anchors
// match against the single line they point at.
function assertAnchorWindow(startLine1, sentinel, label, windowSize = 16) {
  const startIdx = startLine1 - 1;
  if (startIdx < 0 || startIdx >= lines.length) {
    throw new Error(
      `split-handle-request.mjs: ${label} expected line ${startLine1}, ` +
        `but handle-request.ts only has ${lines.length} lines. ` +
        `Re-pin BLOCKS / STRUCTURAL_ANCHORS against the new baseline.`,
    );
  }
  const seg = lines.slice(startIdx, startIdx + windowSize).join('\n');
  const required = sentinel.split('|');
  const missing = required.filter((s) => !seg.includes(s));
  if (missing.length > 0) {
    const preview = lines
      .slice(startIdx, startIdx + 4)
      .map((l, i) => `    ${startLine1 + i}: ${l}`)
      .join('\n');
    throw new Error(
      `split-handle-request.mjs: ${label} mismatch at line ${startLine1}.\n` +
        `  expected window to contain: ${missing.map((s) => JSON.stringify(s)).join(', ')}\n` +
        `  source window head:\n${preview}\n` +
        `  Likely cause: handle-request.ts shifted under your feet — ` +
        `re-pin the BLOCKS / STRUCTURAL_ANCHORS sentinels against the new baseline before re-running.`,
    );
  }
}

function validateAnchors() {
  for (const [ln, sentinel, label] of STRUCTURAL_ANCHORS) {
    assertAnchorWindow(ln, sentinel, label, 1);
  }
  for (const [ln, group, sentinel] of BLOCKS) {
    assertAnchorWindow(ln, sentinel, `BLOCKS[${ln}, '${group}']`);
  }
}

validateAnchors();

// Order in which groups are dispatched by the surviving `handleRequest`
// shell. Derived directly from `BLOCKS` (each group enters the dispatch
// chain at its first appearance), so this stays in lock-step with
// `BLOCKS` itself instead of being a second hand-maintained list. That
// closes the silent-shadowing regression flagged on PR #259: a future
// `startsWith(...)` or `path.match(...)` route in a broader group can no
// longer override an exact route in another group simply because the
// dispatch list happens to put it first.
//
// The original top-to-bottom flow inside the monolithic `handleRequest`
// already ordered groups by first appearance (the comment table is the
// audit trail), so this derivation is behaviour-identical to the
// previously hand-maintained list — the assertion below pins that.
const DISPATCH_ORDER = [];
for (const [, group] of BLOCKS) {
  if (!DISPATCH_ORDER.includes(group)) DISPATCH_ORDER.push(group);
}

// Belt-and-suspenders: pin the derived dispatch order so a future
// reorder of `BLOCKS` (e.g. someone re-pinning a sentinel by re-pasting
// the table) can't silently change shell dispatch behaviour. To
// intentionally change the order, update `EXPECTED_DISPATCH_ORDER` in
// the same commit and explain the rationale in the diff.
const EXPECTED_DISPATCH_ORDER = [
  'status',
  'agent-chat',
  'openclaw',
  'memory',
  'publisher',
  'context-graph',
  'assertion',
  'query',
  'local-agents',
  'epcis',
];
if (
  DISPATCH_ORDER.length !== EXPECTED_DISPATCH_ORDER.length ||
  DISPATCH_ORDER.some((g, i) => g !== EXPECTED_DISPATCH_ORDER[i])
) {
  throw new Error(
    `split-handle-request.mjs: dispatch order drifted.\n` +
      `  derived from BLOCKS: ${JSON.stringify(DISPATCH_ORDER)}\n` +
      `  expected:           ${JSON.stringify(EXPECTED_DISPATCH_ORDER)}\n` +
      `Either re-order BLOCKS to restore the expected dispatch order, ` +
      `or update EXPECTED_DISPATCH_ORDER in the same commit and explain ` +
      `the behaviour change in the diff.`,
  );
}

// ---------- Block boundary computation ----------

// Walk upward from `startLine1` (1-indexed) absorbing contiguous
// comment-only (// or JSDoc) and blank lines. Returns the earliest
// line that should be considered part of the block.
function walkBackComments(startLine1) {
  let s = startLine1;
  while (s > FIRST_ROUTE_LINE) {
    const prev = lines[s - 2]; // 0-indexed
    const t = prev.trim();
    const isComment =
      t === '' ||
      t.startsWith('//') ||
      t.startsWith('/*') ||
      t.startsWith('*') ||
      t === '*/';
    if (isComment) {
      s--;
    } else break;
  }
  return s;
}

// Expand block boundaries: each block runs from its (comment-absorbed)
// start up to — but not including — the next block's (comment-absorbed)
// start. The last block runs through LAST_ROUTE_LINE_INCL.
const expanded = BLOCKS.map(([ln, g], i) => {
  const extStart = walkBackComments(ln);
  const rawNext =
    i + 1 < BLOCKS.length ? BLOCKS[i + 1][0] : LAST_ROUTE_LINE_INCL + 1;
  return { group: g, rawStart: ln, start: extStart, rawNext };
});
for (let i = 0; i + 1 < expanded.length; i++) {
  expanded[i].endExcl = walkBackComments(expanded[i + 1].rawStart);
}
expanded[expanded.length - 1].endExcl = LAST_ROUTE_LINE_INCL + 1;

// ---------- Group slices ----------

const groupSlices = Object.fromEntries(
  DISPATCH_ORDER.map((g) => [g, []]),
);
for (const seg of expanded) {
  const slice = lines.slice(seg.start - 1, seg.endExcl - 1).join('\n');
  groupSlices[seg.group].push(slice);
}

// ---------- Shared kitchen-sink import header ----------
//
// Every route file gets the SAME imports as the current
// handle-request.ts, with each relative path shifted one level deeper
// (daemon/ → daemon/routes/). `noUnusedLocals: false` in the project's
// tsconfig tolerates unused imports — this keeps each route file
// self-contained and mirrors the PR #1 kitchen-sink-header pattern.

// Deepen every relative import path by one `../`. External package
// imports (anything that doesn't start with `./` or `../`) are left
// alone.
function deepenImportPath(spec) {
  if (spec.startsWith('./')) return '../' + spec.slice(2);
  if (spec.startsWith('../')) return '../' + spec;
  return spec;
}

// Extract the full import block from the top of handle-request.ts.
// It runs from line 11 (`import { createServer, ... } from "node:http"`)
// through line 328 (closing of `from './local-agents.js';`). Line 329
// is blank, 330 is `// ... `, 331 is `export function resolveAutoUpdateEnabled`.
const RAW_IMPORTS_START = 11;
const RAW_IMPORTS_END_INCL = 328;
const rawImportBlock = lines
  .slice(RAW_IMPORTS_START - 1, RAW_IMPORTS_END_INCL)
  .join('\n');

// Rewrite each `from '...'` path in the block to deepen relative paths.
let deepenedImports = rawImportBlock.replace(
  /from\s+(['"])([^'"]+)\1/g,
  (_m, q, spec) => `from ${q}${deepenImportPath(spec)}${q}`,
);

// `resolveAutoUpdateEnabled` lives in `state.ts` (moved out of the
// shell to break a would-be routes/→handle-request cycle), so splice
// it into the state.js import block. The existing handle-request.ts
// source imports only `daemonState` and `CorsAllowlist` from state.
deepenedImports = deepenedImports.replace(
  /(import \{\s*\n\s*daemonState,\s*\n)/,
  `$1  DEBUG_SYNC_TRACE,\n  resolveAutoUpdateEnabled,\n`,
);

const ROUTE_FILE_HEADER = (groupLabel, groupComment) => `// daemon/routes/${groupLabel}.ts
//
// Route handlers for ${groupComment}.
//
// Extracted verbatim from the legacy monolithic \`handleRequest\` —
// every block is a contiguous slice of the original source with zero
// edits to route bodies. Dispatch is driven by the surviving
// \`handle-request.ts\` shell, which awaits each group handler in
// sequence and uses \`res.writableEnded\` to short-circuit once a
// route claims the request.
//
// See \`packages/cli/scripts/split-handle-request.mjs\` for the
// extraction driver.

${deepenedImports}

import type { RequestContext } from './context.js';
`;

const GROUP_DOC = {
  'status': 'status, info, connections, host, wallet, chain, identity, integrations, shutdown',
  'agent-chat': 'agent registration/identity/listing, skills, chat, messages, connect, update',
  'openclaw': 'OpenClaw agent listing, chat, channel send/stream/persist-turn/health',
  'memory': 'shared-memory / workspace write + publish + conditional-write, memory turn/search',
  'publisher': 'publisher enqueue / jobs / stats / cancel / retry / clear',
  'context-graph': 'context-graph (+ paranet, sub-graph) CRUD, participants, join flow, manifest publish/install',
  'assertion': 'assertion CRUD + import + file download',
  'query': 'SPARQL query, GenUI render, catchup-status, verify, endorse, CCL policy + eval',
  'local-agents': 'local-agent-integrations list / connect / update / reverse / refresh',
  'epcis': 'EPCIS events + capture',
};

// Friendly per-group slug → PascalCase function name.
function pascal(slug) {
  return slug
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
const handlerFnName = (slug) => `handle${pascal(slug)}Routes`;

// All names that could legitimately appear as free references inside a
// route body. `RequestContext` bundles these; each group function
// destructures them on entry.
const CTX_FIELDS = [
  'req',
  'res',
  'agent',
  'publisherControl',
  'config',
  'startedAt',
  'dashDb',
  'opWallets',
  'network',
  'tracker',
  'memoryManager',
  'bridgeAuthToken',
  'nodeVersion',
  'nodeCommit',
  'catchupTracker',
  'extractionRegistry',
  'fileStore',
  'extractionStatus',
  'assertionImportLocks',
  'vectorStore',
  'embeddingProvider',
  'validTokens',
  'apiHost',
  'apiPortRef',
  'url',
  'path',
  'requestToken',
  'requestAgentAddress',
];

// `const` destructure runs over several lines for readability.
const CTX_DESTRUCTURE =
  '  const {\n' +
  CTX_FIELDS.map((f) => `    ${f},`).join('\n') +
  '\n  } = ctx;';

// ---------- Emit `daemon/routes/context.ts` ----------

const CONTEXT_TS = `// daemon/routes/context.ts
//
// Per-request context bag passed to every route-group handler.
// Bundles the 24 parameters \`handleRequest\` used to take plus the 4
// derived locals (url, path, requestToken, requestAgentAddress) so
// route-group modules destructure exactly once on entry and route
// bodies can keep referring to bare names — identical to how they
// looked inside the monolithic \`handleRequest\`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DKGAgent, OpWalletsConfig } from '@origintrail-official/dkg-agent';
import type { ExtractionPipelineRegistry } from '@origintrail-official/dkg-core';
import type {
  ChatMemoryManager,
  DashboardDB,
  OperationTracker,
} from '@origintrail-official/dkg-node-ui';
import type { DkgConfig, loadNetworkConfig } from '../../config.js';
import type { createPublisherControlFromStore } from '../../publisher-runner.js';
import type { ExtractionStatusRecord } from '../../extraction-status.js';
import type { FileStore } from '../../file-store.js';
import type { VectorStore, EmbeddingProvider } from '../../vector-store.js';
import type { CatchupTracker } from '../types.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  agent: DKGAgent;
  publisherControl: ReturnType<typeof createPublisherControlFromStore>;
  config: DkgConfig;
  startedAt: number;
  dashDb: DashboardDB;
  opWallets: OpWalletsConfig;
  network: Awaited<ReturnType<typeof loadNetworkConfig>>;
  tracker: OperationTracker;
  memoryManager: ChatMemoryManager;
  bridgeAuthToken: string | undefined;
  nodeVersion: string;
  nodeCommit: string;
  catchupTracker: CatchupTracker;
  extractionRegistry: ExtractionPipelineRegistry;
  fileStore: FileStore;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  assertionImportLocks: Map<string, Promise<void>>;
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider | null;
  validTokens: Set<string>;
  // API socket identity — trusted server-side state for manifestSelfClient
  // SSRF defence.
  apiHost: string;
  apiPortRef: { value: number };
  // Derived per-request (from req.url + headers + token). Routes read
  // \`path\`, \`url\`, \`requestAgentAddress\` extensively; pre-computing
  // here keeps every group on the same fast path.
  url: URL;
  path: string;
  requestToken: string | undefined;
  requestAgentAddress: string;
}
`;

writeFileSync(resolve(ROUTES_DIR, 'context.ts'), CONTEXT_TS);

// ---------- Emit each `daemon/routes/<group>.ts` ----------

for (const group of DISPATCH_ORDER) {
  const slices = groupSlices[group];
  const header = ROUTE_FILE_HEADER(group, GROUP_DOC[group]);
  const fnName = handlerFnName(group);

  const body = [
    header,
    '',
    `export async function ${fnName}(ctx: RequestContext): Promise<void> {`,
    CTX_DESTRUCTURE,
    '',
    slices.join('\n'),
    '}',
    '',
  ].join('\n');

  writeFileSync(resolve(ROUTES_DIR, `${group}.ts`), body);
}

// ---------- Emit the new `handle-request.ts` shell ----------

// The shell keeps:
//   - The exact same module-level imports (so tests that mock against
//     specific module specifiers keep working).
//   - The `resolveAutoUpdateEnabled` helper (module-level export used
//     by lifecycle.ts).
//   - The `handleRequest` signature unchanged.
// The function body becomes:
//   1. Derive url / path / token / agent address (as before).
//   2. Build `ctx` once.
//   3. For each group: `await handle<Group>Routes(ctx); if (res.writableEnded) return;`
//   4. Fall through to `jsonResponse(res, 404, ...)`.
//
// Because every response path ends the writable stream (via
// `jsonResponse`/`res.end`), `res.writableEnded` is a reliable "handled"
// signal and lets us move route bodies verbatim without rewriting any
// `return;` / `return jsonResponse(...);` statements.

// Lines 1..328 = top-of-file imports (closing brace of the last
// `from './local-agents.js';` is on 328).
// Lines 329..338 = blank + `DEBUG_SYNC_TRACE` (moved to state.ts) +
//                  blank + `resolveAutoUpdateEnabled` helper (moved to
//                  state.ts) — both stripped from the shell.
// Lines 339..376 = blank + `export async function handleRequest(` signature
//                  + body preamble (url / path / token / agent address).
const TOP_IMPORTS_END_INCL = 328;
const SIGNATURE_START = 339; // start of blank line before handleRequest signature
const BODY_PREAMBLE_END_INCL = 376;

const topImports = lines.slice(0, TOP_IMPORTS_END_INCL).join('\n');
// Skip the helper: take only the blank + `handleRequest` signature +
// body preamble. The helper now lives in state.ts.
const signatureAndPreamble = lines
  .slice(SIGNATURE_START - 1, BODY_PREAMBLE_END_INCL)
  .join('\n');

const ROUTE_IMPORTS = DISPATCH_ORDER.map(
  (g) => `import { ${handlerFnName(g)} } from './routes/${g}.js';`,
).join('\n');

const CTX_BUILD =
  '  const ctx: RequestContext = {\n' +
  CTX_FIELDS.map((f) => `    ${f},`).join('\n') +
  '\n  };';

const DISPATCH_CALLS = DISPATCH_ORDER.map(
  (g) =>
    `  await ${handlerFnName(g)}(ctx);\n  if (res.writableEnded) return;`,
).join('\n\n');

const shellBody = `${topImports}
import type { RequestContext } from './routes/context.js';
${ROUTE_IMPORTS}

${signatureAndPreamble}

${CTX_BUILD}

${DISPATCH_CALLS}

  jsonResponse(res, 404, { error: 'Not found' });
}
`;

writeFileSync(HANDLE_REQUEST, shellBody);

// ---------- Summary ----------
const sizes = Object.fromEntries(
  DISPATCH_ORDER.map((g) => [
    g,
    readFileSync(resolve(ROUTES_DIR, `${g}.ts`), 'utf8').split('\n').length,
  ]),
);
const shellLines = readFileSync(HANDLE_REQUEST, 'utf8').split('\n').length;

console.log('split-handle-request.mjs: emitted routes/ and rewrote handle-request.ts');
console.log(`  handle-request.ts: ${shellLines} lines (was ${lines.length})`);
for (const g of DISPATCH_ORDER) {
  console.log(`  routes/${g}.ts: ${sizes[g]} lines`);
}
