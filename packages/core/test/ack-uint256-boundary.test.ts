// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  computeACKDigest,
  computePublishACKDigest,
  computeUpdateACKDigest,
  uint256ToBytes,
} from '../src/crypto/ack.js';

const ADDRESS = '0x000000000000000000000000000000000000c10a';
const ROOT = new Uint8Array(32).fill(0x42);
const OUT_OF_RANGE = [
  ['negative', -1n],
  ['overflow', (1n << 256n)],
] as const;

describe('ACK digest uint256 boundaries', () => {
  it.each(OUT_OF_RANGE)('uint256ToBytes rejects %s values instead of truncating', (_label, value) => {
    expect(() => uint256ToBytes(value)).toThrow('value must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('legacy ACK digest rejects a %s contextGraphId', (_label, value) => {
    expect(() => computeACKDigest(value, ROOT)).toThrow('value must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('publish ACK digest rejects a %s tokenAmount', (_label, value) => {
    expect(() => computePublishACKDigest(
      1n,
      ADDRESS,
      1n,
      ROOT,
      1n,
      1n,
      1n,
      value,
      1n,
    )).toThrow('tokenAmount must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('publish ACK digest rejects a %s contextGraphId', (_label, value) => {
    expect(() => computePublishACKDigest(
      1n,
      ADDRESS,
      value,
      ROOT,
      1n,
      1n,
      1n,
      1n,
      1n,
    )).toThrow('value must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('update ACK digest rejects a %s kaId', (_label, value) => {
    expect(() => computeUpdateACKDigest(
      1n,
      ADDRESS,
      1n,
      value,
      1n,
      ROOT,
      1n,
      1n,
      0n,
      [],
      1n,
    )).toThrow('value must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('update ACK digest rejects a %s contextGraphId', (_label, value) => {
    expect(() => computeUpdateACKDigest(
      1n,
      ADDRESS,
      value,
      1n,
      1n,
      ROOT,
      1n,
      1n,
      0n,
      [],
      1n,
    )).toThrow('value must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('update ACK digest rejects a %s newTokenAmount', (_label, value) => {
    expect(() => computeUpdateACKDigest(
      1n,
      ADDRESS,
      1n,
      1n,
      1n,
      ROOT,
      1n,
      value,
      0n,
      [],
      1n,
    )).toThrow('tokenAmount must fit in uint256');
  });

  it.each(OUT_OF_RANGE)('update ACK digest rejects a %s burnTokenId', (_label, value) => {
    expect(() => computeUpdateACKDigest(
      1n,
      ADDRESS,
      1n,
      1n,
      1n,
      ROOT,
      1n,
      1n,
      0n,
      [value],
      1n,
    )).toThrow('value must fit in uint256');
  });
});
