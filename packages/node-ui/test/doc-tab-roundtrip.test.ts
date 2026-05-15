// Covers the imported-document viewer 404 fix (PR fix/doc-viewer-404).
//
// The original bug: the `doc:` center-tab id was built/parsed inline, and the
// decoder dropped the `keccak256:` algorithm prefix, so the viewer requested
// `/api/file/<barehex>` — which the daemon resolves as sha256 → 404.
//
// The fix is two pure, side-effect-free contracts, exercised here directly
// (no React mount, no global fetch stub — deliberately: an earlier
// integration-style version of this file mounted the full shell repeatedly
// and destabilised the parallel node-ui suite. The 404 root cause is pure
// string/URL logic, so unit-testing the extracted helpers covers the
// regression precisely and deterministically):
//
//   1. `encodeDocTabId` / `decodeDocTabId` (src/ui/lib/doc-tab-id.ts) — the
//      tab-id round-trip must preserve the FULL `urn:dkg:file:keccak256:<hex>`
//      ref and the content-type, and degrade safely for legacy/no-pipe ids.
//   2. `fileUrl()` (src/ui/api.ts) — must keep the `keccak256:` prefix and
//      append `?contentType=`, never collapse a keccak digest to a bare/
//      sha256 path.

import { describe, expect, it } from 'vitest';

import {
  DOC_TAB_PREFIX,
  encodeDocTabId,
  decodeDocTabId,
  resolveDocRef,
} from '../src/ui/lib/doc-tab-id.js';
import { fileUrl } from '../src/ui/api.js';

const HEX = 'a'.repeat(64);
const FILE_REF = `urn:dkg:file:keccak256:${HEX}`;

describe('doc tab-id encode → decode round-trip', () => {
  it('preserves the full keccak256 ref + contentType (never a bare hex)', () => {
    const id = encodeDocTabId('cg-1', FILE_REF, 'text/markdown');
    expect(id).toBe(`${DOC_TAB_PREFIX}cg-1|${FILE_REF}|text/markdown`);
    expect(id).toContain('keccak256:');

    const decoded = decodeDocTabId(id);
    expect(decoded).toEqual({ docRef: FILE_REF, contentType: 'text/markdown' });
    // The digest survives with its algorithm prefix — this is the 404 fix.
    expect(decoded.docRef).toBe(FILE_REF);
    expect(decoded.docRef).not.toBe(HEX);
  });

  it('survives a contextGraphId that itself contains colons and slashes', () => {
    const cg = 'urn:dkg:context:weird/id:with:colons';
    const id = encodeDocTabId(cg, FILE_REF, 'text/markdown');
    const decoded = decodeDocTabId(id);
    // Only the middle (first..last `|`) segment is the ref; the colon-laden
    // cgId before the first `|` does not bleed into docRef.
    expect(decoded.docRef).toBe(FILE_REF);
    expect(decoded.contentType).toBe('text/markdown');
  });

  it('round-trips an empty contentType (no trailing-segment loss)', () => {
    const id = encodeDocTabId('cg-1', FILE_REF, '');
    expect(id).toBe(`${DOC_TAB_PREFIX}cg-1|${FILE_REF}|`);
    expect(decodeDocTabId(id)).toEqual({ docRef: FILE_REF, contentType: '' });
  });

  it('passes through the entity uri when no source file is linked', () => {
    // handleOpenDoc encodes the entity uri in the docRef slot when there is
    // no markdownForm/sourceFile connection. It is not a `urn:dkg:file:` ref,
    // so the viewer shows its empty state — decode must hand it back intact.
    const entityUri = 'urn:dkg:entity:doc-1';
    const id = encodeDocTabId('cg-1', entityUri, 'text/markdown');
    const decoded = decodeDocTabId(id);
    expect(decoded.docRef).toBe(entityUri);
    expect(decoded.docRef.startsWith('urn:dkg:file:')).toBe(false);
  });
});

