// Encode/decode the center-pane document tab id.
//
// Shape: `doc:<contextGraphId>|<docRef>|<contentType>`.
//
// The `|` delimiter mirrors the `agent:` tab convention and cannot appear in
// a `urn:dkg:file:keccak256:<hex>` ref, a context-graph id, or a MIME type,
// so decoding on the first/last `|` is unambiguous even when the context
// graph id itself contains `:` or `/`. `docRef` is kept in its full
// `urn:dkg:file:keccak256:<hex>` form on purpose: stripping the `keccak256:`
// algorithm prefix makes the daemon misread the digest as sha256 and return
// 404 — the bug this module's callers fix.
//
// Extracted as pure functions (rather than inlined in the component) so the
// encode/decode contract is unit-testable without mounting React.

export const DOC_TAB_PREFIX = 'doc:';

export function encodeDocTabId(
  contextGraphId: string,
  docRef: string,
  contentType: string,
): string {
  return `${DOC_TAB_PREFIX}${contextGraphId}|${docRef}|${contentType}`;
}

export interface DecodedDocTab {
  /**
   * Full `urn:dkg:file:keccak256:<hex>` ref, or — when the document has no
   * stored source file — the entity uri (which does not start with
   * `urn:dkg:file:`, so the viewer shows its friendly empty state).
   */
  docRef: string;
  /** MIME hint recorded at import time; `''` when unknown or legacy. */
  contentType: string;
}

/**
 * Choose which file ref + content-type hint to encode for a document entity.
 *
 * Prefer the **markdown form** (the human-readable extracted text). Its hint
 * MUST be `text/markdown`: a document entity's `sourceContentType` describes
 * the ORIGINAL upload (e.g. `application/pdf` for a PDF whose markdown
 * intermediate is the markdown-form ref). Forwarding that original MIME
 * alongside the markdown ref would make `DocumentViewer` request markdown
 * bytes under a binary content type and take the wrong (PDF/image) render
 * path. Only when falling back to the raw source file is `sourceContentType`
 * the correct hint.
 */
export function resolveDocRef(
  markdownFormRef: string | undefined,
  sourceFileRef: string | undefined,
  sourceContentType: string,
): { ref: string | undefined; contentType: string } {
  if (markdownFormRef) return { ref: markdownFormRef, contentType: 'text/markdown' };
  if (sourceFileRef) return { ref: sourceFileRef, contentType: sourceContentType };
  return { ref: undefined, contentType: sourceContentType };
}

export function decodeDocTabId(tabId: string): DecodedDocTab {
  const raw = tabId.slice(DOC_TAB_PREFIX.length);
  const firstPipe = raw.indexOf('|');
  const lastPipe = raw.lastIndexOf('|');
  // Legacy / persisted ids had no `|` (the old `doc:<scope>:<hash>` shape):
  // treat the whole payload as docRef so the viewer degrades to its empty
  // state instead of firing a doomed request.
  if (firstPipe < 0) {
    return { docRef: raw, contentType: '' };
  }
  return {
    docRef: raw.slice(firstPipe + 1, lastPipe),
    contentType: raw.slice(lastPipe + 1),
  };
}
