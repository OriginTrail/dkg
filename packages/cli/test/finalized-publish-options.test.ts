import { Command } from 'commander';
import { MAX_UINT72_DECIMAL } from '@origintrail-official/dkg-core';
import { addFinalizedPublishOptions, parseFinalizedPublishOptions } from '../src/commands/finalized-publish-command-options.js';
import { describe, expect, it } from 'vitest';
import {
  finalizedPublishOptionsPayload,
  formatFinalizedPublishOptionError,
  parseCliFinalizedPublishOptions,
  parseHttpFinalizedPublishOptions,
} from '../src/finalized-publish-options.js';

describe('finalized publication pricing options', () => {
  it('normalizes full-content pricing across CLI, HTTP, and SDK boundaries', () => {
    expect(parseCliFinalizedPublishOptions({ pricingPolicy: 'full-content' })).toEqual({
      ok: true,
      options: { pricingPolicy: 'full-content' },
    });
    expect(parseHttpFinalizedPublishOptions({ pricingPolicy: 'full-content' })).toEqual({
      ok: true,
      options: { pricingPolicy: 'full-content' },
    });
    expect(finalizedPublishOptionsPayload({ pricingPolicy: 'full-content' })).toEqual({
      pricingPolicy: 'full-content',
    });
  });

  it('rejects unknown pricing policies at the request boundary', () => {
    const parsed = parseHttpFinalizedPublishOptions({ pricingPolicy: 'caller-reported' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(formatFinalizedPublishOptionError(parsed.error)).toBe(
      '"pricingPolicy" must be "full-content" when supplied',
    );
  });
});

describe('finalized publish boundary contracts', () => {
  it('preserves command flags and typed parsed values', () => {
    const command = addFinalizedPublishOptions(new Command());
    expect(command.options.map((option) => option.flags)).toEqual([
      '--publish-epochs <count>', '--pricing-policy <policy>', '--publisher-node-identity-id <id>',
    ]);
    command.parse(['--publish-epochs', '12', '--pricing-policy', 'full-content',
      '--publisher-node-identity-id', MAX_UINT72_DECIMAL], { from: 'user' });
    expect(parseFinalizedPublishOptions(command.opts())).toEqual({
      publishEpochs: 12, pricingPolicy: 'full-content',
      publisherNodeIdentityIdOverride: BigInt(MAX_UINT72_DECIMAL),
    });
  });

  it.each([1, 12, 4294967295])('emits SDK publishEpochs=%i under its canonical field', (publishEpochs) => {
    expect(finalizedPublishOptionsPayload({ publishEpochs })).toEqual({ publishEpochs });
  });

  it.each([
    [0, '"publishEpochs" must be a positive safe integer (string or number)'],
    [4294967296, '"publishEpochs" must be less than or equal to 4294967295'],
  ] as const)('rejects SDK publishEpochs=%i using the SDK field label', (publishEpochs, message) => {
    expect(() => finalizedPublishOptionsPayload({ publishEpochs })).toThrow(message);
  });

  it('preserves false, zero attribution, and exact uint72 serialization', () => {
    expect(finalizedPublishOptionsPayload({ clearAfter: false, publisherNodeIdentityIdOverride: 0n }))
      .toEqual({ clearSharedMemoryAfter: false, publisherNodeIdentityIdOverride: '0' });
    expect(finalizedPublishOptionsPayload({ publisherNodeIdentityIdOverride: BigInt(MAX_UINT72_DECIMAL) }))
      .toEqual({ publisherNodeIdentityIdOverride: MAX_UINT72_DECIMAL });
    expect(finalizedPublishOptionsPayload({})).toBeUndefined();
  });

  it.each([
    [{ clearAfter: false, clearSharedMemoryAfter: true }, { clearSharedMemoryAfter: false }],
    [{ clearSharedMemoryAfter: true }, { clearSharedMemoryAfter: true }],
    [{ publishEpochs: 12, epochs: 24 }, { publishEpochs: 12 }],
    [{ publishEpochs: null, epochs: 24 }, { publishEpochs: 24 }],
    [{ epochs: '24' }, { publishEpochs: 24 }],
    [{ publisherNodeIdentityIdOverride: '0' }, { publisherNodeIdentityIdOverride: 0n }],
  ])('preserves HTTP alias precedence for %j', (input, options) => {
    expect(parseHttpFinalizedPublishOptions(input)).toEqual({ ok: true, options });
  });

  it.each([
    [{ clearAfter: true, clearSharedMemoryAfter: 'false' }, '"clearSharedMemoryAfter" must be a boolean when supplied'],
    [{ clearAfter: null, clearSharedMemoryAfter: false }, '"clearAfter" must be a boolean when supplied'],
    [{ epochs: '0' }, '"epochs" must be a positive integer (string or number)'],
    [{ publishEpochs: null, epochs: '0' }, '"publishEpochs" must be a positive integer (string or number)'],
    [{ publishEpochs: 0 }, '"publishEpochs" must be a positive safe integer (string or number)'],
    [{ publishEpochs: '4294967296' }, '"publishEpochs" must be less than or equal to 4294967295'],
    [{ publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1 }, '"publisherNodeIdentityIdOverride" must be a non-negative safe integer (string or number)'],
    [{ publisherNodeIdentityIdOverride: '4722366482869645213696' }, `"publisherNodeIdentityIdOverride" must be between 0 and ${MAX_UINT72_DECIMAL} (uint72)`],
  ])('preserves HTTP validation and error labels for %j', (input, message) => {
    const parsed = parseHttpFinalizedPublishOptions(input);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected validation failure');
    expect(formatFinalizedPublishOptionError(parsed.error)).toBe(message);
  });

  it.each([
    [{ publishEpochs: '0' }, '--publish-epochs must be a positive integer (string or number)'],
    [{ pricingPolicy: 'unknown' }, '--pricing-policy must be "full-content" when supplied'],
    [{ publisherNodeIdentityId: '-1' }, '--publisher-node-identity-id must be a non-negative integer (string or number)'],
  ])('preserves CLI flag labels for %j', (input, message) => {
    expect(() => parseFinalizedPublishOptions(input)).toThrow(message);
  });

  it('keeps SDK spelling strict and HTTP unknown options permissive', () => {
    const unsupported = { epochs: 12, clearAfter: false };
    expect(() => finalizedPublishOptionsPayload(unsupported))
      .toThrow('Unsupported finalized publish option(s): epochs');
    expect(parseHttpFinalizedPublishOptions({ futureOption: 12 })).toEqual({ ok: true, options: {} });
  });
});
