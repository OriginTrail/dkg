/**
 * MCP agent-tool-surface ↔ daemon endpoint contract (static, always-on).
 *
 * Why this test exists
 * --------------------
 * The MCP agent tools talk to the DKG daemon over HTTP through
 * `DkgClient` (`src/client.ts`). Every other test in this package mocks
 * the fetcher (see `knowledge-assets-client.test.ts`, which returns
 * `{ ok: true }` for ANY url): they pin the *outgoing request shape* but
 * can never notice when the daemon RENAMES or REMOVES the endpoint the
 * client targets. That blind spot is exactly how the agent tool surface
 * drifted out of sync with "the new API and KA logic" — the daemon route
 * moved, the client kept POSTing to the old path, and every mocked test
 * stayed green.
 *
 * What this catches that the mocked tests can't
 * ---------------------------------------------
 * This test reads BOTH sides of the contract straight from source — no
 * daemon, no network, runs on every PR — and asserts that every
 * `/api/...` endpoint the MCP client calls is still served by a daemon
 * route handler:
 *
 *   - Literal route rename/removal (e.g. `/api/query` → `/api/sparql`):
 *     the client's `"/api/query"` no longer has a matching
 *     `path === "/api/query"` on the daemon → FAIL.
 *   - Knowledge-Asset lifecycle verb rename (e.g. `vm/publish` →
 *     `vm/mint`): the daemon's `verb === "publish"` dispatch disappears
 *     → FAIL.
 *
 * What it deliberately does NOT cover
 * -----------------------------------
 * Request/response *field* drift and *semantic* drift (e.g. a renamed
 * body field, a changed `view` enum value, a different status code) are
 * invisible to a static path check. Those are covered by the opt-in live
 * round-trip in `mcp-daemon-contract.integration.test.ts`, which drives
 * the real tool surface against a running node. The two tests are
 * complementary: this one is the cheap every-PR net for the most common
 * (endpoint) drift; the live one is the deep on-demand net for the rest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ── Load the client source (comments stripped) ──────────────────────
// We strip comments so JSDoc that mentions retired routes (e.g. the
// "legacy /api/assertion/* routes are retired" note in client.ts) is not
// mistaken for a live call site.
const clientSrcRaw = readFileSync(join(here, '../src/client.ts'), 'utf8');
const clientSrc = stripComments(clientSrcRaw);

// ── Load + normalise the daemon route sources ───────────────────────
// All route handlers live in packages/cli/src/daemon/routes/*.ts. They
// dispatch literal routes with `path === "/api/..."` and the KA family
// with `path === \`${PREFIX}/...\`` (PREFIX === "/api/knowledge-assets")
// plus segment parsing (`verb === "write"` …). Normalise the PREFIX
// template + the bare `=== PREFIX` create-route check into plain literals
// so the matchers below compare apples to apples.
// Comment-strip every route file BEFORE matching (Codex review on PR #1075):
// without this, the `quoted` fallback below can be satisfied by a JSDoc or
// error string that still mentions a REMOVED route, leaving a dead client
// path looking "served".
const routesDir = join(here, '../../cli/src/daemon/routes');
const daemonSrc = readdirSync(routesDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => stripComments(readFileSync(join(routesDir, f), 'utf8')))
  .join('\n')
  .replace(/\$\{PREFIX\}/g, '/api/knowledge-assets')
  .replace(/===\s*PREFIX\b/g, '=== "/api/knowledge-assets"');

// The KA family route file alone — used for the descriptor-GET dispatch
// check, which is specific to that file's segment parser.
const kaRouteSrc = stripComments(
  readFileSync(join(routesDir, 'knowledge-assets.ts'), 'utf8'),
);

function stripComments(src: string): string {
  // Whole-line `//` comments are removed BEFORE block comments on purpose:
  // a line comment that mentions a glob like `/api/*` contains a literal
  // `/*` that would otherwise open a phantom block-comment match and eat
  // real dispatch code up to the next `*/` (this exact case lives in
  // agent-chat.ts and silently swallowed `path === "/api/chat"` — Codex
  // review on PR #1075). Stripping line comments first deletes that `/*`
  // before the block pass can trip on it.
  return src
    .replace(/^\s*\/\/.*$/gm, '') // whole-line comments first
    .replace(/\/\*[\s\S]*?\*\//g, ''); // then block comments
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the STATIC prefix of every `/api/...` endpoint string in the
 * (comment-stripped) client source. The capture stops at the first path
 * param (`${…}`), query string (`?`), or string delimiter, which keeps
 * the regex robust against mid-path params and nested template literals
 * (e.g. `getMessages`' `\`/api/messages${qs ? \`?${qs}\` : ''}\``).
 *
 * The dropped suffix-after-param for KA verb routes (`/wm/write` etc.)
 * is covered separately by KA_VERB_ROUTES below.
 */
