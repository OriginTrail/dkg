import { describe, expect, it } from 'vitest';

import {
  MAX_NETWORK_ID_BYTES_V1,
  assertNetworkIdV1,
} from '../src/sync-wire-identifiers.js';

describe('RFC-64 shared wire identifiers', () => {
  it('preserves the canonical network-id grammar and byte ceiling', () => {
    expect(() => assertNetworkIdV1('otp:20430')).not.toThrow();
    expect(() => assertNetworkIdV1('otp/20430')).toThrow(/networkId grammar/);
    expect(() => assertNetworkIdV1('')).toThrow(/non-empty string/);
    expect(() => assertNetworkIdV1('a'.repeat(MAX_NETWORK_ID_BYTES_V1))).not.toThrow();
    expect(() => assertNetworkIdV1('a'.repeat(MAX_NETWORK_ID_BYTES_V1 + 1))).toThrow(
      /128 UTF-8 bytes/,
    );
  });
});
