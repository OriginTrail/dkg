import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  isUnrecordedNameHashRow,
  proveOnChainIdClaim,
  provenOnChainIdsFor,
  refutesOnChainBinding,
} from '../src/context-graph-claim-proof.js';

const keccak = (id: string) => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
const noWireKeyedRows = () => false;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('an off-chain on-chain id claim', () => {
  it('holds only when the claimed slot commits the id\'s name', () => {
    expect(proveOnChainIdClaim('g', '33', keccak('g'), noWireKeyedRows))
      .toEqual({ onChainId: '33', onChainHash: keccak('g') });
    expect(proveOnChainIdClaim('g', '33', keccak('g').toUpperCase().replace('0X', '0x'), noWireKeyedRows))
      .toEqual({ onChainId: '33', onChainHash: keccak('g') });
    expect(proveOnChainIdClaim('g', '33', OTHER, noWireKeyedRows)).toBeNull();
    // No committed hash, a malformed one, or a non-canonical id proves nothing.
    expect(proveOnChainIdClaim('g', '33', null, noWireKeyedRows)).toBeNull();
    expect(proveOnChainIdClaim('g', '33', undefined, noWireKeyedRows)).toBeNull();
    expect(proveOnChainIdClaim('g', '33', '0x1234', noWireKeyedRows)).toBeNull();
    expect(proveOnChainIdClaim('g', '033', keccak('g'), noWireKeyedRows)).toBeNull();
    expect(proveOnChainIdClaim('g', '0', keccak('g'), noWireKeyedRows)).toBeNull();
  });

  it('holds for a row keyed by the committed hash itself only when it is wire-keyed', () => {
    const hash = keccak('g');
    expect(proveOnChainIdClaim(hash, '33', hash, noWireKeyedRows)).toBeNull();
    expect(proveOnChainIdClaim(hash, '33', hash, (id) => id === hash))
      .toEqual({ onChainId: '33', onChainHash: hash });
  });

  it('is proven by every slot that commits the id\'s name, and by no other', () => {
    const facts = new Map([
      ['1', { nameHash: keccak('g') }],
      ['2', { nameHash: OTHER }],
      ['3', { nameHash: null }],
      ['4', { nameHash: keccak('g') }],
    ]);
    expect(provenOnChainIdsFor('g', facts, noWireKeyedRows)).toEqual(['1', '4']);
    expect(provenOnChainIdsFor('h', facts, noWireKeyedRows)).toEqual([]);
    // A lone surrogate cannot be UTF-8 encoded: nothing proven, nothing thrown.
    expect(provenOnChainIdsFor('bad-\uD800', facts, noWireKeyedRows)).toEqual([]);
  });
});

describe('refuting a binding', () => {
  const hash = keccak('real');

  it('refutes a row bound to the slot whose id the slot does not commit', () => {
    expect(refutesOnChainBinding('baseball', { onChainId: '33' }, '33', hash, noWireKeyedRows)).toBe(true);
    expect(refutesOnChainBinding('real', { onChainId: '33' }, '33', hash, noWireKeyedRows)).toBe(false);
    expect(refutesOnChainBinding('baseball', { onChainId: '34' }, '33', hash, noWireKeyedRows)).toBe(false);
    expect(refutesOnChainBinding('baseball', {}, '33', hash, noWireKeyedRows)).toBe(false);
  });

  it('never refutes rows with their own lifecycle', () => {
    // A row recording the commitment, a row keyed by the committed hash, a
    // wire-keyed row and a bare-number row.
    expect(refutesOnChainBinding('baseball', { onChainId: '33', onChainHash: hash }, '33', hash, noWireKeyedRows))
      .toBe(false);
    expect(refutesOnChainBinding(hash, { onChainId: '33' }, '33', hash, noWireKeyedRows)).toBe(false);
    expect(refutesOnChainBinding(OTHER, { onChainId: '33' }, '33', hash, (id) => id === OTHER)).toBe(false);
    expect(refutesOnChainBinding('33', { onChainId: '33' }, '33', hash, noWireKeyedRows)).toBe(false);
    // A malformed committed hash refutes nothing.
    expect(refutesOnChainBinding('baseball', { onChainId: '33' }, '33', 'not-a-hash', noWireKeyedRows)).toBe(false);
  });
});

describe('a name-hash row that never recorded its hash', () => {
  const hash = keccak('real');

  it('is keyed by the slot\'s committed hash and bound to the slot, with no onChainHash', () => {
    expect(isUnrecordedNameHashRow(hash, { onChainId: '33' }, '33', hash)).toBe(true);
    expect(isUnrecordedNameHashRow(hash, { onChainId: '33', onChainHash: hash }, '33', hash)).toBe(false);
    expect(isUnrecordedNameHashRow(hash, {}, '33', hash)).toBe(false);
    expect(isUnrecordedNameHashRow(hash, { onChainId: '34' }, '33', hash)).toBe(false);
    expect(isUnrecordedNameHashRow('real', { onChainId: '33' }, '33', hash)).toBe(false);
    expect(isUnrecordedNameHashRow(hash, { onChainId: '33' }, '33', 'not-a-hash')).toBe(false);
  });
});
