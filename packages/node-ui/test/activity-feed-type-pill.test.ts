import { describe, expect, it } from 'vitest';
import { humanizeStatus, humanizeTypeName } from '../src/ui/lib/formatLabels.js';

describe('shared label formatters', () => {
  it('spaces out raw type names in sentence case', () => {
    expect(humanizeTypeName('PullRequest')).toBe('Pull request');
    expect(humanizeTypeName('CreativeWork')).toBe('Creative work');
    expect(humanizeTypeName('Decision')).toBe('Decision');
    expect(humanizeTypeName('code_review')).toBe('Code review');
  });

  it('turns machine statuses into sentence case', () => {
    expect(humanizeStatus('in_progress')).toBe('In progress');
    expect(humanizeStatus('peer-relayed')).toBe('Peer relayed');
    expect(humanizeStatus('promote')).toBe('Promote');
    expect(humanizeStatus('  ')).toBe('');
  });

  it('lives outside feature components, so the shell does not import ActivityFeed', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['src/ui/components/Shell/PanelRight/NetworkTab.tsx', 'src/ui/components/Shell/PanelRight/ConnectedAgentsTab.tsx', 'src/ui/pages/Operations.tsx']) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).not.toMatch(/from '[^']*ActivityFeed\.js'/);
    }
  });
});