describe('decodeDocTabId legacy no-pipe fallback (contract 1b)', () => {
  // Pre-fix / persisted ids had no `|` (old `doc:<scope>:<hash>` shape). The
  // decoder must degrade gracefully: docRef = whole payload, contentType = ''.

  it('non-file legacy payload → docRef = raw payload, contentType = ""', () => {
    const id = `${DOC_TAB_PREFIX}cg-1:${HEX}`;
    expect(id.includes('|')).toBe(false);
    const decoded = decodeDocTabId(id);
    expect(decoded).toEqual({ docRef: `cg-1:${HEX}`, contentType: '' });
    // Not a urn:dkg:file: ref ⇒ caller shows the empty state, no request.
    expect(decoded.docRef.startsWith('urn:dkg:file:')).toBe(false);
  });

  it('legacy payload that IS a file urn → docRef keeps the keccak256 prefix', () => {
    const id = `${DOC_TAB_PREFIX}${FILE_REF}`;
    expect(id.includes('|')).toBe(false);
    const decoded = decodeDocTabId(id);
    expect(decoded.docRef).toBe(FILE_REF);
    expect(decoded.contentType).toBe('');
  });
});

describe('fileUrl() request contract (the 404 linchpin)', () => {
  it('keeps the keccak256: prefix and appends ?contentType=', () => {
    const url = fileUrl(`keccak256:${HEX}`, 'text/markdown');
    expect(url).toBe(
      `/api/file/${encodeURIComponent(`keccak256:${HEX}`)}?contentType=${encodeURIComponent('text/markdown')}`,
    );
    expect(url).toContain('keccak256%3A');
    // The exact original-bug shape must NOT be produced.
    expect(url).not.toBe(`/api/file/${HEX}`);
  });

  it('omits the query entirely when contentType is unknown (legacy path)', () => {
    const url = fileUrl(`keccak256:${HEX}`);
    expect(url).toBe(`/api/file/${encodeURIComponent(`keccak256:${HEX}`)}`);
    expect(url).not.toContain('?contentType=');
    expect(url).toContain('keccak256%3A');
  });

  it('documents the original defect: a BARE hex is treated as sha256', () => {
    // This is exactly what the buggy decoder used to feed in; the daemon then
    // looked the keccak digest up as sha256 and 404'd. Asserting it pins down
    // why the prefix must be preserved end-to-end.
    const url = fileUrl(HEX);
    expect(url).toBe(`/api/file/${encodeURIComponent(`sha256:${HEX}`)}`);
    expect(url).toContain('sha256%3A');
  });
});

describe('end-to-end encode → decode → fileUrl (regression for the 404)', () => {
  it('a markdown import yields a keccak256 request with the content-type hint', () => {
    const tabId = encodeDocTabId('project-x', FILE_REF, 'text/markdown');
    const { docRef, contentType } = decodeDocTabId(tabId);

    // The viewer strips only the `urn:dkg:file:` prefix before calling
    // fileUrl(); mirror that here to assert the full chain.
    const hash = docRef.replace('urn:dkg:file:', '');
    const url = fileUrl(hash, contentType || undefined);

    expect(url).toBe(
      `/api/file/${encodeURIComponent(`keccak256:${HEX}`)}?contentType=${encodeURIComponent('text/markdown')}`,
    );
    expect(url).not.toBe(`/api/file/${HEX}`);
  });
});

describe('resolveDocRef content-type hint (Codex review fix)', () => {
  const MD_REF = `urn:dkg:file:keccak256:${'c'.repeat(64)}`;
  const SRC_REF = `urn:dkg:file:keccak256:${'d'.repeat(64)}`;

  it('converter-backed import (PDF→markdown): markdown ref + text/markdown hint, NOT application/pdf', () => {
    // The regression: a PDF import has a markdown-form ref but
    // sourceContentType = application/pdf. The hint must describe the chosen
    // (markdown) ref, else the viewer requests markdown bytes as a PDF.
    const { ref, contentType } = resolveDocRef(MD_REF, SRC_REF, 'application/pdf');
    expect(ref).toBe(MD_REF);
    expect(contentType).toBe('text/markdown');
    expect(contentType).not.toBe('application/pdf');
  });

  it('markdown-native import: markdown ref + text/markdown hint', () => {
    const { ref, contentType } = resolveDocRef(MD_REF, undefined, 'text/markdown');
    expect(ref).toBe(MD_REF);
    expect(contentType).toBe('text/markdown');
  });

  it('raw source only (no markdown form): forwards the source content type', () => {
    const { ref, contentType } = resolveDocRef(undefined, SRC_REF, 'image/png');
    expect(ref).toBe(SRC_REF);
    expect(contentType).toBe('image/png');
  });

  it('no linked file: ref undefined (caller falls back to entity uri → empty state)', () => {
    const { ref, contentType } = resolveDocRef(undefined, undefined, 'application/pdf');
    expect(ref).toBeUndefined();
    expect(contentType).toBe('application/pdf');
  });
});
