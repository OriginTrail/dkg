import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

describe('System Record V1 module ownership', () => {
  it('keeps the supported package, object, and inventory facades explicit', () => {
    for (const facade of [
      'system-record-v1.ts',
      'system-record-objects-v1.ts',
      'system-record-inventory-v1.ts',
    ]) {
      expect(source(facade)).not.toMatch(/export\s+\*/u);
    }
  });

  it('keeps internal ownership units off compatibility facades', () => {
    for (const unit of [
      'system-record-agent-profile-codecs-v1-internal.ts',
      'system-record-signatures-v1-internal.ts',
      'system-record-authority-summary-v1-internal.ts',
      'system-record-authority-v1-internal.ts',
      'system-record-verification-closure-v1-internal.ts',
      'system-record-cache-accounting-v1-internal.ts',
      'system-record-inventory-codecs-v1-internal.ts',
      'system-record-inventory-traversal-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]) {
      expect(source(unit)).not.toMatch(/system-record-(objects|inventory)-v1/u);
    }
  });

  it('keeps inventory codecs, traversal, and COW mutation independent of authority policy', () => {
    for (const unit of [
      'system-record-inventory-codecs-v1-internal.ts',
      'system-record-inventory-traversal-v1-internal.ts',
      'system-record-inventory-cow-v1-internal.ts',
    ]) {
      expect(source(unit)).not.toMatch(
        /system-record-(objects-v1|authority-v1|verification-closure-v1|cache-accounting-v1)/u,
      );
    }
  });

  it('keeps profile data codecs independent of signature verification', () => {
    expect(source('system-record-agent-profile-codecs-v1-internal.ts')).not.toMatch(
      /system-record-signatures-v1-internal/u,
    );
  });

  it('keeps wire and applied-state codecs off authority and closure implementations', () => {
    for (const unit of ['system-record-wire-v1.ts', 'system-record-applied-state-v1.ts']) {
      expect(source(unit)).not.toMatch(
        /system-record-(objects-v1|authority-v1-internal|verification-closure-v1|cache-accounting-v1)/u,
      );
    }
  });
});
