import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  NO_NAME_COMMITMENT,
  SlotFactsIndex,
  committedNameHashOf,
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
    // bytes32(0) is a curator's opt-out: it commits no name.
    expect(proveOnChainIdClaim(NO_NAME_COMMITMENT, '33', NO_NAME_COMMITMENT, (id) => id === NO_NAME_COMMITMENT))
      .toBeNull();
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
    const facts = new SlotFactsIndex()
      .set('1', { nameHash: keccak('g') })
      .set('2', { nameHash: OTHER })
      .set('3', { nameHash: null })
      .set('4', { nameHash: keccak('g').toUpperCase().replace('0X', '0x') })
      .set('5', { nameHash: NO_NAME_COMMITMENT });
    expect(provenOnChainIdsFor('g', facts, noWireKeyedRows)).toEqual(['1', '4']);
    expect(provenOnChainIdsFor('h', facts, noWireKeyedRows)).toEqual([]);
    // A row keyed by its own wire id is proven by the slot committing it.
    expect(provenOnChainIdsFor(OTHER, facts, (id) => id === OTHER)).toEqual(['2']);
    expect(provenOnChainIdsFor(OTHER, facts, noWireKeyedRows)).toEqual([]);
    // A lone surrogate cannot be UTF-8 encoded: nothing proven, nothing thrown.
    expect(provenOnChainIdsFor('bad-\uD800', facts, noWireKeyedRows)).toEqual([]);
  });
});

describe('the slot facts index', () => {
  it('follows every write, and indexes only slots that commit a name', () => {
    const facts = new SlotFactsIndex()
      .set('1', { nameHash: keccak('g') })
      .set('2', { nameHash: keccak('g') })
      .set('3', { nameHash: NO_NAME_COMMITMENT })
      .set('4', { nameHash: null });
    expect(facts.onChainIdsCommitting(keccak('g'))).toEqual(['1', '2']);
    expect(facts.onChainIdsCommitting(keccak('g').toUpperCase().replace('0X', '0x'))).toEqual(['1', '2']);
    expect(facts.onChainIdsCommitting(NO_NAME_COMMITMENT)).toEqual([]);

    // A slot that now commits another name (a reorg) moves in the index.
    facts.set('1', { nameHash: OTHER });
    expect(facts.onChainIdsCommitting(keccak('g'))).toEqual(['2']);
    expect(facts.onChainIdsCommitting(OTHER)).toEqual(['1']);
    facts.delete('2');
    expect(facts.onChainIdsCommitting(keccak('g'))).toEqual([]);
    facts.clear();
    expect(facts.onChainIdsCommitting(OTHER)).toEqual([]);
    expect(facts.size).toBe(0);
  });

  it('reads bytes32(0) as no commitment', () => {
    expect(committedNameHashOf(NO_NAME_COMMITMENT)).toBeNull();
    expect(committedNameHashOf(keccak('g').toUpperCase().replace('0X', '0x'))).toBe(keccak('g'));
    expect(committedNameHashOf('0x1234')).toBeNull();
    expect(committedNameHashOf(undefined)).toBeNull();
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
    // A malformed committed hash, or a slot that opted out, refutes nothing.
    expect(refutesOnChainBinding('baseball', { onChainId: '33' }, '33', 'not-a-hash', noWireKeyedRows)).toBe(false);
    expect(refutesOnChainBinding('baseball', { onChainId: '33' }, '33', NO_NAME_COMMITMENT, noWireKeyedRows))
      .toBe(false);
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
    expect(isUnrecordedNameHashRow(NO_NAME_COMMITMENT, { onChainId: '33' }, '33', NO_NAME_COMMITMENT)).toBe(false);
  });
});
