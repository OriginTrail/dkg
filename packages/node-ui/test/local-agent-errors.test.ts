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
});
