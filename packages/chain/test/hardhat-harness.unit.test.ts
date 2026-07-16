import { describe, expect, it } from 'vitest';
import { parseSuccessfulHubDeployment } from './hardhat-harness.js';

describe('parseSuccessfulHubDeployment', () => {
  const output = 'deploying "Hub" (tx: 0x123)... deployed at 0xabc with 1 gas';

  it('returns the Hub address only after a successful deploy process', () => {
    expect(parseSuccessfulHubDeployment(output, '', 0, null)).toBe('0xabc');
  });

  it('rejects partial output when the deploy process was killed', () => {
    expect(() => parseSuccessfulHubDeployment(output, 'out of memory', null, 'SIGKILL'))
      .toThrow(/Deploy failed.*SIGKILL/s);
  });
});
