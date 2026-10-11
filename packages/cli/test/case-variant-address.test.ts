// caseVariantAddress feeds the differently-cased author tests in
// agent-chat-update-route and knowledge-assets-route. Those suites pass random
// agent addresses, which reach its lower-case branch only about 1 in 4,000
// runs, so every branch is pinned here with EIP-55's own test vectors.
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { caseVariantAddress } from './helpers/live-daemon.js';

function expectVariant(address: string, expected: string) {
  const variant = caseVariantAddress(address);
  expect(variant).toBe(expected);
  // getAddress throws on a bad checksum, so this also proves the variant is a
  // spelling EIP-55 accepts.
  expect(ethers.getAddress(variant)).toBe(address);
}

describe('caseVariantAddress', () => {
  it('upper-cases a mixed-case checksum', () => {
    expectVariant('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED');
  });

  it('upper-cases a checksum whose hex letters are all lower case', () => {
    expectVariant('0xde709f2102306220921060314715629080e2fb77', '0xDE709F2102306220921060314715629080E2FB77');
  });

  it('lower-cases a checksum whose hex letters are all upper case', () => {
    expectVariant('0x52908400098527886E0F7030069857D2E4169EE7', '0x52908400098527886e0f7030069857d2e4169ee7');
  });

  it('throws for an address with no hex letters', () => {
    expect(() => caseVariantAddress(`0x${'1'.repeat(40)}`)).toThrow(/no hex letters/);
  });
});
