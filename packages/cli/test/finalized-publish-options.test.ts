import { describe, expect, it } from 'vitest';
import {
  finalizedPublishOptionsPayload,
  formatFinalizedPublishOptionError,
  parseCliFinalizedPublishOptions,
  parseHttpFinalizedPublishOptions,
} from '../src/finalized-publish-options.js';

describe('finalized publication pricing options', () => {
  it('normalizes full-content pricing across CLI, HTTP, and SDK boundaries', () => {
    expect(parseCliFinalizedPublishOptions({ pricingPolicy: 'full-content' })).toEqual({
      ok: true,
      options: { pricingPolicy: 'full-content' },
    });
    expect(parseHttpFinalizedPublishOptions({ pricingPolicy: 'full-content' })).toEqual({
      ok: true,
      options: { pricingPolicy: 'full-content' },
    });
    expect(finalizedPublishOptionsPayload({ pricingPolicy: 'full-content' })).toEqual({
      pricingPolicy: 'full-content',
    });
  });

  it('rejects unknown pricing policies at the request boundary', () => {
    const parsed = parseHttpFinalizedPublishOptions({ pricingPolicy: 'caller-reported' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(formatFinalizedPublishOptionError(parsed.error)).toBe(
      '"pricingPolicy" must be "full-content" when supplied',
    );
  });
});
