import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = (name: string): string =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

describe('System Record V1 module ownership', () => {
  it('keeps the supported object and inventory facades explicit', () => {
    for (const facade of ['system-record-objects-v1.ts', 'system-record-inventory-v1.ts']) {
      expect(source(facade)).not.toMatch(/export\s+\*/u);
    }
  });

  it('composes the package facade only from the approved public subfacades', () => {
    const facade = source('system-record-v1.ts');
    const wildcardSources = [...facade.matchAll(/export\s+\*\s+from\s+'([^']+)'/gu)]
      .map((match) => match[1]);
    expect(wildcardSources).toEqual([
      './system-record-limits-v1.js',
      './system-record-objects-v1.js',
      './agent-profile-projection-schema-v1.js',
      './system-record-applied-state-v1.js',
      './system-record-inventory-v1.js',
      './system-record-wire-v1.js',
    ]);
    expect(facade).not.toMatch(/-internal\.js/u);
  });

  it('keeps internal ownership units off compatibility facades', () => {
    for (const unit of [
      'system-record-agent-profile-primitives-v1-internal.ts',
      'system-record-agent-profile-head-codec-v1-internal.ts',
      'system-record-agent-profile-control-codecs-v1-internal.ts',
      'system-record-agent-profile-evidence-codecs-v1-internal.ts',
      'system-record-owned-subject-codecs-v1-internal.ts',
      'system-record-signatures-v1-internal.ts',
      'system-record-authority-summary-v1-internal.ts',
      'system-record-authority-verification-v1-internal.ts',
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
    for (const unit of [
      'system-record-agent-profile-primitives-v1-internal.ts',
      'system-record-agent-profile-head-codec-v1-internal.ts',
      'system-record-agent-profile-control-codecs-v1-internal.ts',
      'system-record-agent-profile-evidence-codecs-v1-internal.ts',
      'system-record-owned-subject-codecs-v1-internal.ts',
    ]) {
      expect(source(unit)).not.toMatch(/system-record-signatures-v1-internal/u);
    }
  });

  it('keeps closure verification below authority policy and summary minting private', () => {
    expect(source('system-record-verification-closure-v1-internal.ts')).not.toMatch(
      /system-record-authority-v1-internal/u,
    );
    expect(source('system-record-authority-verification-v1-internal.ts')).not.toMatch(
      /system-record-(authority-summary|verification-closure)-v1-internal/u,
    );
    expect(source('system-record-authority-summary-v1-internal.ts')).not.toMatch(
      /mintAgentProfileVerifiedAuthoritySummaryV1/u,
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
