import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EPCIS_DEFAULT_TEST_EXCLUDE,
  EPCIS_DEFAULT_TEST_INCLUDE,
} from '../vitest.config.js';
import { EPCIS_E2E_TEST_INCLUDE } from '../vitest.e2e.config.js';
import {
  assertEpcisLiveNodeAvailable,
  isEpcisLiveNodeRequired,
} from './e2e-prerequisites.js';

describe('EPCIS live-node prerequisite policy', () => {
  it('allows the default suite to skip an unavailable local daemon', () => {
    expect(() => assertEpcisLiveNodeAvailable(false, false, 'unreachable')).not.toThrow();
  });

  it('makes the explicit e2e command fail instead of passing with zero assertions', () => {
    expect(() => assertEpcisLiveNodeAvailable(true, false, 'unreachable'))
      .toThrow('EPCIS live-node prerequisites are required: unreachable');
  });

  it('derives required mode only from the explicit e2e flag', () => {
    expect(isEpcisLiveNodeRequired({})).toBe(false);
    expect(isEpcisLiveNodeRequired({ DKG_EPCIS_E2E_REQUIRED: '0' })).toBe(false);
    expect(isEpcisLiveNodeRequired({ DKG_EPCIS_E2E_REQUIRED: '1' })).toBe(true);
  });
});

describe('EPCIS test-runner isolation contract', () => {
  it('keeps live-node files out of default tests and includes them in e2e tests', () => {
    expect(EPCIS_DEFAULT_TEST_INCLUDE).toContain('test/**/*.test.ts');
    expect(EPCIS_DEFAULT_TEST_EXCLUDE).toContain('test/**/*.e2e.test.ts');
    expect(EPCIS_E2E_TEST_INCLUDE).toEqual(['test/**/*.e2e.test.ts']);
  });

  it('wires the explicit package script to required mode and the e2e config', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    const e2eScript = packageJson.scripts?.['test:e2e'];

    expect(e2eScript).toContain('DKG_EPCIS_E2E_REQUIRED=1');
    expect(e2eScript).toContain('--config vitest.e2e.config.ts');
  });
});
