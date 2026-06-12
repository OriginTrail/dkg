/**
 * Drop-sweep + read-side regex-scope guards (per verification-plan v8 §0.10.7).
 *
 * Two future-regression tests, deliberately cheap:
 *
 * 1. **Drop-sweep** — the 10 tool names removed in `c222ddcf` (W2-#18) MUST
 *    NOT reappear in `tools/list` output. The bug-class-most-likely is a
 *    well-meaning re-registration during a future cycle ("oh that look
 *    useful, let me revive it") slipping past review because the surface
 *    was 24 before the change and 25 after. This test catches that at the
 *    suite level, not at the surface-probe level (which is harder to
 *    enforce in CI without a daemon).
 *
 *    Discipline mirrors §0.8 fixture 4 ("the cheap blanket guard"). Single
 *    array of names, single forEach assertion, one test.
 *
 * 2. **Read-side name-scope guard** — the create-side assertion-`name`
 *    validation (`validateAssertionName` — IRI-safe, ≤256 chars; FIX P aligned
 *    it to the daemon rule and dropped the old `/^[a-z0-9-]+$/` slug regex) is
 *    creator-side input validation only. Read-side / lookup-side tools
 *    (`dkg_knowledge_asset_write / share / finalize / publish / pull_from /
 *    discard / query` + `_history` + `_import_file`) MUST NOT inherit it —
 *    they look up assets that may have been minted by other agents whose
 *    names don't conform.
 *
 *    The bug-class-most-likely is an implementer copying the regex from
 *    `dkg_knowledge_asset_create` to all the lookup tools because they look symmetric
 *    ("name should always be slug-shaped, right?"). This test asserts the
 *    asymmetry by passing a non-conforming name to each read-side tool
 *    and confirming the schema does NOT reject it.
 *
 * The drop-sweep + tool-count test registers every production-side tool
 * module (all 7 register functions, mirroring `src/index.ts`) so the
 * assertions run against the full surface. Adding a new register function in
 * production without adding it here means this file silently under-covers — an
 * explicit regression in the next wave's W?-Q audit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerReadTools } from '../src/tools.js';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerPublishTools } from '../src/tools/publish.js';
import { registerChatTools } from '../src/tools/chat.js';
import { FakeServer, liveClient, liveConfig } from './live.js';

// NO MOCKS. These are pure surface-shape guards: tool registration and
// zod-schema acceptance. They build the REAL `DkgClient` (which is never
// invoked here — registration doesn't call it) and use `FakeServer.parse`
// (schema-only, no handler/network) for the name-scope checks. Nothing
// touches the daemon, so no node is needed and there is no fake daemon.

/**
 * The 10 tool names removed in W2-#18 (`c222ddcf`). Mirrors the audit's
 * §7 drop list. Surviving registration of any of these is a port-hygiene
 * regression — block.
 */
const DROPPED_TOOLS = [
  // V9-era / no SKILL.md analog (7):
  'dkg_review_manifest',
  'dkg_annotate_turn',
  'dkg_get_ontology',
  'dkg_get_chat',
  'dkg_set_session_privacy',
  'dkg_request_vm_publish',
  'dkg_search',
  // Coding-project sugar (3):
  'dkg_propose_decision',
  'dkg_add_task',
  'dkg_comment',
  // PR-B Codex review #672 (id=3302086584) — operator-only host-mode
  // subscribe MUST NOT have an agent-facing MCP entrypoint. Re-adding
  // here would re-open the trust-boundary regression flagged on
  // setup.ts:268: an agent could autonomously change which node hosts
  // a curated CG's opaque ciphertext, bypassing the curator's
  // authority. Operators still drive the manual path via the daemon's
  // `POST /api/shared-memory/host-mode/subscribe` route directly (see
  // `docs/runbooks/RUNBOOK_HOST_MODE_MANUAL_SUBSCRIBE.md`).
  'dkg_request_hosting',
] as const;

