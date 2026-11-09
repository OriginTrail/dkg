import { describe, expect, it } from 'vitest';
import { requireGraphFrameCount } from '../swm-host-store-durability/stats-evidence.js';
describe('host-store graph-specific API evidence', () => {
  it('accepts exact cleartext or wire identity counts', () => {
    expect(() => requireGraphFrameCount({ graph: { entries: 3 } }, 'graph', '0x77', 3)).not.toThrow();
    expect(() => requireGraphFrameCount({ '0x77': { entries: 3 } }, 'graph', '0x77', 3)).not.toThrow();
  });
  it('rejects unrelated sufficient totals and incorrect counts', () => {
    expect(() => requireGraphFrameCount({ unrelated: { entries: 30 } }, 'graph', '0x77', 3)).toThrow('omit tested graph');
    expect(() => requireGraphFrameCount({ graph: { entries: 2 }, unrelated: { entries: 30 } }, 'graph', undefined, 3)).toThrow('expected 3');
  });
});
