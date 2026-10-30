import { describe, expect, it } from 'vitest';
import { resolveBooleanEnvOverride } from '../src/boolean-env-override.js';
import {
  resolveContextGraphSubscriptionRehydrationEnabled,
  resolveNetworkPeerIsolationEnabled,
} from '../src/config.js';
import { resolveMetricsCollectorConfig } from '../src/metrics-collector-config.js';

function resolve(envValue: string | undefined, configValue: unknown, defaultValue = true): boolean {
  return resolveBooleanEnvOverride({
    envName: 'DKG_EXAMPLE_ENABLED',
    configName: 'exampleEnabled',
    envValue,
    configValue,
    defaultValue,
  });
}

describe('resolveBooleanEnvOverride', () => {
  it('lets a set environment variable win in either direction', () => {
    for (const value of ['1', 'true', ' TRUE ', 'True']) expect(resolve(value, false)).toBe(true);
    for (const value of ['0', 'false', ' FALSE ', 'False']) expect(resolve(value, true)).toBe(false);
  });

  it('fails loudly on any other environment value, the empty string included', () => {
    for (const value of ['', '   ', 'yes', 'no', 'on', 'off', '2', 'disable']) {
      expect(() => resolve(value, true)).toThrow(
        `DKG_EXAMPLE_ENABLED must be one of 1, 0, true, or false (received ${JSON.stringify(value)})`,
      );
    }
  });

  it('falls back to a boolean config value, then to the default', () => {
    expect(resolve(undefined, true, false)).toBe(true);
    expect(resolve(undefined, false, true)).toBe(false);
    expect(resolve(undefined, undefined, true)).toBe(true);
    expect(resolve(undefined, undefined, false)).toBe(false);
    for (const value of ['false', 0, 1, null, {}]) {
      expect(() => resolve(undefined, value)).toThrow(
        `exampleEnabled must be a boolean (received ${JSON.stringify(value)})`,
      );
    }
  });

  it('gives every env-overrides-config daemon flag the same answer', () => {
    const flags: Array<(configValue: unknown, envValue: string | undefined) => boolean> = [
      resolveContextGraphSubscriptionRehydrationEnabled,
      resolveNetworkPeerIsolationEnabled,
      (configValue, envValue) => resolveMetricsCollectorConfig(
        { telemetry: { metrics: { collectionEnabled: configValue } } } as any,
        { DKG_METRICS_COLLECTION_ENABLED: envValue },
      ).enabled,
    ];
    const outcome = (flag: (typeof flags)[number], configValue: unknown, envValue: string | undefined) => {
      try {
        return flag(configValue, envValue);
      } catch {
        return 'throws';
      }
    };
    for (const envValue of [undefined, '', ' ', '1', '0', 'true', 'FALSE', 'yes', 'off']) {
      for (const configValue of [undefined, true, false, 'true']) {
        const expected = outcome(flags[0]!, configValue, envValue);
        for (const flag of flags) expect(outcome(flag, configValue, envValue)).toBe(expected);
      }
    }
  });
});
