import { describe, it, expect } from 'vitest';
import { pcaConfirmationToWire, decodeRegisterAgentAdvisory } from '../src/pca-confirmation-wire.js';

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

// R11 (11-B/11-C) — centralized decoding of a register-agent response (current
// AND pre-#1346 legacy wire shape) into one coherent { registered, advisory }.
describe('decodeRegisterAgentAdvisory', () => {
  it('current daemon: verified drives advisory; registered stays as sent', () => {
    expect(decodeRegisterAgentAdvisory({ registered: true, verified: true, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'confirmed' });
    expect(decodeRegisterAgentAdvisory({ registered: true, verified: false, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'pending' });
    expect(decodeRegisterAgentAdvisory({ registered: true, verified: null, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'pending' });
    expect(decodeRegisterAgentAdvisory({ registered: true, verified: null, adapterSupported: false }))
      .toEqual({ registered: true, advisory: 'unsupported' });
  });

  it('legacy daemon (verified absent): registered follows the mined-tx authority (true), advisory from the old fields', () => {
    // confirmed — old registered:true meant the read confirmed it
    expect(decodeRegisterAgentAdvisory({ registered: true, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'confirmed' });
    // no probe surface — registered becomes true (mined-tx authority), NOT the old false
    expect(decodeRegisterAgentAdvisory({ registered: false, adapterSupported: false }))
      .toEqual({ registered: true, advisory: 'unsupported' });
    // read ran, not yet observed — registered true (mined), advisory pending
    expect(decodeRegisterAgentAdvisory({ registered: false, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'pending' });
  });
});
