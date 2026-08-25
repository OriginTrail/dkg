import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SKILL_TOKENS,
  buildSkillMd,
  loadSkillTemplate,
  missingSkillTokens,
  renderStandaloneDkgNodeSkill,
  unknownSkillTokens,
} from '../src/daemon/skill-template.js';
import { loadBundledDkgNodeSkill } from '../src/hermes-setup.js';

// GH#1125 — the served skill doc shipped literal "(dynamic)" placeholders.
//
// `buildSkillMd` used to rebuild a copy of the template's Markdown and swap the
// whole block with one literal `String.replace`, which fails SILENTLY on a
// mismatch. The copy and SKILL.md had drifted by a single reordered sentence,
// so the block was never substituted and every agent bootstrapping from
// /.well-known/skill.md read placeholders.
const OPTS = {
  version: '10.0.14',
  baseUrl: 'http://127.0.0.1:9200',
  peerId: '12D3KooWTestPeerIdForSubstitutionAssertions',
  nodeRole: 'edge',
  extractionPipelines: ['markitdown'],
};

describe('buildSkillMd — dynamic Node Info substitution (GH#1125)', () => {
  it('leaves no unsubstituted token or legacy placeholder', () => {
    const md = buildSkillMd(OPTS);
    expect(md).not.toContain('(dynamic)');
    expect(md).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
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
    expect(md).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    expect(md).toContain('none (install markitdown to enable document conversion)');
  });

  it('is idempotent', () => {
    expect(buildSkillMd(OPTS)).toBe(buildSkillMd(OPTS));
  });
});

// PR #2331 review, 🔴 — `String.replace(needle, replacementString)` interprets
// `$&`, `$'`, "$`" and `$n` in the REPLACEMENT. `baseUrl` is derived from the
// `X-Forwarded-Host` / `Host` headers (routes/status.ts:641) and
// /.well-known/skill.md is public and unauthenticated, so those sequences were
// attacker-controlled. Measured on the pre-fix build: `$&` put `(dynamic)`
// back into the served doc, a single `$'` doubled the response (94 KB -> 187 KB)
// and five of them reached 561 KB — unbounded amplification from one request.
describe('buildSkillMd — replacement tokens in node metadata are literal (GH#1125 review)', () => {
  const evil = ["$&", "$'", '$`', '$1', '$$'];

  for (const seq of evil) {
    it(`emits ${JSON.stringify(seq)} in baseUrl verbatim, exactly once`, () => {
      const baseUrl = `http://host/${seq}`;
      const md = buildSkillMd({ ...OPTS, baseUrl });

      expect(md).toContain(`- **Base URL:** ${baseUrl}`);
      expect(md.split(`- **Base URL:** ${baseUrl}`)).toHaveLength(2);
      expect(md).not.toContain('(dynamic)');
      expect(md).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    });
  }

  it('does not amplify the response for any replacement sequence', () => {
    const normal = buildSkillMd(OPTS).length;
    for (const seq of evil) {
      const md = buildSkillMd({ ...OPTS, baseUrl: `http://host/${seq.repeat(5)}` });
      // Growth must be bounded by the length of the value itself, not by the
      // template suffix. Allow a small slack for the longer URL.
      expect(md.length).toBeLessThan(normal + 200);
    }
  });

  it('treats replacement sequences in every other field as literal too', () => {
    const md = buildSkillMd({
      ...OPTS,
      version: "1.0.0-$'",
      peerId: '12D3Koo$&',
      nodeRole: "edge$`",
      extractionPipelines: ["markitdown$'"],
    });
    expect(md).toContain("- **Node version:** 1.0.0-$'");
    expect(md).toContain('- **Peer ID:** 12D3Koo$&');
    expect(md).toContain('- **Node role:** edge$`');
    expect(md).toContain("- **Available extraction pipelines:** markitdown$'");
    expect(md).not.toContain('(dynamic)');
  });
});

