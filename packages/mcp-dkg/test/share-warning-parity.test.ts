import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SHARE_NOT_PUBLISH_READY_WARNING,
  SHARE_SUBSET_NOT_PUBLISH_READY_WARNING,
  SHARE_INCOMPLETE_PROMOTE_WARNING,
  classifyShareWarning,
} from '../src/tools/assertions.js';

// #1116 — the three share-outcome warnings are duplicated byte-identical across
// the MCP, OpenClaw, and Hermes adapters (no shared runtime module — MCP has no
// dkg-core dependency, and a new package is out of scope). This GOLDEN test makes
// drift a test failure, not a stale comment: each adapter asserts its constants
// equal the single canonical fixture at tests/fixtures/share-seal-warnings.json.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, '../../../tests/fixtures/share-seal-warnings.json'), 'utf-8'),
) as Record<string, string>;

describe('#1116 share-warning parity (MCP vs canonical fixture)', () => {
  it('SHARE_NOT_PUBLISH_READY_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_NOT_PUBLISH_READY_WARNING).toBe(fixture.SHARE_NOT_PUBLISH_READY_WARNING);
  });

  it('SHARE_SUBSET_NOT_PUBLISH_READY_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_SUBSET_NOT_PUBLISH_READY_WARNING).toBe(fixture.SHARE_SUBSET_NOT_PUBLISH_READY_WARNING);
  });

  it('SHARE_INCOMPLETE_PROMOTE_WARNING matches the fixture byte-for-byte', () => {
    expect(SHARE_INCOMPLETE_PROMOTE_WARNING).toBe(fixture.SHARE_INCOMPLETE_PROMOTE_WARNING);
  });

  // The classifier's three-way precedence (sealed:true > subset > skipSeal) plus
  // the publish-ready short-circuit.
  it('classifyShareWarning picks the right warning per outcome', () => {
    // publish-ready → no warning regardless of scope.
    expect(classifyShareWarning({ sealed: true, publishReady: true, isSubset: false })).toBeUndefined();
    expect(classifyShareWarning({ publishReady: undefined, isSubset: true })).toBeUndefined();
    // sealed:true + not publish-ready → incomplete full promote (wins over subset).
    expect(classifyShareWarning({ sealed: true, publishReady: false, isSubset: true })).toBe(
      SHARE_INCOMPLETE_PROMOTE_WARNING,
    );
    // sealed:false + subset → not sealable.
    expect(classifyShareWarning({ sealed: false, publishReady: false, isSubset: true })).toBe(
      SHARE_SUBSET_NOT_PUBLISH_READY_WARNING,
    );
    // sealed:false + full (skip_seal) → recover through WM + atomic full share.
    expect(classifyShareWarning({ sealed: false, publishReady: false, isSubset: false })).toBe(
      SHARE_NOT_PUBLISH_READY_WARNING,
    );
  });
});
