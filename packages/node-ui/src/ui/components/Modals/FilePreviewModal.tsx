import React, { useState, useEffect } from 'react';
import { fetchExtractionStatus, fileUrl, type ExtractionStatus } from '../../api.js';

interface FilePreviewModalProps {
  open: boolean;
  onClose: () => void;
  assertionName: string;
  contextGraphId: string;
}

const PREVIEWABLE_TYPES: Record<string, 'pdf' | 'image' | 'text' | 'markdown'> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'image',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/csv': 'text',
  'text/html': 'text',
  'application/json': 'text',
};

function previewKind(ct: string): 'pdf' | 'image' | 'text' | 'binary' {
  if (PREVIEWABLE_TYPES[ct]) return PREVIEWABLE_TYPES[ct] === 'markdown' ? 'text' : PREVIEWABLE_TYPES[ct];
  if (ct.startsWith('text/')) return 'text';
  if (ct.startsWith('image/')) return 'image';
  return 'binary';
}

export function FilePreviewModal({ open, onClose, assertionName, contextGraphId }: FilePreviewModalProps) {
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    setTextContent(null);

    fetchExtractionStatus(assertionName, contextGraphId)
      .then(async (s) => {
        setStatus(s);
        const kind = previewKind(s.detectedContentType);
        if (kind === 'text') {
          const url = fileUrl(s.fileHash, s.detectedContentType);
          const res = await fetch(url);
          if (res.ok) setTextContent(await res.text());
        }
      })
      .catch((err) => setError(err.message ?? 'Failed to load file info'))
      .finally(() => setLoading(false));
  }, [open, assertionName, contextGraphId]);

  if (!open) return null;

  const kind = status ? previewKind(status.detectedContentType) : null;
  const url = status ? fileUrl(status.fileHash, status.detectedContentType) : null;

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
              {kind === 'pdf' && url && (
                <iframe
                  src={url}
                  className="v10-file-preview-iframe"
                  title={`Preview: ${assertionName}`}
                />
              )}

              {kind === 'image' && url && (
                <img
                  src={url}
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
                  {url && (
                    <a href={url} download={assertionName} className="v10-file-preview-download">
                      Download file
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="v10-file-preview-footer">
              {url && (
                <a href={url} download={assertionName} className="v10-file-preview-download">
                  Download original
                </a>
              )}
              {status.mdIntermediateHash && (
                <a
                  href={fileUrl(status.mdIntermediateHash, 'text/markdown')}
                  download={`${assertionName}.md`}
                  className="v10-file-preview-download"
                >
                  Download markdown intermediate
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
