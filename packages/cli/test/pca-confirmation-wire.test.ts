import { describe, it, expect } from 'vitest';
import { pcaConfirmationToWire, parseRegisterPcaAgentResult } from '../src/pca-confirmation-wire.js';

const BASE = { accountId: '7', agent: '0xabc', txHash: '0xreg', blockNumber: 9 };

// The daemon side: agent confirmation outcome → wire advisory fields.
describe('pcaConfirmationToWire (outcome → wire advisory fields)', () => {
  it('maps each outcome to its coherent wire shape', () => {
    expect(pcaConfirmationToWire('confirmed')).toEqual({ adapterSupported: true, verified: true });
    expect(pcaConfirmationToWire('not_observed')).toEqual({ adapterSupported: true, verified: false });
    expect(pcaConfirmationToWire('inconclusive')).toEqual({ adapterSupported: true, verified: null });
    expect(pcaConfirmationToWire('unsupported')).toEqual({ adapterSupported: false, verified: null });
  });
});

// The client parser is the ONE runtime boundary for raw daemon JSON: it validates
// the wire shape and normalizes current + legacy responses into { registered,
// advisory }. Cover every current advisory shape THROUGH the parser, plus legacy
// tolerance and the rejection paths.
describe('parseRegisterPcaAgentResult', () => {
  it('current daemon → normalized advisory for every shape', () => {
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: true, adapterSupported: true }))
      .toEqual({ ...BASE, registered: true, advisory: 'confirmed' });
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: false, adapterSupported: true }))
      .toEqual({ ...BASE, registered: true, advisory: 'pending' });
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: null, adapterSupported: true }))
      .toEqual({ ...BASE, registered: true, advisory: 'pending' });
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: null, adapterSupported: false }))
      .toEqual({ ...BASE, registered: true, advisory: 'unsupported' });
  });

  it('legacy daemon (verified absent): observed-registered → confirmed; otherwise registered as-is + legacy-unverified', () => {
    // old read observed it registered → the tx succeeded → confirmed
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, adapterSupported: true }))
      .toEqual({ ...BASE, registered: true, advisory: 'confirmed' });
    // read did not confirm — a legacy daemon has no success guard, so registered
    // stays as-is (never forced true) with legacy-unverified.
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: false, adapterSupported: false }))
      .toEqual({ ...BASE, registered: false, advisory: 'legacy-unverified' });
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: false, adapterSupported: true }))
      .toEqual({ ...BASE, registered: false, advisory: 'legacy-unverified' });
  });

  it('rejects an incoherent current shape (adapterSupported:false with a non-null verified)', () => {
    expect(() => parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: true, adapterSupported: false }))
      .toThrow(/incoherent/i);
  });

  it('rejects a verified-present response with registered:false (never promoted to success)', () => {
    for (const verified of [true, false, null]) {
      expect(() => parseRegisterPcaAgentResult({ ...BASE, registered: false, verified, adapterSupported: true }))
        .toThrow(/registered:false/i);
    }
  });

  it('rejects a malformed shape (missing/mistyped required field)', () => {
    expect(() => parseRegisterPcaAgentResult({ ...BASE, registered: true, adapterSupported: 'yes' as unknown }))
      .toThrow(/adapterSupported/);
    expect(() => parseRegisterPcaAgentResult(null)).toThrow(/not an object/);
    expect(() => parseRegisterPcaAgentResult({ agent: '0xabc', registered: true, adapterSupported: true }))
      .toThrow(/accountId/);
  });
});
