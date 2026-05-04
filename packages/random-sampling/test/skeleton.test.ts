import { describe, it, expect } from 'vitest';
import { RANDOM_SAMPLING_PACKAGE_VERSION } from '../src/index.js';

describe('@origintrail-official/dkg-random-sampling — skeleton', () => {
  it('exposes a version constant matching the rest of the workspace', () => {
    expect(RANDOM_SAMPLING_PACKAGE_VERSION).toBe('10.0.0-rc.2');
  });
});
