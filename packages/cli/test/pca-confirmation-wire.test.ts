import { describe, it, expect } from 'vitest';
import { pcaConfirmationToWire, decodeRegisterAgentAdvisory, parseRegisterPcaAgentResult } from '../src/pca-confirmation-wire.js';

const BASE = { accountId: '7', agent: '0xabc', txHash: '0xreg', blockNumber: 9 };

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

  // R14 (14-A) — a legacy daemon had no success:false guard, so a legacy
  // registered:false may be a failed/unconfirmed tx. Only registered:true+
  // adapterSupported:true (the old read OBSERVED it) is confirmed; otherwise
  // `registered` is surfaced AS-IS (never forced true) with legacy-unverified —
  // so a failed/unconfirmed legacy registration is NEVER reported as success.
  it('legacy daemon (verified absent): only observed-registered → confirmed; otherwise registered stays AS-IS + legacy-unverified', () => {
    // old read observed it registered → the tx succeeded → confirmed
    expect(decodeRegisterAgentAdvisory({ registered: true, adapterSupported: true }))
      .toEqual({ registered: true, advisory: 'confirmed' });
    // no probe surface, read did not confirm — DO NOT force registered:true
    expect(decodeRegisterAgentAdvisory({ registered: false, adapterSupported: false }))
      .toEqual({ registered: false, advisory: 'legacy-unverified' });
    // read ran but did not observe it — cannot assert tx success; registered stays false
    expect(decodeRegisterAgentAdvisory({ registered: false, adapterSupported: true }))
      .toEqual({ registered: false, advisory: 'legacy-unverified' });
  });
});

// R16 (16-A) — the client is a REAL runtime boundary: parse+validate the raw
// JSON, don't just cast it. Incoherent/malformed wire shapes fail loudly here.
describe('parseRegisterPcaAgentResult', () => {
  it('current coherent response → normalized result', () => {
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: true, verified: true, adapterSupported: true }))
      .toEqual({ ...BASE, registered: true, advisory: 'confirmed' });
  });

  it('legacy response (verified absent, registered:false) → registered:false + legacy-unverified', () => {
    expect(parseRegisterPcaAgentResult({ ...BASE, registered: false, adapterSupported: false }))
      .toEqual({ ...BASE, registered: false, advisory: 'legacy-unverified' });
  });

  it('rejects an INCOHERENT shape (adapterSupported:false with a non-null verified)', () => {
    expect(() => parseRegisterPcaAgentResult({ ...BASE, registered: false, verified: true, adapterSupported: false }))
      .toThrow(/incoherent/i);
  });

  it('rejects a malformed shape (missing/mistyped required field)', () => {
    expect(() => parseRegisterPcaAgentResult({ ...BASE, registered: true, adapterSupported: 'yes' as unknown }))
      .toThrow(/adapterSupported/);
    expect(() => parseRegisterPcaAgentResult(null)).toThrow(/not an object/);
    expect(() => parseRegisterPcaAgentResult({ agent: '0xabc', registered: true, adapterSupported: true }))
      .toThrow(/accountId/);
  });
});
