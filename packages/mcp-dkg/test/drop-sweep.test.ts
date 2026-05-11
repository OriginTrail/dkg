/**
 * Drop-sweep + read-side regex-scope guards (per verification-plan v8 §0.10.7).
 *
 * Two future-regression tests, deliberately cheap:
 *
 * 1. **Drop-sweep** — the 10 tool names removed in `c222ddcf` (W2-#18) MUST
 *    NOT reappear in `tools/list` output. The bug-class-most-likely is a
 *    well-meaning re-registration during a future cycle ("oh that look
 *    useful, let me revive it") slipping past review because the surface
 *    was 21 before the change and 22 after. This test catches that at the
 *    suite level, not at the surface-probe level (which is harder to
 *    enforce in CI without a daemon).
 *
 *    Discipline mirrors §0.8 fixture 4 ("the cheap blanket guard"). Single
 *    array of names, single forEach assertion, one test.
 *
 * 2. **Read-side regex-scope guard** — per matrix v0.5 §4.16 alignment
 *    paragraph, the `/^[a-z0-9-]+$/` regex on the assertion `name` argument
 *    is creator-side input validation only. Read-side / lookup-side tools
 *    (`dkg_assertion_write / promote / discard / query` + `_history` +
 *    `_import_file`) MUST NOT inherit it — they look up assertions that
 *    may have been minted by other agents whose names don't conform.
 *
 *    The bug-class-most-likely is an implementer copying the regex from
 *    `dkg_assertion_create` to all five tools because they look symmetric
 *    ("name should always be slug-shaped, right?"). This test asserts the
 *    asymmetry by passing a non-conforming name to each read-side tool
 *    and confirming the schema does NOT reject it.
 *
 * Both tests register every production-side tool module (6 register
 * functions, mirroring `src/index.ts`) so the assertions run against the
 * full surface. Adding a new register function in production without
 * adding it here means this file silently under-covers — an explicit
 * regression in the next wave's W?-Q audit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerReadTools } from '../src/tools.js';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerPublishTools } from '../src/tools/publish.js';
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
] as const;

describe('drop-sweep — none of the 10 W2-dropped tools reappear in tools/list', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    const client = new FakeClient();
    const config = makeConfig();
    // Mirror src/index.ts. If a new register* call lands in production, add it here too.
    registerReadTools(server.asMcpServer(), client.asDkgClient(), config);
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), config);
    registerMemorySearchTool(server.asMcpServer(), client.asDkgClient(), config);
    registerSetupTools(server.asMcpServer(), client.asDkgClient(), config);
    registerHealthTools(server.asMcpServer(), client.asDkgClient(), config);
    registerPublishTools(server.asMcpServer(), client.asDkgClient(), config);
  });

  it.each(DROPPED_TOOLS)('does not register %s', (name) => {
    expect(server.tools.has(name)).toBe(false);
  });

  it('registered surface contains exactly 21 tools (post-PR locked count)', () => {
    expect(server.tools.size).toBe(21);
  });
});

/**
 * Regex-scope guard. Production source (matrix v0.5 §4.16 alignment paragraph)
 * documents that the slug regex applies ONLY to `dkg_assertion_create`'s
 * `name` arg. Every other tool that takes a `name` argument must accept
 * richer strings.
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

  // The four read-side / lookup-side assertion tools. `dkg_assertion_create` is
  // INTENTIONALLY excluded — it IS the regex-bearing tool.
  it.each([
    ['dkg_assertion_write', { name: 'Bad Name With Spaces', quads: [{ subject: 'urn:x', predicate: 'urn:p', object: '"v"' }] }],
    ['dkg_assertion_promote', { name: 'Bad Name With Spaces' }],
    ['dkg_assertion_discard', { name: 'Bad Name With Spaces' }],
    ['dkg_assertion_query', { name: 'Bad Name With Spaces' }],
    ['dkg_assertion_history', { name: 'Bad Name With Spaces' }],
  ])('%s schema accepts non-slug `name` (no zod throw at input boundary)', async (toolName, args) => {
    // Don't care what the handler returns — it'll behaviourally produce a
    // not-found result against the empty FakeClient state. The assertion
    // is that the schema parse layer does NOT reject the input shape.
    // If a future change adds the create-side regex to read-side schemas,
    // this call rejects with a ZodError and the test fails.
    await expect(server.call(toolName, args)).resolves.toBeDefined();
  });

  // Positive control: dkg_assertion_create DOES enforce the regex (per
  // assertion-lifecycle.test.ts:81). Re-asserting here so the asymmetry is
  // visible in this file alone — a reviewer reading just `drop-sweep.test.ts`
  // can see why the read-side test exists.
  it('positive control: dkg_assertion_create rejects non-slug `name` (regex IS enforced creator-side)', async () => {
    await expect(
      server.call('dkg_assertion_create', { name: 'Bad Name With Spaces' }),
    ).rejects.toThrow();
  });
});