function clientApiPrefixes(): Set<string> {
  const out = new Set<string>();
  for (const m of clientSrc.matchAll(/\/api\/[A-Za-z0-9/_.-]+/g)) {
    out.add(m[0].replace(/\/+$/, ''));
  }
  return out;
}

/** A literal daemon route is served if a handler compares `path` to it. */
function daemonServesLiteral(p: string): boolean {
  // Primary: an explicit `path === "<p>"` dispatch (covers every route the
  // client calls). Fallback: the exact quoted path token appears anywhere
  // in the COMMENT-STRIPPED route source (tolerates a handler that matches
  // via a helper rather than a bare `path ===`, without letting JSDoc or
  // error strings about retired routes satisfy the check).
  const exact = new RegExp(`path\\s*===\\s*["'\`]${escapeRegex(p)}["'\`]`);
  const quoted = new RegExp(`["'\`]${escapeRegex(p)}["'\`]`);
  return exact.test(daemonSrc) || quoted.test(daemonSrc);
}

/**
 * Extract the PARAMETERIZED Knowledge-Asset template routes the client
 * builds (`/api/knowledge-assets/${name}/...`). The static-prefix scan
 * collapses these to the bare `/api/knowledge-assets` prefix, so a daemon
 * that dropped a post-`:name` route would stay green there (Codex review
 * on PR #1075). This is scoped to the KA family on purpose: that is the
 * only surface with real mid-path params. Non-KA templates like
 * `/api/sub-graph/list${qs}` are LITERAL paths with a query-string append
 * (the hole abuts a path char, not a `/`), so the prefix scan already
 * covers their static path — they are not parameterized routes.
 *
 * Each `/${…}` path-param hole becomes `/*` and any `?…` query suffix is
 * dropped, yielding patterns like `/api/knowledge-assets/*` and
 * `/api/knowledge-assets/*​/wm/quads`.
 */
