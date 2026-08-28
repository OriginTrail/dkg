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
 * module (all 8 register functions, mirroring `src/index.ts`) so the
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
import { registerChatTools } from '../src/tools/chat.js';
import { registerQueryCatalogTools } from '../src/tools/query-catalog.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

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
    const client = new FakeClient();
    const config = makeConfig();
    // Mirror src/index.ts (all 8 register* calls). If a new register* call lands
    // in production, add it here too.
    registerReadTools(server.asMcpServer(), client.asDkgClient(), config);
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), config);
    registerMemorySearchTool(server.asMcpServer(), client.asDkgClient(), config);
    registerSetupTools(server.asMcpServer(), client.asDkgClient(), config);
    registerHealthTools(server.asMcpServer(), client.asDkgClient(), config);
    registerChatTools(server.asMcpServer(), client.asDkgClient(), config);
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), config);
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
  // addressed-read provenance PR: +1 net-new read tool
  // (dkg_get_entity_sources) — describes an entity's facts each tagged with
  // the verifiable KA source — taking the surface from 30 → 31.
  // #1087 API-tooling cleanup (W2): the whole publish.ts module is deleted —
  // -2 tools (dkg_publish + dkg_shared_memory_publish), taking the surface from
  // 31 → 29. The one-shot is NOT a new tool: it EXTENDS dkg_knowledge_asset_create
  // with optional quads + alsoShareSwm [D3], so the count drops by exactly 2.
  // PCA-agent CG registration: +1 explicit on-chain registration tool, taking
  // the full surface from 29 → 30.
  // Query-catalog MCP facade: +3 contract-backed tools (list / run / save),
  // taking the complete production surface from 30 → 33. List and run are
  // read-only; save is an explicit local-state mutation.
  it('registered surface contains exactly 33 tools (full production surface, post-PR locked count)', () => {
    expect(server.tools.size).toBe(33);
  });
});

/**
 * Name-scope guard. The create-side `name` validation (`validateAssertionName`,
 * FIX P) applies ONLY to `dkg_knowledge_asset_create`'s `name` arg. Every other
 * tool that takes a `name` argument must accept richer strings.
 *
 * Test strategy: try a deliberately non-conforming name on each read-side
 * tool. The schema MUST NOT reject it (no -32602 / no zod throw at the
 * input boundary). The handler may then return a "not found" empty result
 * or whatever — that's behavioural, not the gate. The gate is "schema
 * accepts the input."
 */
describe('regex-scope guard — read-side `name` arg accepts non-conforming slugs', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    const config = makeConfig();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), config);
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
  ])('%s schema accepts non-slug `name` (no zod throw at input boundary)', async (toolName, args) => {
    // Don't care what the handler returns — it'll behaviourally produce a
    // not-found result against the empty FakeClient state. The assertion
    // is that the schema parse layer does NOT reject the input shape.
    // If a future change adds the create-side regex to read-side schemas,
    // this call rejects with a ZodError and the test fails.
    await expect(server.call(toolName, args)).resolves.toBeDefined();
  });

  // Positive control: dkg_knowledge_asset_create DOES validate the name
  // (validateAssertionName — rejects IRI-unsafe names like one with spaces).
  // Re-asserting here so the asymmetry is visible in this file alone — a reviewer
  // reading just `drop-sweep.test.ts` can see why the read-side test exists.
  it('positive control: dkg_knowledge_asset_create rejects an IRI-unsafe `name` (validated creator-side)', async () => {
    await expect(
      server.call('dkg_knowledge_asset_create', { name: 'Bad Name With Spaces' }),
    ).rejects.toThrow();
  });
});
