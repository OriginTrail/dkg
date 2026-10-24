/**
 * Pins the pure classification contract of `sanitizedProviderFailure`: which
 * event fields it reads (assistantMessageEvent.reason / message.stopReason,
 * NOT the also-declared error.stopReason), the precedence of the credential
 * regex over the abort marker, and the input cap that keeps the regex off
 * provider-sized diagnostics.
 */

import { describe, expect, it } from 'vitest';
import { sanitizedProviderFailure } from '../extension/src/extension.js';

const errorEvent = (errorMessage: string) => ({
  assistantMessageEvent: { type: 'error', error: { errorMessage } },
});

describe('sanitizedProviderFailure', () => {
  it.each([
    ['Unauthorized', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['request was unauthorised upstream', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['provider authentication failed for account', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['{"error":{"code":"invalid_api_key"}}', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['invalid api key supplied', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['incorrect api key provided', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['http 401 from provider', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['status: 401', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['status code = 401', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['HTTP=401', 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'],
    ['connection reset by peer', 'PRIME_AGENT_PROVIDER_ERROR'],
    ['status 4011 is not an auth failure', 'PRIME_AGENT_PROVIDER_ERROR'],
    ['', 'PRIME_AGENT_PROVIDER_ERROR'],
  ])('classifies %j as %s', (errorMessage, code) => {
    expect(sanitizedProviderFailure(errorEvent(errorMessage)).code).toBe(code);
  });

  it('classifies an abort via assistantMessageEvent.reason', () => {
    expect(
      sanitizedProviderFailure({ assistantMessageEvent: { type: 'error', reason: 'aborted' } }).code,
    ).toBe('PRIME_AGENT_TURN_ABORTED');
  });

  it('classifies an abort via message.stopReason', () => {
    expect(
      sanitizedProviderFailure({
        assistantMessageEvent: { type: 'error' },
        message: { role: 'assistant', stopReason: 'aborted' },
      }).code,
    ).toBe('PRIME_AGENT_TURN_ABORTED');
  });

  it('reports an event with no diagnostic at all as a generic provider error', () => {
    expect(sanitizedProviderFailure({ assistantMessageEvent: { type: 'error' } }).code).toBe(
      'PRIME_AGENT_PROVIDER_ERROR',
    );
  });

  it('prefers the credential classification when an aborted turn also carries auth text', () => {
    expect(
      sanitizedProviderFailure({
        assistantMessageEvent: {
          type: 'error',
          reason: 'aborted',
          error: { errorMessage: 'Unauthorized' },
        },
      }).code,
    ).toBe('PRIME_AGENT_PROVIDER_UNAUTHORIZED');
  });

  it('joins both diagnostic fields for classification', () => {
    expect(
      sanitizedProviderFailure({
        assistantMessageEvent: { type: 'error', error: { errorMessage: 'provider exploded' } },
        message: { role: 'assistant', errorMessage: 'authentication failed' },
      }).code,
    ).toBe('PRIME_AGENT_PROVIDER_UNAUTHORIZED');
  });

  it('only classifies the capped head of an oversized diagnostic', () => {
    // A marker past the cap must not flip the classification: the cap exists
    // so hostile provider-sized payloads never reach the regex.
    expect(
      sanitizedProviderFailure(errorEvent(' '.repeat(5000) + 'Unauthorized')).code,
    ).toBe('PRIME_AGENT_PROVIDER_ERROR');
  });

  it('still scans the second diagnostic field when the first is oversized', () => {
    // The cap is per field, not on the joined text: an oversized assistant
    // diagnostic must not starve message.errorMessage out of classification.
    expect(
      sanitizedProviderFailure({
        assistantMessageEvent: { type: 'error', error: { errorMessage: 'x'.repeat(5000) } },
        message: { role: 'assistant', errorMessage: 'authentication failed' },
      }).code,
    ).toBe('PRIME_AGENT_PROVIDER_UNAUTHORIZED');
  });

  it('does not let truncation fabricate an auth marker at the cap boundary', () => {
    // Full text says "status: 4013" (not an auth status); the 4096-char cut
    // would land exactly after "...status: 401". The trailing partial token is
    // stripped, so this must stay a generic provider error.
    const diagnostic = 'x'.repeat(4084) + ' status: 4013 from provider';
    expect(sanitizedProviderFailure(errorEvent(diagnostic)).code).toBe(
      'PRIME_AGENT_PROVIDER_ERROR',
    );
  });

  it('never leaks the raw diagnostic into the sanitized message', () => {
    const failure = sanitizedProviderFailure(errorEvent('Unauthorized key sk-must-not-leak'));
    expect(failure.message).not.toContain('sk-');
    expect(failure.message).not.toContain('must-not-leak');
  });
});
