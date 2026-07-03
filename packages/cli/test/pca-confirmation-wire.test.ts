import { describe, it, expect } from 'vitest';
import { pcaConfirmationToWire } from '../src/pca-confirmation-wire.js';

// R9 (9-A) — the wire advisory derivation lives at the CLI boundary now (moved
// out of the agent package); pin the exhaustive outcome → { verified,
// adapterSupported } mapping here.
describe('pcaConfirmationToWire (outcome → wire advisory fields)', () => {
  it('maps each outcome to its coherent wire shape', () => {
    expect(pcaConfirmationToWire('confirmed')).toEqual({ adapterSupported: true, verified: true });
    expect(pcaConfirmationToWire('not_observed')).toEqual({ adapterSupported: true, verified: false });
    expect(pcaConfirmationToWire('inconclusive')).toEqual({ adapterSupported: true, verified: null });
    expect(pcaConfirmationToWire('unsupported')).toEqual({ adapterSupported: false, verified: null });
  });
});
