import { describe, expect, it } from 'vitest';
import { humanizeTypeName } from '../src/ui/components/ActivityFeed.js';

describe('activity feed type pill label', () => {
  it('spaces out raw type names', () => {
    expect(humanizeTypeName('PullRequest')).toBe('Pull request');
    expect(humanizeTypeName('CreativeWork')).toBe('Creative work');
    expect(humanizeTypeName('Decision')).toBe('Decision');
    expect(humanizeTypeName('code_review')).toBe('Code review');
  });
});
