import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAsyncPublisherAvailability,
  startPublisherRuntimeWithOutcome,
  type PublisherRuntime,
  type PublisherState,
} from '../src/publisher-runner.js';
import { publisherCompatibilityAliases } from '../src/daemon/routes/context.js';

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

  it('keeps disabled startup explicit instead of overloading a null runtime', async () => {
    const outcome = await startPublisherRuntimeWithOutcome({
      config: { publisher: { enabled: false } },
    } as Parameters<typeof startPublisherRuntimeWithOutcome>[0]);

    expect(outcome).toEqual({
      status: 'disabled',
      runtime: null,
      availability: {
        available: false,
        reason: 'publisher_disabled',
        retryable: false,
        operatorActionRequired: true,
      },
    });
  });

  it('derives legacy route-plugin aliases from the canonical state', async () => {
    const state = await startPublisherRuntimeWithOutcome({
      config: { publisher: { enabled: false } },
    } as Parameters<typeof startPublisherRuntimeWithOutcome>[0]);

    expect(publisherCompatibilityAliases(state)).toEqual({
      publisherRuntime: state.runtime,
      publisherAvailability: state.availability,
    });

    const readyState: PublisherState = {
      status: 'started',
      runtime: runtime([{}]),
      availability: { available: true },
    };
    expect(publisherCompatibilityAliases(readyState)).toEqual({
      publisherRuntime: readyState.runtime,
      publisherAvailability: readyState.availability,
    });
  });

  it('converts a real publisher bootstrap exception into the failed state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-startup-failure-'));
    try {
      // Exercise the production bootstrap path with a non-wallet-absence error:
      // malformed persisted configuration throws before a runtime can start.
      await writeFile(join(dataDir, 'publisher-wallets.json'), '{ not-json');
      const outcome = await startPublisherRuntimeWithOutcome({
        dataDir,
        config: { publisher: { enabled: true } },
      } as Parameters<typeof startPublisherRuntimeWithOutcome>[0]);

      expect(outcome).toMatchObject({
        status: 'failed',
        runtime: null,
        availability: {
          available: false,
          reason: 'publisher_startup_failed',
          retryable: false,
          operatorActionRequired: true,
        },
      });
      expect(outcome.status === 'failed' ? outcome.error : undefined).toBeInstanceOf(SyntaxError);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
