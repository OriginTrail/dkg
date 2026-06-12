import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Doc-vs-route parity guard (rc.17 agent-tooling, PR1 / CONTRACT §1).
 *
 * SKILL.md is the single source fanned out to every runtime via
 * `/.well-known/skill.md`. If it advertises a `/api/knowledge-assets/...`
 * endpoint that has no live handler in the daemon route file, agents will be
 * steered to a 404. This test pins the invariant: every knowledge-asset path
 * documented in SKILL.md resolves to a live verb dispatch (or collection-level
 * handler) in `packages/cli/src/daemon/routes/knowledge-assets.ts`.
 *
 * The handler set is derived from the route source itself (not hardcoded) so the
 * guard can never drift away from the real dispatch table.
 */
describe('SKILL.md ↔ knowledge-assets route parity', () => {
  let skillContent: string;
  let routeSource: string;

  beforeAll(() => {
    skillContent = readFileSync(new URL('../skills/dkg-node/SKILL.md', import.meta.url), 'utf-8');
    routeSource = readFileSync(
      new URL('../src/daemon/routes/knowledge-assets.ts', import.meta.url),
      'utf-8',
    );
  });

  // Per-KA verbs the route file dispatches via `verb === "<verb>"`.
  const liveVerbs = (): Set<string> => {
    const set = new Set<string>();
    for (const m of routeSource.matchAll(/verb\s*===\s*"([a-z-]+)"/g)) set.add(m[1]);
    return set;
  };

  // Collection-level paths the route file matches as `${PREFIX}/<literal>`.
  const liveCollectionPaths = (): Set<string> => {
    const set = new Set<string>();
    for (const m of routeSource.matchAll(/\$\{PREFIX\}\/([a-z-]+\/[a-z-]+)`/g)) set.add(m[1]);
    return set;
  };

  it('the route source actually exposes the rc.17 lifecycle verbs (sanity floor)', () => {
    const verbs = liveVerbs();
    // CONTRACT §1 Stages 2–5 + side verbs — if any of these regress, the doc
    // parity assertion below is meaningless, so fail loudly here first.
    for (const v of ['write', 'finalize', 'discard', 'pull-from', 'quads', 'import-file', 'share', 'publish']) {
      expect(verbs, `route file must dispatch verb "${v}"`).toContain(v);
    }
    const coll = liveCollectionPaths();
    for (const p of ['import-artifact/resolve', 'import-artifact/read-markdown', 'semantic-enrichment/write']) {
      expect(coll, `route file must dispatch collection path "${p}"`).toContain(p);
    }
  });

  it('every /api/knowledge-assets/{name}/<layer>/<verb> path in SKILL.md is a live handler', () => {
    const verbs = liveVerbs();
    // Extract the {name}/<layer>/<verb> suffixes SKILL.md advertises. {name} is
    // a doc placeholder; both `{name}` and `:name` spellings appear, so accept
    // either. The trailing verb may carry a `?query` or be followed by markup.
    const documented = new Set<string>();
    const re = /\/api\/knowledge-assets\/(?:\{name\}|:name)\/(wm|swm|vm)\/([a-z-]+)/g;
    for (const m of skillContent.matchAll(re)) documented.add(`${m[1]}/${m[2]}`);

    expect(documented.size, 'SKILL.md should document at least the core lifecycle paths').toBeGreaterThanOrEqual(6);

    for (const pair of documented) {
      const verb = pair.split('/')[1];
      expect(verbs, `SKILL.md documents "${pair}" but the route file has no verb === "${verb}" handler`).toContain(verb);
    }
  });

  it('every collection-level /api/knowledge-assets/<a>/<b> path in SKILL.md is a live handler', () => {
    const coll = liveCollectionPaths();
    const documented = new Set<string>();
    // Collection paths have no {name} segment: /api/knowledge-assets/<a>/<b>.
    // Exclude the per-KA {name}/<layer>/<verb> form and the bare create route.
    const re = /\/api\/knowledge-assets\/(import-artifact|semantic-enrichment)\/([a-z-]+)/g;
    for (const m of skillContent.matchAll(re)) documented.add(`${m[1]}/${m[2]}`);

    for (const p of documented) {
      expect(coll, `SKILL.md documents collection path "${p}" but the route file has no handler`).toContain(p);
    }
  });
});
