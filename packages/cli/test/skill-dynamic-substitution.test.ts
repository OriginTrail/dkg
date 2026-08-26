import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SKILL_TOKENS,
  buildSkillMd,
  loadSkillTemplate,
  missingSkillTokens,
  renderSkillTemplate,
  renderStandaloneDkgNodeSkill,
  unknownSkillTokens,
} from '../src/skill-template.js';
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

function expectNoUnresolvedSkillTemplateTokens(content: string): void {
  for (const token of REQUIRED_SKILL_TOKENS) {
    expect(content).not.toContain(`{{${token}}}`);
  }
}

describe('buildSkillMd — dynamic Node Info substitution (GH#1125)', () => {
  it('leaves no unsubstituted token or legacy placeholder', () => {
    const md = buildSkillMd(OPTS);
    expect(md).not.toContain('(dynamic)');
    expectNoUnresolvedSkillTemplateTokens(md);
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
    expectNoUnresolvedSkillTemplateTokens(md);
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
      expectNoUnresolvedSkillTemplateTokens(md);
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
    // PR #2331 review — an earlier version asserted only that the reworded
    // template still CONTAINED the tokens, which is true regardless of how
    // rendering works, so a return to exact-block replacement would have passed
    // it. RENDER the drifted template and check the output.
    const reworded = loadSkillTemplate()
      .replace('- **Node role:**', '- **Node type:**')
      .replace('If the Node UI injects', 'If the Node UI supplies');

    const rendered = renderSkillTemplate(
      {
        nodeVersion: '10.0.14',
        baseUrl: 'http://127.0.0.1:9200',
        peerId: '12D3KooWRendered',
        nodeRole: 'edge',
        extractionPipelines: 'markitdown',
      },
      reworded,
    );

    expectNoUnresolvedSkillTemplateTokens(rendered);
    expect(rendered).toContain('- **Node type:** edge');
    expect(rendered).toContain('- **Node version:** 10.0.14');
    expect(rendered).toContain('If the Node UI supplies');
  });
});

