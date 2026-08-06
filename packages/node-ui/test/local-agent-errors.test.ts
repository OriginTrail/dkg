import { describe, expect, it } from 'vitest';

import { LocalAgentApiError, type LocalAgentIntegration } from '../src/ui/api.js';
import { formatLocalAgentErrorMessage } from '../src/ui/components/Shell/PanelRight/local-agent-errors.js';

const primeAgent = { name: 'Prime Agent' } as LocalAgentIntegration;

describe('Prime Agent terminal error messages', () => {
  it('renders provider authentication failures as actionable terminal errors', () => {
    const error = new LocalAgentApiError('sanitized bridge failure', {
      code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
      source: 'prime-agent-channel',
    });

    expect(formatLocalAgentErrorMessage(primeAgent, error)).toBe(
      'Prime Agent provider authentication failed. Check its provider credentials and try again.',
    );
  });

  it('does not confuse a hard turn limit with a temporary busy response', () => {
    const error = new LocalAgentApiError('sanitized bridge failure', {
      code: 'PRIME_AGENT_TURN_TIMEOUT',
      source: 'prime-agent-channel',
    });

    expect(formatLocalAgentErrorMessage(primeAgent, error)).toBe(
      'Prime Agent turn exceeded its maximum run time.',
    );
  });

  // The mapper falls through to the raw message when no branch matches, so a
  // dropped branch degrades silently — every terminal code needs a pin.
  it.each([
    ['PRIME_AGENT_NO_SESSION', 'No live Prime Agent session is available. Start or resume a session and try again.'],
    ['PRIME_AGENT_PROVIDER_ERROR', 'Prime Agent provider request failed. Check its provider configuration and try again.'],
    ['PRIME_AGENT_TURN_ABORTED', 'Prime Agent turn was aborted.'],
    ['PRIME_AGENT_DELIVERY_FAILED', 'Prime Agent rejected the message before starting the turn.'],
  ])('renders %s with its per-code guidance', (code, expected) => {
    const error = new LocalAgentApiError('sanitized bridge failure', {
      code,
      source: 'prime-agent-channel',
    });

    expect(formatLocalAgentErrorMessage(primeAgent, error)).toBe(expected);
  });
});
