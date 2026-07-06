// File-serving read route.
//
//   GET /api/file/:hash — serve a stored file by its content hash.
//
// Extracted verbatim out of the retired routes/assertion.ts during the
// assertion→knowledge-assets migration — the same preservation move that
// pulled /api/kc into kc-chain-metadata.ts. This is NOT part of the
// WM/SWM/VM lifecycle surface: the node-ui FilePreviewModal + document
// preview fetch raw bytes through `fileUrl()` → GET /api/file/:hash, so
// the endpoint must survive the route migration or every file preview /
// download 404s.
//
// The SAFE_PREVIEW_TYPES allowlist + nosniff/attachment hardening are
// preserved unchanged: untrusted, user-uploaded bytes are only served
// inline for a curated MIME allowlist (never text/html or image/svg+xml,
// the stored-XSS vectors); everything else is forced to download as
// opaque application/octet-stream.
import type { RouteRequestContext } from './context.js';
import { jsonResponse, safeDecodeURIComponent } from '../http-utils.js';
import { normalizeDetectedContentType } from '../manifest.js';

export async function handleFileServingRoutes(ctx: RouteRequestContext): Promise<void> {
  const { req, res, path, url, fileStore } = ctx;

  // GET /api/file/:hash — serve a stored file by its content hash.
  // Accepts sha256:<hex>, keccak256:<hex>, or bare <hex> (treated as sha256).
  if (req.method === 'GET' && path.startsWith('/api/file/')) {
    const fileHash = safeDecodeURIComponent(path.slice('/api/file/'.length), res);
    if (fileHash === null) return;
    if (!fileHash) {
      return jsonResponse(res, 400, { error: 'Missing file hash' });
    }
    const bytes = await fileStore.get(fileHash);
    if (!bytes) {
      return jsonResponse(res, 404, { error: `File not found: ${fileHash}` });
    }
    const SAFE_PREVIEW_TYPES = new Set([
      'application/pdf',
      'application/json',
      'text/plain',
      'text/csv',
      'text/markdown',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);
    const rawCt = normalizeDetectedContentType(
      url.searchParams.get('contentType') ?? undefined,
    );
    const contentType = SAFE_PREVIEW_TYPES.has(rawCt)
      ? rawCt
      : 'application/octet-stream';
    const disposition = SAFE_PREVIEW_TYPES.has(rawCt) ? 'inline' : 'attachment';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(bytes);
    return;
  }
}
