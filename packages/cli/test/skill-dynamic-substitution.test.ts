import { describe, expect, it } from 'vitest';
import { buildSkillMd, loadSkillTemplate } from '../src/daemon/manifest.js';

// GH#1125 — the served skill doc shipped literal "(dynamic)" placeholders.
//
// `buildSkillMd` substitutes with `String.replace(literalNeedle, …)`, which
// fails SILENTLY when the needle does not match. The needle used to include a
// trailing prose paragraph that had drifted out of sync with SKILL.md (the
// `dkg_list_context_graphs` / `GET /api/context-graph/list` mentions are
// order-swapped), so the whole Node Info block was never substituted and every
// agent bootstrapping from /.well-known/skill.md read placeholders.
const OPTS = {
  version: '10.0.14',
  baseUrl: 'http://127.0.0.1:9200',
  peerId: '12D3KooWTestPeerIdForSubstitutionAssertions',
  nodeRole: 'edge',
  extractionPipelines: ['markitdown'],
};

describe('buildSkillMd — dynamic Node Info substitution (GH#1125)', () => {
  it('serves no literal "(dynamic)" placeholder anywhere', () => {
    expect(buildSkillMd(OPTS)).not.toContain('(dynamic)');
  });

  it('substitutes the real node values', () => {
    const md = buildSkillMd(OPTS);
    expect(md).toContain(`- **Node version:** ${OPTS.version}`);
    expect(md).toContain(`- **Base URL:** ${OPTS.baseUrl}`);
    expect(md).toContain(`- **Peer ID:** ${OPTS.peerId}`);
    expect(md).toContain(`- **Node role:** ${OPTS.nodeRole}`);
    expect(md).toContain('- **Available extraction pipelines:** markitdown');
  });

  it('reports no pipelines with actionable guidance rather than an empty value', () => {
    const md = buildSkillMd({ ...OPTS, extractionPipelines: [] });
    expect(md).not.toContain('(dynamic)');
    expect(md).toContain('none (install markitdown to enable document conversion)');
  });

  it('substitution does not depend on the prose that follows the bullets', () => {
    // The regression guard: the template paragraph after the pipelines line is
    // free to be reworded without silently disabling substitution.
    const template = loadSkillTemplate();
    expect(template).toContain('- **Available extraction pipelines:** (dynamic)');
    const md = buildSkillMd(OPTS);
    expect(md).toContain('If the Node UI injects a target context graph');
  });

  it('is idempotent — building twice yields identical output', () => {
    expect(buildSkillMd(OPTS)).toBe(buildSkillMd(OPTS));
  });
});