// PR #2331 review — SKILL.md has TWO delivery modes and only one of them has a
// node to describe. `dkg mcp setup` / `dkg hermes setup` copy the skill into a
// client's skill directory (mcp-setup.ts deliverSkillToClient), and those paths
// used to write the bundled file verbatim. Once the template carried
// `{{token}}` syntax that meant shipping internal placeholders to end users —
// a worse artifact than the `(dynamic)` prose it replaced.
describe('standalone skill delivery renders too (GH#1125 review)', () => {
  it('never delivers unresolved node template syntax', () => {
    const delivered = renderStandaloneDkgNodeSkill();
    expectNoUnresolvedSkillTemplateTokens(delivered);
    expect(delivered).not.toContain('(dynamic)');
  });

  it('delivers readable guidance in place of live values', () => {
    const delivered = renderStandaloneDkgNodeSkill();
    expect(delivered).toContain('- **Node version:** _(run `dkg --version` on your node)_');
    expect(delivered).toContain('- **Node role:** _(`core` or `edge` — run `dkg status`)_');
  });

  it('the hermes setup path goes through the renderer, not the raw file', () => {
    // NOTE: this covers hermes-setup ONLY. mcp-setup had its own private copy
    // of this loader, so reverting just that file passed every assertion here
    // (PR #2331 review). The duplicate is deleted and mcp-setup calls the
    // shared renderer directly; `mcp-setup.test.ts` asserts the delivered file.
    const shipped = loadBundledDkgNodeSkill();
    expectNoUnresolvedSkillTemplateTokens(shipped);
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

  it('preserves explicitly escaped placeholders from another template language', () => {
    const template = '{{nodeVersion}} / {{literal:configuration_id}}';
    const rendered = renderSkillTemplate(
      {
        nodeVersion: '10.0.14',
        baseUrl: 'unused',
        peerId: 'unused',
        nodeRole: 'unused',
        extractionPipelines: 'unused',
      },
      template,
    );

    expect(rendered).toBe('10.0.14 / {{configuration_id}}');
    expect(unknownSkillTokens(template)).toEqual([]);
  });

  it('REQUIRED_SKILL_TOKENS is derived, not a parallel list', () => {
    expect([...REQUIRED_SKILL_TOKENS].sort()).toEqual(
      ['baseUrl', 'extractionPipelines', 'nodeRole', 'nodeVersion', 'peerId'],
    );
  });
});

// PR #2331 review — substituting one token at a time rescans the growing
// OUTPUT, so a value could itself invoke the template language. `baseUrl` comes
// from the `X-Forwarded-Host` / `Host` headers on a public unauthenticated
// endpoint, so this was request-controlled: `http://{{peerId}}` rendered the
// real peer ID into the advertised API URL. One pass over the ORIGINAL template
// closes it.
describe('buildSkillMd — values are never re-scanned as template syntax (GH#1125 review)', () => {
  const base = {
    version: '10.0.14',
    peerId: '12D3KooWSensitivePeerIdentifier',
    nodeRole: 'edge',
    extractionPipelines: ['markitdown'],
  };

  it('does not resolve a token injected through baseUrl', () => {
    const md = buildSkillMd({ ...base, baseUrl: 'http://{{peerId}}' });
    expect(md).toContain('- **Base URL:** http://{{peerId}}');
    expect(md).not.toContain(`http://${base.peerId}`);
  });

  it('does not depend on token processing order', () => {
    // `nodeVersion` sorts before `baseUrl`; under the old loop this left raw
    // syntax while `{{peerId}}` resolved. Both must now be verbatim.
    for (const token of ['nodeVersion', 'baseUrl', 'peerId', 'nodeRole', 'extractionPipelines']) {
      const md = buildSkillMd({ ...base, baseUrl: `http://{{${token}}}` });
      expect(md).toContain(`- **Base URL:** http://{{${token}}}`);
    }
  });

  it('treats injected tokens in every other field as literal too', () => {
    const md = buildSkillMd({
      ...base,
      version: '{{peerId}}',
      nodeRole: '{{baseUrl}}',
      baseUrl: 'http://localhost:9200',
      extractionPipelines: ['{{nodeVersion}}'],
    });
    expect(md).toContain('- **Node version:** {{peerId}}');
    expect(md).toContain('- **Node role:** {{baseUrl}}');
    expect(md).toContain('- **Available extraction pipelines:** {{nodeVersion}}');
  });

  it('still emits $-sequences literally and without amplification', () => {
    const normal = buildSkillMd({ ...base, baseUrl: 'http://localhost:9200' }).length;
    const md = buildSkillMd({ ...base, baseUrl: "http://h/" + "$'".repeat(5) });
    expect(md).toContain("- **Base URL:** http://h/$'$'$'$'$'");
    expect(md.length).toBeLessThan(normal + 200);
  });
});

// PR #2331 review — the boundary must enforce its own contract, not leave it to
// a test. Adding `{{networkId}}` to SKILL.md previously rendered it verbatim
// into the served document.
describe('renderSkillTemplate rejects an unsupplied token (GH#1125 review)', () => {
  it('throws, naming the token, rather than serving it raw', () => {
    const drifted = loadSkillTemplate().replace('{{peerId}}', '{{networkId}}');
    expect(() => renderSkillTemplate(
      {
        nodeVersion: '1', baseUrl: '2', peerId: '3', nodeRole: '4', extractionPipelines: '5',
      },
      drifted,
    )).toThrow(/networkId/);
  });

  it('the shipped template renders without throwing', () => {
    expect(() => renderStandaloneDkgNodeSkill()).not.toThrow();
  });
});

// PR #2331 review — the standalone copy told readers to run `dkg status` for
// extraction pipelines, which does not report them. The served skill doc does.
describe('standalone guidance points somewhere that answers (GH#1125 review)', () => {
  it('does not send readers to dkg status for pipelines', () => {
    const line = renderStandaloneDkgNodeSkill()
      .split('\n')
      .find((l) => l.startsWith('- **Available extraction pipelines:**'))!;
    expect(line).not.toContain('dkg status');
    expect(line).toContain('/.well-known/skill.md');
  });
});