function clientKaParamRoutes(): Set<string> {
  const out = new Set<string>();
  for (const m of clientSrc.matchAll(/`(?:\$\{this\.api\})?(\/api\/knowledge-assets\/[^`]*?)`/g)) {
    const normalized = m[1]
      .replace(/\?.*$/, '') // drop any query string (`?${params}` / `?${qs}`)
      .replace(/\/\$\{[^}]*\}/g, '/*') // slash-preceded path-param holes → `/*`
      .replace(/\/+$/, '');
    if (normalized.includes('*')) out.add(normalized);
  }
  return out;
}

/** A KA lifecycle verb is served if the segment dispatch handles it. */
function daemonHandlesKaVerb(verb: string): boolean {
  return new RegExp(`verb\\s*===\\s*["'\`]${escapeRegex(verb)}["'\`]`).test(daemonSrc);
}

// ── The Knowledge-Asset lifecycle verbs the client drives ───────────
// These are the `/api/knowledge-assets/:name/<layer>/<verb>` routes whose
// suffix sits AFTER the `:name` path param, so they are not captured by
// the static-prefix scan above. Each entry pins the client-side suffix
// (kept honest by asserting it still appears in client.ts) and the daemon
// segment-dispatch verb it must resolve to. Add a row when the client
// grows a new lifecycle verb.
const KA_VERB_ROUTES: ReadonlyArray<{ suffix: string; verb: string }> = [
  { suffix: '/wm/write', verb: 'write' },
  { suffix: '/wm/finalize', verb: 'finalize' },
  { suffix: '/wm/discard', verb: 'discard' },
  { suffix: '/wm/pull-from', verb: 'pull-from' },
  { suffix: '/wm/quads', verb: 'quads' },
  { suffix: '/wm/import-file', verb: 'import-file' },
  { suffix: '/swm/share', verb: 'share' },
  { suffix: '/vm/publish', verb: 'publish' },
];

describe('MCP client ↔ daemon endpoint contract (static)', () => {
  it('sanity: both sides of the contract are readable', () => {
    // A wrong relative path here would make every assertion below pass
    // vacuously, so fail loudly if either source is empty/missing.
    expect(clientSrc).toMatch(/class DkgClient/);
    expect(daemonSrc).toMatch(/path\s*===\s*["'`]\/api\/query["'`]/);
  });

  it('every literal /api/... endpoint the client calls is served by a daemon route', () => {
    const prefixes = clientApiPrefixes();
    // Guard against the extractor silently capturing nothing.
    expect(prefixes.size).toBeGreaterThan(10);

    const unserved = [...prefixes].filter((p) => !daemonServesLiteral(p));
    expect(
      unserved,
      `MCP client calls /api endpoints the daemon no longer serves: ${unserved.join(', ')}.\n` +
        `Either the daemon route was renamed/removed (update packages/cli/src/daemon/routes/*) ` +
        `or the client is targeting a stale path (update packages/mcp-dkg/src/client.ts).`,
    ).toEqual([]);
  });

  it('every Knowledge-Asset lifecycle verb the client drives is dispatched by the daemon', () => {
    const unhandled = KA_VERB_ROUTES.filter((r) => !daemonHandlesKaVerb(r.verb)).map((r) => r.suffix);
    expect(
      unhandled,
      `Daemon no longer dispatches these KA lifecycle verbs the MCP client POSTs to: ${unhandled.join(', ')}.\n` +
        `The git-shaped write→finalize→share→publish surface drifted — check the segment dispatch ` +
        `in packages/cli/src/daemon/routes/knowledge-assets.ts.`,
    ).toEqual([]);
  });

  it('KA_VERB_ROUTES stays honest — each pinned verb suffix is still used by the client', () => {
    // If the client drops/renames a verb suffix, this list is stale: fix
    // the row rather than letting the daemon-side check pass vacuously.
    const stale = KA_VERB_ROUTES.filter((r) => !clientSrc.includes(r.suffix)).map((r) => r.suffix);
    expect(
      stale,
      `KA_VERB_ROUTES references suffixes the MCP client no longer calls: ${stale.join(', ')}. ` +
        `Update KA_VERB_ROUTES to match packages/mcp-dkg/src/client.ts.`,
    ).toEqual([]);
  });

  it('every parameterized KA client route is accounted for (no route hides behind a /${…} hole)', () => {
    // The static-prefix scan collapses `/api/knowledge-assets/${name}/wm/quads`
    // to `/api/knowledge-assets`, so a daemon that drops a post-param route
    // would stay green there (Codex review on PR #1075). Close the gap from
    // the CLIENT side: every KA param route must either map onto a
    // KA_VERB_ROUTES row (whose daemon dispatch is asserted above) or be the
    // bare KA descriptor read (whose GET dispatch is asserted below). A new
    // KA param route fails here until it gets a contract row.
    const patterns = clientKaParamRoutes();
    expect(patterns.size, 'KA-param-route extractor captured nothing — extractor regression').toBeGreaterThan(5);

    const verbSuffixes = new Set(KA_VERB_ROUTES.map((r) => r.suffix));
    const unaccounted = [...patterns].filter((p) => {
      if (p === '/api/knowledge-assets/*') return false; // descriptor read — see GET test
      const m = p.match(/^\/api\/knowledge-assets\/\*(\/.+)$/);
      return !(m && verbSuffixes.has(m[1]));
    });
    expect(
      unaccounted,
      `Parameterized KA client routes with no daemon-side contract check: ${unaccounted.join(', ')}.\n` +
        `Add a KA_VERB_ROUTES row (or a dedicated dispatch assertion) for each.`,
    ).toEqual([]);
  });

  it('the bare KA descriptor read (GET /api/knowledge-assets/:name) is still dispatched', () => {
    // The client reads lifecycle descriptors via `GET ${PREFIX}/${name}?…`.
    // That path has no verb suffix, so KA_VERB_ROUTES can't cover it — pin
    // the GET dispatch in the KA route file directly.
    expect(clientKaParamRoutes().has('/api/knowledge-assets/*'), 'client no longer reads the bare descriptor — update this test').toBe(true);
    expect(kaRouteSrc).toMatch(/method\s*===\s*["'`]GET["'`]/);
  });
});
