import React, { useState, useEffect } from 'react';
import { fetchExtractionStatus, fileUrl, authHeaders, type ExtractionStatus } from '../../api.js';

interface FilePreviewModalProps {
  open: boolean;
  onClose: () => void;
  assertionName: string;
  contextGraphId: string;
}

const PREVIEWABLE_TYPES: Record<string, 'pdf' | 'image' | 'text' | 'markdown'> = {
  'application/pdf': 'pdf',
  'application/json': 'text',
  'text/plain': 'text',
  'text/csv': 'text',
  'text/markdown': 'markdown',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
};

function previewKind(ct: string): 'pdf' | 'image' | 'text' | 'binary' {
  const mapped = PREVIEWABLE_TYPES[ct];
  if (mapped) return mapped === 'markdown' ? 'text' : mapped;
  return 'binary';
}

async function authenticatedBlobUrl(url: string): Promise<string> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function FilePreviewModal({ open, onClose, assertionName, contextGraphId }: FilePreviewModalProps) {
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    setTextContent(null);
    setBlobUrl(null);

    fetchExtractionStatus(assertionName, contextGraphId)
      .then(async (s) => {
        setStatus(s);
        const kind = previewKind(s.detectedContentType);
        const url = fileUrl(s.fileHash, s.detectedContentType);
        if (kind === 'text') {
          const res = await fetch(url, { headers: authHeaders() });
          if (res.ok) setTextContent(await res.text());
        } else if (kind === 'pdf' || kind === 'image') {
          const blob = await authenticatedBlobUrl(url);
          setBlobUrl(blob);
        }
      })
      .catch((err) => setError(err.message ?? 'Failed to load file info'))
      .finally(() => setLoading(false));

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [open, assertionName, contextGraphId]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  if (!open) return null;

  const kind = status ? previewKind(status.detectedContentType) : null;
  const rawUrl = status ? fileUrl(status.fileHash, status.detectedContentType) : null;

  const handleDownload = async (downloadUrl: string, filename: string) => {
    try {
      const blob = await authenticatedBlobUrl(downloadUrl);
      const a = document.createElement('a');
      a.href = blob;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blob);
    } catch {
      // fallback — the browser may handle auth via cookies
      window.open(downloadUrl, '_blank');
    }
  };

  return (
    <div className="v10-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v10-modal-box v10-file-preview-modal">
        <div className="v10-modal-header">
          <div className="v10-modal-title">{assertionName}</div>
          <button className="v10-modal-close" onClick={onClose}>×</button>
        </div>

        {loading && <div className="v10-file-preview-loading">Loading file preview...</div>}

        {error && (
          <div className="v10-file-preview-error">
            <p>{error}</p>
            <p style={{ fontSize: 11, marginTop: 4 }}>
              File preview requires the extraction status to still be cached on the node.
              If the node was restarted, the preview metadata may be unavailable.
            </p>
          </div>
        )}

        {status && !loading && (
          <>
            <div className="v10-file-preview-meta">
              <span className="v10-file-preview-meta-item">
                {status.detectedContentType}
              </span>
              <span className="v10-file-preview-meta-item">
                {status.tripleCount} triples extracted
              </span>
              <span className="v10-file-preview-meta-item">
                {status.pipelineUsed}
              </span>
              {status.completedAt && (
                <span className="v10-file-preview-meta-item">
                  {new Date(status.completedAt).toLocaleString()}
                </span>
              )}
            </div>

            <div className="v10-file-preview-content">
              {kind === 'pdf' && blobUrl && (
                <iframe
                  src={blobUrl}
                  className="v10-file-preview-iframe"
                  title={`Preview: ${assertionName}`}
                />
              )}

              {kind === 'image' && blobUrl && (
                <img
                  src={blobUrl}
                  alt={assertionName}
                  className="v10-file-preview-image"
                />
              )}

              {kind === 'text' && textContent != null && (
                <pre className="v10-file-preview-text">{textContent}</pre>
              )}

              {kind === 'binary' && (
                <div className="v10-file-preview-binary">
                  <p>This file type cannot be previewed directly.</p>
                  {rawUrl && (
                    <button
                      className="v10-file-preview-download"
                      onClick={() => handleDownload(rawUrl, assertionName)}
                    >
                      Download file
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="v10-file-preview-footer">
              {rawUrl && (
                <button
                  className="v10-file-preview-download"
                  onClick={() => handleDownload(rawUrl, assertionName)}
                >
                  Download original
                </button>
              )}
              {status.mdIntermediateHash && (
                <button
                  className="v10-file-preview-download"
                  onClick={() => handleDownload(
                    fileUrl(status.mdIntermediateHash!, 'text/markdown'),
                    `${assertionName}.md`,
                  )}
                >
                  Download markdown intermediate
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