// PR #2331 review, 🔴 — the previous fix only shrank the literal needle; a
// harmless prose or label edit could still silently disable every
// substitution. Named tokens decouple substitution from the surrounding
// Markdown, and the template is validated once at load rather than warning on
// every render.
describe('SKILL.md template token contract (GH#1125 review)', () => {
  it('the shipped template carries every required token', () => {
    expect(missingSkillTokens(loadSkillTemplate())).toEqual([]);
  });

  it('missingSkillTokens names what a drifted template dropped', () => {
    const drifted = loadSkillTemplate().replace('{{nodeRole}}', '(dynamic)');
    expect(missingSkillTokens(drifted)).toEqual(['nodeRole']);
  });

  it('substitution survives prose and label edits around the tokens', () => {
    // The exact failure that caused #1125: reword the surrounding Markdown.
    const reworded = loadSkillTemplate()
      .replace('- **Node role:**', '- **Node type:**')
      .replace('If the Node UI injects', 'If the Node UI supplies');
    for (const token of REQUIRED_SKILL_TOKENS) {
      expect(reworded).toContain(`{{${token}}}`);
    }
  });
});

// PR #2331 review — SKILL.md has TWO delivery modes and only one of them has a
// node to describe. `dkg mcp setup` / `dkg hermes setup` copy the skill into a
// client's skill directory (mcp-setup.ts deliverSkillToClient), and those paths
// used to write the bundled file verbatim. Once the template carried
// `{{token}}` syntax that meant shipping internal placeholders to end users —
// a worse artifact than the `(dynamic)` prose it replaced.
describe('standalone skill delivery renders too (GH#1125 review)', () => {
  it('never delivers raw template syntax', () => {
    const delivered = renderStandaloneDkgNodeSkill();
    expect(delivered).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    expect(delivered).not.toContain('(dynamic)');
  });

  it('delivers readable guidance in place of live values', () => {
    const delivered = renderStandaloneDkgNodeSkill();
    expect(delivered).toContain('- **Node version:** _(run `dkg --version` on your node)_');
    expect(delivered).toContain('- **Node role:** _(`core` or `edge` — run `dkg status`)_');
  });

  it('the setup delivery path goes through the renderer, not the raw file', () => {
    // Guards the actual regression: hermes-setup/mcp-setup previously
    // readFileSync'd the bundled SKILL.md straight into the client directory.
    const shipped = loadBundledDkgNodeSkill();
    expect(shipped).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
    expect(shipped).toBe(renderStandaloneDkgNodeSkill());
  });

  it('served and delivered modes differ only in the substituted values', () => {
    const served = buildSkillMd(OPTS);
    const delivered = renderStandaloneDkgNodeSkill();
    expect(served).not.toBe(delivered);
    // Same document otherwise — compare a section far from the token block.
    expect(served.includes('## 5. Memory Model')).toBe(delivered.includes('## 5. Memory Model'));
  });
});

// PR #2331 review — the required-token array, the substitution map and the
// template were three independent sources of truth, so adding `{{networkId}}`
// to SKILL.md would render it verbatim while the validator still reported a
// clean bill of health. Required names are now DERIVED from the value map, and
// unknown tokens are detectable.
describe('token contract has one source of truth (GH#1125 review)', () => {
  it('the shipped template has no missing and no unknown tokens', () => {
    expect(missingSkillTokens()).toEqual([]);
    expect(unknownSkillTokens()).toEqual([]);
  });

  it('detects a token the template uses but nothing supplies', () => {
    const drifted = loadSkillTemplate().replace('{{peerId}}', '{{networkId}}');
    expect(unknownSkillTokens(drifted)).toEqual(['networkId']);
    expect(missingSkillTokens(drifted)).toEqual(['peerId']);
  });

  it('REQUIRED_SKILL_TOKENS is derived, not a parallel list', () => {
    expect([...REQUIRED_SKILL_TOKENS].sort()).toEqual(
      ['baseUrl', 'extractionPipelines', 'nodeRole', 'nodeVersion', 'peerId'],
    );
  });
});
