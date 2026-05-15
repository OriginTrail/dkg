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
