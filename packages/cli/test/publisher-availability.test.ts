import { describe, expect, it } from 'vitest';
import { resolveAsyncPublisherAvailability, type PublisherRuntime } from '../src/publisher-runner.js';

const runtime = (wallets: unknown[]): PublisherRuntime => ({
  wallets,
  walletIds: wallets.map((_, index) => String(index)),
} as unknown as PublisherRuntime);

describe('resolveAsyncPublisherAvailability', () => {
  it('classifies permanent configuration states as operator-actionable', () => {
    expect(resolveAsyncPublisherAvailability({ config: {}, runtime: null })).toMatchObject({
      available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true,
    });
    expect(resolveAsyncPublisherAvailability({
      config: { publisher: { enabled: true } } as any,
      runtime: runtime([]),
    })).toMatchObject({
      available: false, reason: 'no_publisher_wallets', retryable: false, operatorActionRequired: true,
    });
    expect(resolveAsyncPublisherAvailability({
      config: { publisher: { enabled: true } } as any,
      runtime: null,
      lifecycleReason: 'publisher_startup_failed',
    })).toMatchObject({
      available: false, reason: 'publisher_startup_failed', retryable: false, operatorActionRequired: true,
    });
  });

  it('marks only an in-progress startup as retryable and a funded runtime as ready', () => {
    expect(resolveAsyncPublisherAvailability({
      config: { publisher: { enabled: true } } as any,
      runtime: null,
      lifecycleReason: 'publisher_starting',
    })).toMatchObject({
      available: false, reason: 'publisher_starting', retryable: true, operatorActionRequired: false,
    });
    expect(resolveAsyncPublisherAvailability({ config: {}, runtime: runtime([{}]) })).toEqual({ available: true });
  });
});