describe('drop-sweep — none of the 10 W2-dropped tools reappear in tools/list', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    const client = liveClient();
    const config = liveConfig();
    // Mirror src/index.ts (all 7 register* calls). If a new register* call lands
    // in production, add it here too.
    registerReadTools(server.asMcpServer(), client, config);
    registerAssertionTools(server.asMcpServer(), client, config);
    registerMemorySearchTool(server.asMcpServer(), client, config);
    registerSetupTools(server.asMcpServer(), client, config);
    registerHealthTools(server.asMcpServer(), client, config);
    registerPublishTools(server.asMcpServer(), client, config);
    registerChatTools(server.asMcpServer(), client, config);
  });

  it.each(DROPPED_TOOLS)('does not register %s', (name) => {
    expect(server.tools.has(name)).toBe(false);
  });

  // Locked count bumped to 25 in the `dkg_peer_info` PR (per-peer
  // diagnostics surface added under registerHealthTools after the
  // May 2026 soak postmortem), then to 26 by the PR4 honest-ACK
  // cleanup that added `dkg_request_hosting` under registerSetupTools
  // (the LU-6 Phase B operator UX sugar for
  // `POST /api/shared-memory/host-mode/subscribe`; see
  // `docs/runbooks/RUNBOOK_HOST_MODE_MANUAL_SUBSCRIBE.md`). Dropped
  // back to 25 in the PR-B Codex review fix (id=3302086584) — the
  // host-mode subscribe is operator-only and must not have an
  // agent-facing MCP entrypoint; see the `dkg_request_hosting` entry
  // in `DROPPED_TOOLS` for the trust-boundary rationale. Bump again
  // when a new tool is intentionally added, drop when a tool is
  // removed, and keep a comment trail so future drops are auditable.
  // rc.17 agent-tooling PR2: +3 net-new knowledge-asset lifecycle verbs
  // (finalize / publish / pull_from) under registerAssertionTools took the
  // assertion-module surface from 25 → 28. This fixture now registers ALL 7
  // production modules (incl. registerChatTools, +2), matching src/index.ts and
  // the README's "30 tools" — so the locked count is the full 30-tool surface
  // (previously this guard registered only 6 modules and locked 28, silently
  // under-covering registerChatTools).
  it('registered surface contains exactly 30 tools (full production surface, post-PR locked count)', () => {
    expect(server.tools.size).toBe(30);
  });
});

/**
 * Name-scope guard. The create-side `name` validation (`validateAssertionName`,
 * FIX P) applies ONLY to `dkg_knowledge_asset_create`'s `name` arg. Every other
 * tool that takes a `name` argument must accept richer strings.
 *
 * Test strategy: try a deliberately non-conforming name on each read-side
 * tool. The schema MUST NOT reject it (no -32602 / no zod throw at the
 * input boundary). `FakeServer.parse` runs ONLY the declared zod schema —
 * no handler, no network — which is exactly the gate under test ("schema
 * accepts the input"); the behavioural not-found path is the live suite's
 * business.
 */
describe('regex-scope guard — read-side `name` arg accepts non-conforming slugs', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerAssertionTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  // The read-side / lookup-side knowledge-asset tools. `dkg_knowledge_asset_create`
  // is INTENTIONALLY excluded — it IS the regex-bearing tool.
  it.each([
    ['dkg_knowledge_asset_write', { name: 'Bad Name With Spaces', quads: [{ subject: 'urn:x', predicate: 'urn:p', object: '"v"' }] }],
    ['dkg_knowledge_asset_share', { name: 'Bad Name With Spaces' }],
    ['dkg_knowledge_asset_finalize', { name: 'Bad Name With Spaces' }],
    ['dkg_knowledge_asset_publish', { name: 'Bad Name With Spaces' }],
    ['dkg_knowledge_asset_pull_from', { name: 'Bad Name With Spaces', layer: 'swm' }],
    ['dkg_knowledge_asset_discard', { name: 'Bad Name With Spaces' }],
    ['dkg_knowledge_asset_query', { name: 'Bad Name With Spaces' }],
    ['dkg_knowledge_asset_history', { name: 'Bad Name With Spaces' }],
  ])('%s schema accepts non-slug `name` (no zod throw at input boundary)', (toolName, args) => {
    // If a future change adds the create-side validation to read-side
    // schemas, this parse throws a ZodError and the test fails.
    expect(() => server.parse(toolName, args)).not.toThrow();
  });

  // Positive control: dkg_knowledge_asset_create DOES validate the name
  // (validateAssertionName — rejects IRI-unsafe names like one with spaces).
  // Re-asserting here so the asymmetry is visible in this file alone — a reviewer
  // reading just `drop-sweep.test.ts` can see why the read-side test exists.
  it('positive control: dkg_knowledge_asset_create rejects an IRI-unsafe `name` (validated creator-side)', () => {
    expect(() =>
      server.parse('dkg_knowledge_asset_create', { name: 'Bad Name With Spaces' }),
    ).toThrow();
  });
});
