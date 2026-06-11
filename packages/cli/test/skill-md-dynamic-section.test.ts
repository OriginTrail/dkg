/**
 * Liveness/regression test for GH #1125 —
 * "Served /.well-known/skill.md §1 Node Info shows literal '(dynamic)'
 *  placeholders — buildSkillMd() template replace silently no-ops".
 *
 * https://github.com/OriginTrail/dkg/issues/1125
 *
 * Root cause: `buildSkillMd()` substitutes the dynamic Node-Info block with an
 * exact-string `template.replace(staticPlaceholder, dynamicSection)`. The
 * placeholder constant in `manifest.ts` and the actual line in the served
 * template (`packages/cli/skills/dkg-node/SKILL.md`) diverged (the
 * `dkg_list_context_graphs` / `GET /api/context-graph/list` order was swapped),
 * so the exact match fails, `replace()` no-ops, and the raw template — with
 * literal `(dynamic)` placeholders — is served to agents.
 *
 * The `it.fails` wrapper documents that this assertion of CORRECT behaviour
 * currently FAILS (the bug is live). When the substitution is fixed, this test
 * starts passing → `it.fails` turns RED → remove `.fails`, make it a plain
 * `it(...)`, and close #1125.
 */
import { describe, expect, it } from 'vitest';
import { buildSkillMd } from '../src/daemon/manifest.js';

const OPTS = {
  version: '10.0.0-test',
  baseUrl: 'http://127.0.0.1:9200',
  peerId: '12D3KooWTestPeerIdForSkillMdDynamicSectionRegression',
  nodeRole: 'core',
  extractionPipelines: ['text/markdown', 'application/pdf'],
};

describe('GH #1125 — served skill.md dynamic Node-Info substitution', () => {
  it.fails(
    'substitutes the dynamic section (no literal "(dynamic)" left in output)',
    () => {
      const out = buildSkillMd(OPTS);
      expect(out).not.toContain('(dynamic)');
    },
  );

  it.fails('renders the real node version into the served doc', () => {
    const out = buildSkillMd(OPTS);
    expect(out).toContain('**Node version:** 10.0.0-test');
  });

  it.fails('renders the available extraction pipelines into the served doc', () => {
    const out = buildSkillMd(OPTS);
    expect(out).toContain('application/pdf');
  });
});
